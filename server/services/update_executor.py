"""Update handoff state machine, independent of the desktop event loop.

The platform adapter must pin process identity, prove worker independence, and
validate an instance-specific health receipt. No manifest-provided commands run.
This module never kills a process or mutates the old version directory.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .self_update import DATA_EPOCH, EXECUTABLES, UpdateStore, atomic_json, digest
from .update_preflight import verify_admission


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    created: str
    executable: Path


class UpdateHost(Protocol):
    def independent(self) -> bool:
        """True only after proving survival outside the desktop's owned Job."""
        ...

    def validate_old(self, identity: ProcessIdentity) -> None: ...
    def wait_old_exit(self, identity: ProcessIdentity, timeout: float) -> bool: ...
    def start(self, executable: Path, plan_id: str) -> ProcessIdentity: ...
    def healthy(self, identity: ProcessIdentity, plan: dict, timeout: float) -> bool: ...
    def stop_candidate(self, identity: ProcessIdentity, timeout: float) -> bool: ...
    def restore(self, executable: Path, plan_id: str) -> ProcessIdentity: ...


class UpdateExecutor:
    """Single-owner executor; an armed plan must never be claimed a second time.

    A launcher supplies exclusive lifetime ownership before constructing this
    object. The UpdateStore thread lock alone is NOT an interprocess lease.
    """

    def __init__(self, store: UpdateStore, host: UpdateHost) -> None:
        self.store = store
        self.host = host

    def arm(self, plan_id: str, old: ProcessIdentity) -> dict:
        with self.store.lock:
            plan = self.store.read()
            if plan.get("id") != plan_id or plan.get("state") != "prepared":
                raise ValueError("Update is not prepared")
            if not self.host.independent():
                raise ValueError("Update worker is not independent of the desktop Job")
            self.host.validate_old(old)
            # Hash both old files now. Rollback later revalidates the pair.
            old_path = old.executable.resolve(strict=True)
            if old_path.name != EXECUTABLES[0]:
                raise ValueError("Unexpected old desktop filename")
            old_hashes = {name: digest(old_path.parent / name) for name in EXECUTABLES}
            verify_admission(self.store, plan)
            candidate = self.store.verify(plan)
            if candidate == old_path.parent:
                raise ValueError("Candidate must not overwrite the running version")
            return self.store.transition(
                plan_id,
                {"prepared"},
                "armed",
                switch_started=False,
                error=None,
                old={
                    "pid": old.pid, "created": old.created, "executable": str(old_path),
                    "sha256": old_hashes,
                },
            )

    def run(self, plan_id: str, *, exit_timeout: float = 120, health_timeout: float = 90) -> dict:
        plan = self.store.read()
        if plan.get("id") != plan_id or plan.get("state") != "armed":
            raise ValueError("Executor requires its armed plan")
        if not self.host.independent():
            raise ValueError("Update worker independence was lost")
        candidate_identity: ProcessIdentity | None = None
        old_data = plan["old"]
        old = ProcessIdentity(old_data["pid"], old_data["created"], Path(old_data["executable"]))
        # The worker never closes the desktop: shell-owned draining and exit
        # must happen after the armed receipt, or this simply times out.
        if not self.host.wait_old_exit(old, exit_timeout):
            return self.store.transition(plan_id, {"armed"}, "failed",
                                         switch_started=False,
                                         error="Old desktop did not exit; no candidate started")
        self.store.transition(plan_id, {"armed"}, "switching", switch_started=True)
        start_attempted = False
        pointer_published = False
        pointer_path = self.store.root / "current.json"
        previous_pointer = None
        try:
            import json
            if pointer_path.exists():
                previous_pointer = json.loads(pointer_path.read_text(encoding="utf8"))
            directory = self.store.verify(plan)
            start_attempted = True
            candidate_identity = self.host.start(directory / EXECUTABLES[0], plan_id)
            self.store.transition(plan_id, {"switching"}, "verifying", candidate_process={
                "pid": candidate_identity.pid, "created": candidate_identity.created,
                "executable": str(candidate_identity.executable),
            })
            if not self.host.healthy(candidate_identity, plan, health_timeout):
                raise ValueError("Candidate did not produce an instance-specific healthy receipt")
            # Recheck pair after health, before publishing the next-launch pointer.
            self.store.verify(plan)
            atomic_json(self.store.root / "completed" / f"{plan_id}.json",
                        {**self.store.read(), "state": "succeeded"})
            atomic_json(pointer_path, {
                "id": plan_id, "executable": str(directory / EXECUTABLES[0]),
                "sha256": plan["sha256"], "data_epoch": DATA_EPOCH,
            })
            pointer_published = True
            return self.store.transition(plan_id, {"verifying"}, "succeeded")
        except Exception as exc:
            # start() can spawn successfully then fail before returning identity.
            if start_attempted and candidate_identity is None:
                return self.store.transition(plan_id, {"switching", "verifying"}, "failed",
                                             error=f"{exc}; candidate launch uncertain; manual recovery required")
            # Never start a second version while a candidate may still be alive.
            # A platform error while stopping is equally unsafe for rollback.
            if candidate_identity is not None:
                try:
                    stopped = self.host.stop_candidate(candidate_identity, 30)
                except Exception:
                    stopped = False
                if not stopped:
                    return self.store.transition(plan_id, {"switching", "verifying"}, "failed",
                                                 error=f"{exc}; candidate may be alive; manual recovery required")
            try:
                if pointer_published:
                    if previous_pointer is None:
                        pointer_path.unlink(missing_ok=True)
                    else:
                        atomic_json(pointer_path, previous_pointer)
                if plan.get("data_epoch") != DATA_EPOCH:
                    raise ValueError("Data epoch is incompatible with binary rollback")
                for name in EXECUTABLES:
                    if digest(old.executable.parent / name) != old_data["sha256"][name]:
                        raise ValueError("Old executable pair changed; refusing rollback")
                restored = self.host.restore(old.executable, plan_id)
                if not self.host.healthy(restored, plan, health_timeout):
                    raise ValueError("Restored desktop did not produce a healthy receipt")
            except Exception as rollback_error:
                return self.store.transition(plan_id, {"switching", "verifying"}, "failed",
                                             error=f"{exc}; rollback failed: {rollback_error}")
            return self.store.transition(plan_id, {"switching", "verifying"}, "rolled_back",
                                         error=str(exc))
