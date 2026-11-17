"""Portable update storage. Only explicitly trusted local release archives are accepted.

No URLs, shell commands or executable names are supplied by a release manifest.
The desktop shell owns the restart; HTTP endpoints only prepare/cancel a plan.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Any

from .update_lock import FileMutex

EXECUTABLES = ("ga-hub-desktop.exe", "ga-hub-sidecar.exe")
HELPER = "ga-hub-update.exe"
ALLOWED_MEMBERS = {HELPER, *EXECUTABLES, "build-info.json", "README.txt", "update-manifest.json"}
MAX_ARCHIVE_BYTES = 2 * 1024**3
DATA_EPOCH = 1  # Changes require an explicit migration/backup strategy, not a blind rollback.
STATES = {"prepared", "armed", "switching", "verifying", "succeeded", "rolled_back", "failed", "cancelled"}


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
        for name in (*EXECUTABLES, *((HELPER,) if HELPER in hashes else ())):
            path = directory / name
            if path.is_symlink() or not path.is_file() or digest(path) != hashes.get(name):
                raise ValueError(f"Candidate integrity check failed: {name}")
        return directory

    def prepare(self, archive: Path, expected_sha256: str = "", *, trusted: bool) -> dict[str, Any]:
        """Require a trusted archive; optionally compare a separately sourced checksum."""
        with self.lock:
            if self.read()["state"] in {"prepared", "armed", "switching", "verifying", "failed"}:
                raise ValueError("An update is already prepared, being applied, or requires manual recovery")
            if not trusted:
                raise ValueError("Explicit confirmation of the release source is required")
            if expected_sha256 and not re.fullmatch(r"[a-fA-F0-9]{64}", expected_sha256):
                raise ValueError("SHA-256 must be 64 hexadecimal characters when supplied")
            archive = archive.resolve(strict=True)
            if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
                raise ValueError("Archive is missing or exceeds the size limit")
            # Hash and parse the same open file, not a path that can be swapped.
            with archive.open("rb") as stream:
                h = hashlib.file_digest(stream, "sha256").hexdigest()
                if expected_sha256 and h != expected_sha256.lower():
                    raise ValueError("Archive SHA-256 does not match")
                stream.seek(0)
                with zipfile.ZipFile(stream) as package:
                    entries = package.infolist()
                    names = [entry.filename for entry in entries]
                    if len(names) != len(set(names)) or not set(names) <= ALLOWED_MEMBERS:
                        raise ValueError("Archive contains duplicate or unexpected paths")
                    if not {*EXECUTABLES, "build-info.json", "update-manifest.json"} <= set(names):
                        raise ValueError("Archive lacks a paired update manifest")
                    if sum(entry.file_size for entry in entries) > MAX_ARCHIVE_BYTES:
                        raise ValueError("Expanded archive exceeds the size limit")
                    for entry in entries:
                        if entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError("Archive links and directories are not allowed")
                        if entry.filename.endswith(".json") and entry.file_size > 65536:
                            raise ValueError("Manifest is too large")
                    manifest = json.loads(package.read("update-manifest.json"))
                    info = json.loads(package.read("build-info.json"))
                    if not isinstance(manifest, dict) or not isinstance(info, dict):
                        raise ValueError("Invalid manifest object")
                    if manifest.get("schema") != 1 or manifest.get("data_epoch") != DATA_EPOCH:
                        raise ValueError("Unsupported update protocol or data compatibility")
                    if manifest.get("platform") != "windows-x64":
                        raise ValueError("Unsupported update platform")
                    if not isinstance(info.get("version"), str) or not info["version"]:
                        raise ValueError("Missing build version")
                    hashes = info.get("sha256", {})
                    if not isinstance(hashes, dict) or set(hashes) != (set(EXECUTABLES) | ({HELPER} if HELPER in names else set())) or any(
                        not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value)
                        for value in hashes.values()
                    ):
                        raise ValueError("Build metadata does not describe the executable pair")
                    plan = {"id": uuid.uuid4().hex, "state": "prepared", "version": info["version"],
                            "commit": info.get("commit"), "archive_sha256": h,
                            "data_epoch": DATA_EPOCH, "sha256": hashes}
                    directory = self.candidate(plan)
                    directory.mkdir(parents=True, exist_ok=False)
                    try:
                        for entry in entries:
                            with package.open(entry) as source, (directory / entry.filename).open("xb") as target:
                                shutil.copyfileobj(source, target, 1024 * 1024)
                        self.verify(plan)
                        atomic_json(self.state_file, plan)
                    except BaseException:
                        shutil.rmtree(directory)
                        raise
            return plan

    def cancel(self, plan_id: str) -> dict[str, Any]:
        # Once armed, only the independently running executor can conclude it.
        return self.transition(plan_id, {"prepared"}, "cancelled")
