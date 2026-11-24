"""Pre-shutdown frozen-sidecar smoke test. Not full desktop/core acceptance.

Only trusted, already prepared local releases may be executed. All runtime data
is disposable; no production config/credentials are copied or read.
"""
from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import secrets
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

import psutil

from .self_update import EXECUTABLES, UpdateStore, atomic_json

SCOPE = "frozen-sidecar-setup-http-v1"


def verify_admission(store: UpdateStore, plan: dict) -> dict:
    store.verify(plan)
    try:
        receipt = json.loads((store.root / "admission" / f"{plan['id']}.json").read_text(encoding="utf8"))
        if (receipt.get("id") != plan["id"] or receipt.get("sha256") != plan["sha256"]
                or receipt.get("scope") != SCOPE or receipt.get("passed") is not True):
            raise ValueError("Admission receipt does not match candidate")
        return receipt
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Candidate requires successful isolated preflight before handoff") from exc


def preflight(store: UpdateStore, plan_id: str, *, timeout: float = 90) -> dict:
    # Serialize against prepare/cancel/arm; the HTTP implementation runs in a
    # worker thread, not on the event loop. No close/scheduler APIs are used.
    with store.lock:
        plan = store.read()
        if plan.get("id") != plan_id or plan.get("state") != "prepared":
            raise ValueError("Preflight requires the prepared candidate")
        directory = store.verify(plan)
        receipt_path = store.root / "admission" / f"{plan_id}.json"
        receipt_path.unlink(missing_ok=True)
        run_dir = store.root / "preflight" / plan_id / secrets.token_hex(8)
        admin = run_dir / "admin"
        admin.mkdir(parents=True)
        env = os.environ.copy()
        for name in tuple(env):
            if name.startswith(("GA_HUB_UPDATE_", "GA_DESKTOP_", "GA_HUB_CORE_")) or name in {
                "GA_ROOT", "GA_ADMIN_DATA", "PYTHONHOME", "PYTHONPATH", "_MEIPASS2",
                "_PYI_APPLICATION_HOME_DIR", "_PYI_ARCHIVE_FILE", "_PYI_PARENT_PROCESS_LEVEL",
            }:
                env.pop(name, None)
        env.update(GA_ADMIN_DATA=str(admin), GA_HUB_UPDATE_PREFLIGHT="1",
                   PYINSTALLER_RESET_ENVIRONMENT="1")
        executable = directory / EXECUTABLES[1]
        check = subprocess.run([str(executable), "--selftest"], cwd=run_dir, env=env,
                               capture_output=True, timeout=timeout)
        (run_dir / "selftest.stdout").write_bytes(check.stdout)
        (run_dir / "selftest.stderr").write_bytes(check.stderr)
        if check.returncode != 0:
            raise ValueError(f"Frozen sidecar selftest failed ({check.returncode}); see {run_dir}")
        token = secrets.token_hex(32)
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()

        def matches_identity(message: dict) -> bool:
            if "instance_proof" in message:
                return message["instance_proof"] == digest
            # Previous candidate builds echoed the disposable preflight token.
            return message.get("instance_token") == token

        proc = subprocess.Popen([str(executable), "--port", "0", "--owned-stdin",
                                 "--admin-data", str(admin), "--instance-token", token],
                                cwd=run_dir, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        lines: queue.Queue = queue.Queue()
        def read_lines():
            for line in proc.stdout:
                lines.put(line)
        thread = threading.Thread(target=read_lines, daemon=True)
        thread.start()
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def get(port, path):
            with opener.open(f"http://127.0.0.1:{port}{path}", timeout=3) as response:
                if response.status != 200:
                    raise ValueError(f"Unexpected HTTP status for {path}")
                return response.read()
        deadline = time.monotonic() + timeout
        proof = None
        stopped = False
        try:
            while time.monotonic() < deadline:
                if proc.poll() is not None:
                    raise ValueError("Candidate sidecar exited before readiness")
                try:
                    raw = lines.get(timeout=.2)
                except queue.Empty:
                    continue
                with (run_dir / "sidecar.stdout").open("ab") as output:
                    output.write(raw.replace(token.encode("ascii"), b"[redacted]"))
                try:
                    event = json.loads(raw)
                except (ValueError, UnicodeError):
                    continue
                if event.get("event") == "starting":
                    proof = event
                    break
            if not proof or not matches_identity(proof):
                raise ValueError("Candidate has no matching starting receipt")
            pid, port = int(proof["pid"]), int(proof["port"])
            children = psutil.Process(proc.pid).children(recursive=True)
            if pid not in [proc.pid, *(p.pid for p in children)]:
                raise ValueError("Candidate receipt PID is not owned by preflight")
            if Path(psutil.Process(pid).exe()).resolve() != executable.resolve():
                raise ValueError("Candidate receipt executable mismatch")
            last_error = "HTTP not ready"
            while time.monotonic() < deadline:
                try:
                    ready = json.loads(get(port, "/api/desktop/ready"))
                    status = json.loads(get(port, "/api/status"))
                    updates = json.loads(get(port, "/api/updates"))
                    page = get(port, "/").decode("utf8")
                    if ready.get("pid") != pid or not matches_identity(ready):
                        raise ValueError("HTTP instance identity mismatch")
                    if status.get("mode") != "setup" or updates.get("plan", {}).get("state") != "idle":
                        raise ValueError("Candidate did not honor disposable setup isolation")
                    assets = re.findall(r'(?:src|href)=[\"\'](/assets/[^\"\']+)[\"\']', page)
                    if "<html" not in page.lower() or not assets:
                        raise ValueError("Candidate has no packaged WebUI/assets")
                    for asset in assets:
                        if not get(port, asset) or asset.endswith(".js") and get(port, asset).lstrip().startswith(b"<"):
                            raise ValueError("Invalid packaged asset")
                    break
                except (OSError, ValueError) as exc:
                    last_error = str(exc)
                    time.sleep(.2)
            else:
                raise ValueError(f"Isolated HTTP smoke failed: {last_error}")
        finally:
            proc.stdin.close()  # Owned EOF: graceful shutdown, then existing watchdog.
            try:
                proc.wait(timeout=25)
                stopped = proc.returncode == 0
            except subprocess.TimeoutExpired:
                # Only our pinned process, never the running Hub.
                proc.terminate()
                proc.wait(timeout=10)
            thread.join(timeout=2)
            proc.stdout.close()
        if not stopped:
            raise ValueError("Preflight sidecar did not exit gracefully; admission refused")
        store.verify(plan)
        if store.read().get("state") != "prepared":
            raise ValueError("Candidate changed during preflight")
        receipt = {"id": plan_id, "sha256": plan["sha256"], "scope": SCOPE,
                   "passed": True, "finished_at": time.time(), "evidence": str(run_dir),
                   "limitations": ["no full desktop/single-instance test", "no GA core runtime test"]}
        atomic_json(receipt_path, receipt)
        return receipt
