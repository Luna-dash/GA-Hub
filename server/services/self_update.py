"""Portable green-folder update storage and Rust updater launcher (DATA_EPOCH = 2).

Supports both GitHub Release archives and explicitly trusted local ZIP archives
in the --onedir layout:
- ga-hub-desktop.exe
- ga-hub-update.exe (~500 KB pure-Rust switcher)
- sidecar/ga-hub-sidecar.exe + sidecar/_internal/...
- build-info.json / update-manifest.json / README.txt

No Windows Scheduled Tasks, no 60-second countdown, and no multi-step approval
ceremony: once verified, a single `apply()` spawns detached `ga-hub-update.exe`
which waits for the desktop to close, switches `current.json`, verifies startup
health, and rolls back automatically on failure.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Any

from ..process_utils import hidden_process_kwargs
from .update_lock import FileMutex

EXECUTABLES = ("ga-hub-desktop.exe", "sidecar/ga-hub-sidecar.exe")
HELPER = "ga-hub-update.exe"
ALLOWED_TOP_LEVEL = {
    "ga-hub-desktop.exe",
    HELPER,
    "build-info.json",
    "README.txt",
    "update-manifest.json",
}
MAX_ARCHIVE_BYTES = 2 * 1024**3
DATA_EPOCH = 2  # v2: --onedir sidecar + pure-Rust green updater.
STATES = {"prepared", "switching", "verifying", "succeeded", "rolled_back", "failed", "cancelled"}


def is_unresolved_update(plan: dict[str, Any]) -> bool:
    """True only when a switch may be in progress or ended in an uncertain state."""
    state = plan.get("state")
    if state in {"switching", "verifying"}:
        return True
    return state == "failed" and plan.get("switch_started") is not False


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _is_safe_archive_member(name: str) -> bool:
    if not name or "\\" in name or name.startswith("/") or name.endswith("/"):
        return False
    parts = name.split("/")
    if any(part in ("", ".", "..") or ":" in part for part in parts):
        return False
    if len(parts) == 1:
        return name in ALLOWED_TOP_LEVEL
    return parts[0] == "sidecar"


_LOCKS: dict[str, FileMutex] = {}
_LOCKS_GUARD = threading.Lock()


class UpdateStore:
    def __init__(self, root: Path):
        self.root = root.resolve()
        with _LOCKS_GUARD:
            self.lock = _LOCKS.setdefault(str(self.root).casefold(), FileMutex(self.root / "state.lock"))
        self.state_file = self.root / "state.json"

    def read(self) -> dict[str, Any]:
        with self.lock:
            if not self.state_file.exists():
                return {"state": "idle"}
            value = json.loads(self.state_file.read_text(encoding="utf-8"))
            if not isinstance(value, dict) or value.get("state") not in STATES:
                raise ValueError("Invalid persisted update state")
            return value

    def transition(self, plan_id: str, expected: set[str], state: str, **fields: Any) -> dict[str, Any]:
        with self.lock:
            value = self.read()
            if value.get("id") != plan_id or value["state"] not in expected or state not in STATES:
                raise ValueError("Update plan changed or transition is not allowed")
            value.update(fields, state=state)
            atomic_json(self.state_file, value)
            return value

    def candidate(self, plan: dict[str, Any]) -> Path:
        plan_id = plan.get("id", "")
        if not re.fullmatch(r"[a-f0-9]{32}", plan_id):
            raise ValueError("Invalid update identity")
        return self.root / "versions" / plan_id

    def verify(self, plan: dict[str, Any]) -> Path:
        directory = self.candidate(plan)
        if plan.get("data_epoch") != DATA_EPOCH:
            raise ValueError("Update requires an unsupported data migration")
        hashes = plan.get("sha256", {})
        if not isinstance(hashes, dict) or not set(EXECUTABLES) <= set(hashes):
            raise ValueError("Candidate integrity metadata is incomplete")
        for rel, expected in hashes.items():
            if not _is_safe_archive_member(rel):
                raise ValueError(f"Candidate integrity check failed: {rel}")
            path = directory / rel
            if path.is_symlink() or not path.is_file() or digest(path) != expected:
                raise ValueError(f"Candidate integrity check failed: {rel}")
        return directory

    def prepare(self, archive: Path, expected_sha256: str = "", *, trusted: bool) -> dict[str, Any]:
        """Verify and extract a trusted --onedir release ZIP into versions/<id>/."""
        with self.lock:
            current = self.read()
            if current["state"] == "prepared" or is_unresolved_update(current):
                raise ValueError("An update is already prepared, being applied, or requires manual recovery")
            if not trusted:
                raise ValueError("Explicit confirmation of the release source is required")
            if expected_sha256 and not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
                raise ValueError("SHA-256 must be 64 hexadecimal characters when supplied")
            archive = archive.resolve(strict=True)
            if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive is missing or exceeds the size limit")
            with archive.open("rb") as stream:
                h = hashlib.file_digest(stream, "sha256").hexdigest()
                if expected_sha256 and h != expected_sha256.lower():
                    raise ValueError("Archive SHA-256 does not match")
                stream.seek(0)
                with zipfile.ZipFile(stream) as package:
                    entries = [e for e in package.infolist() if not e.is_dir()]
                    names = [entry.filename for entry in entries]
                    if len(names) != len(set(names)) or not all(_is_safe_archive_member(n) for n in names):
                        raise ValueError("Archive contains duplicate or unexpected paths")
                    if not {*EXECUTABLES, "build-info.json", "update-manifest.json"} <= set(names):
                        raise ValueError("Archive lacks a paired update manifest")
                    if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
                        raise ValueError("Expanded archive exceeds the size limit")
                    for entry in entries:
                        if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError("Archive symlinks are not allowed")
                        if entry.filename in ("build-info.json", "update-manifest.json") and entry.file_size > 2 * 1024 * 1024:
                            raise ValueError("Manifest is too large")
                    manifest = json.loads(package.read("update-manifest.json"))
                    info = json.loads(package.read("build-info.json"))
                    if not isinstance(manifest, dict) or not isinstance(info, dict):
                        raise ValueError("Invalid manifest object")
                    if manifest.get("schema") != 2 or manifest.get("data_epoch") != DATA_EPOCH:
                        raise ValueError("Unsupported update protocol or data compatibility")
                    if manifest.get("platform") != "windows-x64":
                        raise ValueError("Unsupported update platform")
                    if not isinstance(info.get("version"), str) or not info["version"]:
                        raise ValueError("Missing build version")

                    expected_hashed = {
                        n for n in names
                        if n not in ("build-info.json", "update-manifest.json", "README.txt")
                    }
                    hashes = info.get("sha256", {})
                    if (
                        not isinstance(hashes, dict)
                        or set(hashes) != expected_hashed
                        or any(
                            not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
                            for value in hashes.values()
                        )
                    ):
                        raise ValueError("Build metadata does not match the archive contents")

                    plan = {
                        "id": uuid.uuid4().hex,
                        "state": "prepared",
                        "version": info["version"],
                        "commit": info.get("commit"),
                        "archive_sha256": h,
                        "data_epoch": DATA_EPOCH,
                        "sha256": hashes,
                    }
                    directory = self.candidate(plan)
                    directory.mkdir(parents=True, exist_ok=False)
                    try:
                        for entry in entries:
                            target = directory / entry.filename
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with package.open(entry) as source, target.open("xb") as dst:
                                shutil.copyfileobj(source, dst, 1024 * 1024)
                        self.verify(plan)
                        atomic_json(self.state_file, plan)
                    except BaseException:
                        shutil.rmtree(directory, ignore_errors=True)
                        raise
            return plan

    def cancel(self, plan_id: str) -> dict[str, Any]:
        with self.lock:
            current = self.read()
            allowed = {"prepared"}
            if current.get("state") == "failed" and current.get("switch_started") is False:
                allowed = {"prepared", "failed"}
            result = self.transition(plan_id, allowed, "cancelled")
            candidate_dir = self.root / "versions" / plan_id
            shutil.rmtree(candidate_dir, ignore_errors=True)
            return result

    def apply(
        self,
        plan_id: str,
        admin_data: Path,
        *,
        old_pid: int,
        old_exe: Path,
        spawn=subprocess.Popen,
    ) -> dict[str, Any]:
        """Launch detached Rust `ga-hub-update.exe` to perform atomic switch & health check."""
        with self.lock:
            plan = self.read()
            if plan.get("id") != plan_id or plan.get("state") != "prepared":
                raise ValueError("Update is not prepared")
            candidate_dir = self.verify(plan)
            helper = old_exe.resolve().with_name(HELPER)
            if not helper.is_file():
                candidate_helper = candidate_dir / HELPER
                if candidate_helper.is_file():
                    helper = candidate_helper
                else:
                    raise ValueError("Bundled ga-hub-update.exe is missing")
            cmd = [
                str(helper),
                "--admin-data", str(admin_data.resolve()),
                "switch",
                "--plan", plan_id,
                "--wait-pid", str(old_pid),
                "--old-exe", str(old_exe.resolve()),
            ]
            kwargs: dict[str, Any] = {
                "stdin": subprocess.DEVNULL,
                "stdout": subprocess.DEVNULL,
                "stderr": subprocess.DEVNULL,
                "close_fds": True,
            }
            # Persist `switching` BEFORE spawning the detached Rust helper so it
            # never races against `self.transition()` or gets overwritten by us.
            switching = self.transition(plan_id, {"prepared"}, "switching", switch_started=False)
            try:
                if os.name == "nt":
                    breakaway = getattr(subprocess, "CREATE_BREAKAWAY_FROM_JOB", 0x01000000)
                    try:
                        spawn(cmd, **kwargs, **hidden_process_kwargs(existing_creationflags=breakaway))
                    except PermissionError as exc:
                        # Never fall back to spawning inside the sidecar's KillOnCloseJob:
                        # desktop shutdown would immediately terminate ga-hub-update.exe
                        # mid-switch and leave state.json stuck in `switching`.
                        raise PermissionError(
                            "无法脱离桌面进程作业启动更新助手（CREATE_BREAKAWAY_FROM_JOB 被拒绝）。"
                            "请直接双击桌面程序重启，或手动解压新版 ZIP 覆盖安装。"
                        ) from exc
                else:
                    spawn(cmd, **kwargs)
            except BaseException:
                # Roll state back to `prepared` if spawning the helper failed so
                # startup is never locked out by an unstarted switch.
                try:
                    restored = dict(plan)
                    restored["state"] = "prepared"
                    restored.pop("switch_started", None)
                    atomic_json(self.state_file, restored)
                except OSError:
                    pass
                raise
            return switching
