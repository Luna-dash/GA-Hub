"""External bootstrap/update helper: python -m server.update_helper --help.

Run apply from Explorer/an independent terminal, NOT a Hub-owned tool process.
The old desktop is never forcibly closed. No arbitrary commands are accepted.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
from pathlib import Path

import psutil

from .services.self_update import DATA_EPOCH, EXECUTABLES, UpdateStore, atomic_json, digest
from .services.update_executor import UpdateExecutor
from .services.update_lock import FileMutex
from .services.update_native import NativeHost, desktop_environment, identity, outside_job


def ensure_no_desktop(store: UpdateStore, plan: dict) -> None:
    """Fail closed on access errors or a live old/candidate executable."""
    targets = {str((store.candidate(plan) / name).resolve()).casefold() for name in EXECUTABLES}
    if plan.get("old"):
        parent = Path(plan["old"]["executable"]).parent
        targets.update(str((parent / name).resolve()).casefold() for name in EXECUTABLES)
    for process in psutil.process_iter():
        try:
            exe = process.exe()
            if exe and str(Path(exe).resolve()).casefold() in targets:
                raise ValueError(f"Desktop/backend still running: PID {process.pid}; exit it normally first")
        except psutil.NoSuchProcess:
            continue
        except psutil.AccessDenied:
            # System processes are normally inaccessible. Only an inaccessible
            # process with a matching executable NAME can be a relevant owner.
            try:
                if process.name().casefold() in {n.casefold() for n in EXECUTABLES}:
                    raise ValueError(f"Cannot verify desktop identity: PID {process.pid}")
            except psutil.NoSuchProcess:
                pass


def launch_current(store: UpdateStore, admin_data: Path) -> int:
    pointer = json.loads((store.root / "current.json").read_text(encoding="utf8"))
    plan = {**pointer, "state": "succeeded", "data_epoch": pointer.get("data_epoch")}
    candidate = store.verify(plan)
    if Path(pointer["executable"]).resolve() != candidate / EXECUTABLES[0]:
        raise ValueError("Invalid current executable pointer")
    active = store.read()
    if active.get("state") in {"armed", "switching", "verifying", "failed"}:
        raise ValueError("Unresolved update; inspect/recover before launch")
    completed = json.loads((store.root / "completed" / f"{pointer['id']}.json").read_text(encoding="utf8"))
    if (completed.get("state") != "succeeded" or completed.get("id") != pointer["id"]
            or completed.get("sha256") != pointer.get("sha256")
            or completed.get("data_epoch") != pointer.get("data_epoch")):
        raise ValueError("Current pointer has no completed health-verified handoff")
    if (store.root / "maintenance.json").exists():
        raise ValueError("Update maintenance is active")
    # Repeated shortcut clicks must not spawn a second desktop.
    for process in psutil.process_iter(["name"]):
        if (process.info["name"] or "").casefold() != EXECUTABLES[0].casefold():
            continue
        try:
            if Path(process.exe()).resolve() == candidate / EXECUTABLES[0]:
                return process.pid
        except psutil.NoSuchProcess:
            continue
    ensure_no_desktop(store, active)
    ensure_no_desktop(store, completed)
    env = desktop_environment(admin_data)
    child = subprocess.Popen([str(candidate / EXECUTABLES[0])], cwd=candidate, env=env,
                             stdin=subprocess.DEVNULL, close_fds=True)
    return child.pid


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-data", required=True, type=Path,
                        help="Existing Hub admin-data directory, not GA_ROOT")
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--archive", type=Path, required=True)
    prepare.add_argument("--sha256", required=True)
    prepare.add_argument("--trust-local-release", action="store_true")
    apply = commands.add_parser("apply")
    apply.add_argument("--plan", required=True)
    apply.add_argument("--old-pid", required=True, type=int)
    apply.add_argument("--old-executable", required=True, type=Path)
    apply.add_argument("--old-exit-timeout", type=float, default=600)
    worker = commands.add_parser("worker", help="Fixed scheduled worker; reads the latest handoff request")
    request = commands.add_parser("request", help="Wake independent worker without closing the desktop")
    request.add_argument("--id", required=True)
    request.add_argument("--old-pid", type=int, required=True)
    approve = commands.add_parser("approve", help="Explicitly approve the fixed 60-second countdown")
    approve.add_argument("--id", required=True)
    commands.add_parser("status")
    commands.add_parser("launch")
    recover = commands.add_parser("recover")
    recover.add_argument("--plan", required=True)
    recover.add_argument("--confirm-all-exited", action="store_true")
    args = parser.parse_args(argv)
    admin = args.admin_data.resolve()
    if not admin.is_dir():
        parser.error("Admin-data directory must already exist")
    store = UpdateStore(admin / "updates")
    try:
        if args.command in {"request", "approve", "worker"}:
            from .services import update_handoff
            if args.command == "request":
                result = update_handoff.request(store, admin, args.id, args.old_pid)
            elif args.command == "approve":
                result = update_handoff.approve(store, args.id)
            else:
                result = update_handoff.worker(store, admin)
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if result.get("state") not in {"failed", "rolled_back"} else 2
        if args.command == "status":
            handoff = store.root / "handoff.json"
            print(json.dumps({"plan": store.read(),
                              "handoff": json.loads(handoff.read_text(encoding="utf8")) if handoff.exists() else None},
                             indent=2, ensure_ascii=False))
            return 0
        # Lock every mutating/launch operation. The executor holds this for its
        # entire lifetime; a second updater cannot recover a live owner.
        with FileMutex(store.root / "executor.lock", timeout=0):
            if args.command == "prepare":
                result = store.prepare(args.archive.resolve(), args.sha256,
                                       trusted=args.trust_local_release)
            elif args.command == "apply":
                if not outside_job():
                    raise ValueError("Helper belongs to a Windows Job. Start it outside Hub, from Explorer.")
                old = identity(args.old_pid)
                if (old.executable != args.old_executable.resolve()
                        or old.executable.name != EXECUTABLES[0]):
                    raise ValueError("Old PID/executable do not match the desktop")
                if not 0 < args.old_exit_timeout <= 86400:
                    raise ValueError("Exit timeout must be between 0 and 86400 seconds")
                host = NativeHost(store.root, admin)
                worker = UpdateExecutor(store, host)
                result = worker.arm(args.plan, old)
                atomic_json(store.root / "worker-ready.json", {
                    "plan_id": args.plan, "worker_pid": os.getpid(), "old_pid": old.pid,
                    "state": "waiting_for_normal_exit",
                })
                print("ARMED: helper is independent. Finish all tasks, then exit the old desktop normally.", flush=True)
                result = worker.run(args.plan, exit_timeout=args.old_exit_timeout)
            elif args.command == "recover":
                plan = store.read()
                if not args.confirm_all_exited or not plan or plan["id"] != args.plan:
                    raise ValueError("Recovery requires exact plan and explicit all-exited confirmation")
                if plan["state"] not in {"armed", "switching", "verifying", "failed"}:
                    raise ValueError("Plan does not require recovery")
                ensure_no_desktop(store, plan)
                result = store.transition(args.plan, {plan["state"]}, "cancelled",
                                          recovery="All known desktops exited; no auto-resume or data rollback")
            else:
                if not outside_job():
                    raise ValueError("Launch helper must run outside a Windows Job")
                result = {"pid": launch_current(store, admin)}
            print(json.dumps(result, indent=2, ensure_ascii=False))
            return 0 if result.get("state") not in {"failed", "rolled_back"} else 2
    except (OSError, ValueError, KeyError, psutil.Error) as exc:
        print(f"Update refused: {exc}", flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
