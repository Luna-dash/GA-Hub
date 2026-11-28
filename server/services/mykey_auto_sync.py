"""Daily cloud model sync; probe authenticated metadata before fetching data."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import subprocess
import threading
from datetime import datetime, timedelta

from .. import _paths
from ..process_utils import hidden_process_kwargs
from . import mykey_service

log = logging.getLogger(__name__)

# Run in the same real GA Python as the existing sync helper (also in frozen builds).
# Only metadata is read; neither a full-container status nor a dry-run fetch is used.
PROBE_CODE = r'''
import contextlib, json, runpy, struct, sys, urllib.request
# GA's helper and credential imports can print to stdout; reserve it for JSON.
with contextlib.redirect_stdout(sys.stderr):
    m = runpy.run_path(sys.argv[1], run_name="gahub_mykey_probe")
    secret = m["get_passphrase"]()
    key = m["derive_storage_key"](secret)
    url = m["get_base_url"](sys.argv[2] if len(sys.argv) > 2 else None) + "/" + key

def read_range(start, size):
    req = urllib.request.Request(url, headers={
        "Range": f"bytes={start}-{start + size - 1}",
        "Cache-Control": "no-cache", "Accept-Encoding": "identity",
        "User-Agent": "GA-Hub-mykey-probe/1.0",
    })
    with urllib.request.urlopen(req, timeout=20) as response:
        if response.status == 206:
            if not response.headers.get("Content-Range", "").startswith(f"bytes {start}-"):
                raise ValueError("invalid content range")
        elif response.status == 200:
            # Legacy servers may ignore Range. Stream only the required prefix.
            remaining = start
            while remaining:
                chunk = response.read(remaining)
                if not chunk:
                    raise ValueError("truncated prefix")
                remaining -= len(chunk)
        else:
            raise ValueError("unexpected response status")
        result = bytearray()
        while len(result) < size:
            chunk = response.read(size - len(result))
            if not chunk:
                raise ValueError("truncated metadata")
            result.extend(chunk)
        return bytes(result)

header = read_range(0, 9)
if header[:5] != b"GAMK2":
    raise ValueError("unsupported container")
length = struct.unpack(">I", header[5:])[0]
if not 33 <= length <= 16384:
    raise ValueError("invalid metadata length")
meta = json.loads(m["decrypt"](m["derive_meta_key"](secret), read_range(9, length), aad=b"meta"))
sha = meta["source_sha256"]
if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
    raise ValueError("invalid source hash")
print(json.dumps({"sha256": sha}))
'''


def fingerprint(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"


def remote_fingerprint() -> str:
    script = _paths.ga_mykey_sync_script()
    if not script.is_file():
        raise RuntimeError("同步脚本不可用")
    base_url = mykey_service._sync_base_url()
    env = dict(os.environ, GA_MYKEY_BASE_URL=base_url)
    command = [mykey_service._mykey_sync_python(), "-X", "utf8", "-c", PROBE_CODE, str(script), base_url]
    # Do not log the command, exception, or captured output: they can include
    # sync URLs, derived storage paths, or credential-module output.
    try:
        result = subprocess.run(
            command, cwd=str(_paths.GA_ROOT), env=env, capture_output=True,
            encoding="utf-8", errors="replace", timeout=50, **hidden_process_kwargs(),
        )
    except subprocess.TimeoutExpired as exc:
        log.warning("mykey version check timed out after %s seconds", exc.timeout)
        raise RuntimeError("云端版本检查超时") from None
    if result.returncode:
        log.warning("mykey version check helper exited unsuccessfully (code=%d)", result.returncode)
        raise RuntimeError("云端版本检查失败，请检查网络、同步密钥及同步服务")
    try:
        payload = json.loads(result.stdout)
        sha = payload.get("sha256") if isinstance(payload, dict) else None
        if not isinstance(sha, str) or len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
            raise ValueError("invalid source hash")
    except ValueError:
        log.warning("mykey version check returned invalid JSON output or fingerprint")
        raise RuntimeError("云端版本检查返回无效结果") from None
    return sha


def checked_fetch() -> dict:
    """Compare authenticated metadata before invoking the existing fetch transaction."""
    local = fingerprint(mykey_service._mykey_path())
    try:
        remote = remote_fingerprint()
    except mykey_service.MykeyHttpError:
        raise
    except Exception as exc:
        raise mykey_service.MykeyHttpError(502, "云端差异检查失败，本地配置未更改") from exc
    if local == remote:
        return {"ok": True, "action": "fetch", "changed": False,
                "path": str(mykey_service._mykey_path()), "returncode": 0,
                "stdout": "[fetch] 已是最新，无需下载", "stderr": ""}
    result = mykey_service.sync_fetch(expected_sha256=local)
    return {**result, "changed": result.get("changed", True)}


class MykeyAutoSync:
    """Owned by SchedulerHost, one persisted attempt per local calendar day."""

    def __init__(self, *, scheduler_runtime, path: Path | None = None, now=None):
        self.runtime = scheduler_runtime
        self.path = path or _paths.ADMIN_DATA / "mykey-auto-sync.json"
        self.now = now or (lambda: datetime.now().astimezone())
        self.lock = threading.RLock()
        self.running = False
        self.stopped = True
        self.state = {"enabled": False, "last_attempt_day": None, "last_checked": None,
                      "last_updated": None, "result": "never", "message": "尚未检查"}
        if self.path.is_file():
            try:
                data = json.loads(self.path.read_text("utf-8"))
                self.state.update({k: data[k] for k in self.state if k in data})
            except (ValueError, OSError):
                log.warning("mykey auto sync state unreadable; disabled until explicitly enabled")
                self.state.update(enabled=False, result="error", message="同步状态不可读，请重新启用")

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    def status(self):
        with self.lock:
            now = self.now()
            next_check = now.replace(hour=12, minute=0, second=0, microsecond=0)
            if now >= next_check:
                next_check += timedelta(days=1)
            return {**self.state, "running": self.running, "schedule": "每天 12:00（本机时间）",
                    "next_check": next_check.isoformat() if self.state["enabled"] and not self.stopped else None}

    def configure(self, enabled: bool):
        with self.lock:
            self.state["enabled"] = enabled
            self._save()
        return self.status()

    def start(self):
        self.stopped = False
        # Minute tick also catches sleep/resume and app startup after noon.
        self.runtime.add_job(self.tick, "interval", minutes=1, id="mykey-auto-sync",
                                       replace_existing=True, max_instances=1, coalesce=True,
                                       next_run_time=self.now())

    def tick(self):
        with self.lock:
            now = self.now()
            day = now.date().isoformat()
            if (self.stopped or self.running or not self.state["enabled"] or now.hour < 12
                    or self.state["last_attempt_day"] == day):
                return
            self.state.update(last_attempt_day=day, last_checked=now.isoformat())
            self._save()  # reserve before network IO; restarts must not repeat today's attempt
            self.running = True
        try:
            result = checked_fetch()
            if result["changed"]:
                outcome, message = "updated", "已从云端更新模型配置"
            else:
                outcome, message = "unchanged", "云端与本地一致，无需下载"
            with self.lock:
                self.state.update(result=outcome, message=message)
                if outcome == "updated":
                    self.state["last_updated"] = self.now().isoformat()
        except Exception:
            # Do not persist paths, subprocess output or credential-bearing diagnostics.
            log.warning("daily model sync failed")
            with self.lock:
                self.state.update(result="error", message="同步失败；本地配置已保留，请检查网络与同步设置")
        finally:
            with self.lock:
                self.running = False
                self._save()

    def shutdown(self, timeout=5.0):
        with self.lock:
            self.stopped = True
        try:
            self.runtime.remove_job("mykey-auto-sync")
        except Exception:
            pass
        return not self.running
