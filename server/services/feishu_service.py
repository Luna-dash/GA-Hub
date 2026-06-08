"""Feishu bot process management for GA-Hub."""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any

from .. import _paths
from .event_bus import bus


class FeishuService:
    _instance: "FeishuService | None" = None

    _CHAT_MARKER = "__GAHUB_FEISHU_CHAT__"

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._last_check: dict[str, Any] | None = None
        self._last_check_ts = 0.0
        self._chat_event_seen: set[str] = set()
        self._chat_event_order: deque[str] = deque(maxlen=1000)
        self._poll_stop = threading.Event()
        self._poll_thread: threading.Thread | None = None

    @classmethod
    def instance(cls) -> "FeishuService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def fsapp_path(self) -> Path:
        if _paths.GA_ROOT is None:
            raise RuntimeError("GA_ROOT not configured")
        return _paths.GA_ROOT / "frontends" / "fsapp.py"

    def log_file(self) -> Path:
        return _paths.temp_dir() / "feishuapp.log"

    def _python(self) -> str:
        return _paths.discover_user_python(_paths.GA_ROOT) or sys.executable

    def _publish_chat_events_from_text(self, text: str) -> int:
        published = 0
        for line in (text or "").splitlines():
            marker_at = line.find(self._CHAT_MARKER)
            if marker_at < 0:
                continue
            raw = line[marker_at + len(self._CHAT_MARKER):].strip()
            try:
                payload = json.loads(raw)
            except Exception:
                continue
            if not isinstance(payload, dict):
                continue
            event_id = str(payload.get("event_id") or "")
            if not event_id:
                event_id = f"{payload.get('task_id') or ''}:{payload.get('type') or ''}:{payload.get('ts') or time.time()}"
                payload["event_id"] = event_id
            if event_id in self._chat_event_seen:
                continue
            self._chat_event_seen.add(event_id)
            self._chat_event_order.append(event_id)
            while len(self._chat_event_seen) > self._chat_event_order.maxlen:
                old = self._chat_event_order.popleft()
                self._chat_event_seen.discard(old)
            bus.publish("feishu:chat", payload)
            published += 1
        return published

    def _publish_chat_events_from_log(self, n: int = 300) -> int:
        return self._publish_chat_events_from_text("".join(self.tail(n)))

    def start_log_watcher(self, interval: float = 1.0) -> bool:
        """Continuously mirror fsapp stdout markers into the in-process EventBus."""
        with self._lock:
            if self._poll_thread and self._poll_thread.is_alive():
                return False
            self._poll_stop.clear()

            def _worker() -> None:
                while not self._poll_stop.wait(interval):
                    try:
                        self._publish_chat_events_from_log()
                    except Exception:
                        # Best-effort watcher; explicit status/log endpoints still expose errors.
                        pass

            self._poll_thread = threading.Thread(target=_worker, name="feishu-log-watcher", daemon=True)
            self._poll_thread.start()
            return True

    def shutdown(self) -> None:
        self._poll_stop.set()
        t = self._poll_thread
        if t and t.is_alive():
            t.join(timeout=2.0)

    def _base_env(self) -> dict[str, str]:
        env = os.environ.copy()
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        if _paths.GA_ROOT is not None:
            env["GA_ROOT"] = str(_paths.GA_ROOT)
        return env

    def _running_locked(self) -> bool:
        return bool(self._proc and self._proc.poll() is None)

    def _find_external_pid(self) -> int | None:
        """Find a running fsapp.py python process started outside this service instance."""
        try:
            if os.name == "nt":
                ps = (
                    "Get-CimInstance Win32_Process | "
                    "Where-Object { $_.Name -match 'python' -and $_.CommandLine -like '*frontends*fsapp.py*' } | "
                    "Sort-Object ProcessId -Descending | Select-Object -First 1 -ExpandProperty ProcessId"
                )
                p = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=6)
                for line in (p.stdout or "").splitlines():
                    line = line.strip()
                    if line.isdigit():
                        return int(line)
            else:
                pattern = r"python.*frontends[/\\]fsapp\.py"
                p = subprocess.run(["pgrep", "-f", pattern], text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=6)
                for line in (p.stdout or "").splitlines():
                    line = line.strip()
                    if line.isdigit() and int(line) != os.getpid():
                        return int(line)
        except Exception:
            return None
        return None

    def is_running(self) -> bool:
        with self._lock:
            if self._running_locked():
                return True
        return bool(self._find_external_pid())

    def status(self) -> dict[str, Any]:
        self._publish_chat_events_from_log()
        fsapp = self.fsapp_path()
        log_file = self.log_file()
        with self._lock:
            proc = self._proc
            running = self._running_locked()
            pid = proc.pid if proc and running else None
            returncode = None if proc is None else proc.poll()
        external = False
        if not running:
            ext_pid = self._find_external_pid()
            if ext_pid:
                running, pid, returncode, external = True, ext_pid, None, True
        return {
            "running": running,
            "pid": pid,
            "returncode": returncode,
            "external": external,
            "fsapp_path": str(fsapp),
            "fsapp_exists": fsapp.is_file(),
            "python": self._python(),
            "log_file": str(log_file),
            "log_exists": log_file.is_file(),
            "last_check": self._last_check,
            "last_check_ts": self._last_check_ts,
        }

    def save_keys(self, app_id: str, app_secret: str, allowed_users: str = "") -> dict[str, Any]:
        app_id = (app_id or "").strip()
        app_secret = (app_secret or "").strip()
        allowed_users = (allowed_users or "").strip()
        if not app_id:
            raise ValueError("app_id required")
        if not app_secret:
            raise ValueError("app_secret required")

        ga_root = _paths.GA_ROOT
        if ga_root is None:
            raise RuntimeError("GA_ROOT not configured")
        keychain_path = ga_root / "memory" / "keychain.py"
        if not keychain_path.is_file():
            raise FileNotFoundError(f"keychain.py not found: {keychain_path}")

        script = (
            "import importlib.util, sys\n"
            "keychain_path, app_id, app_secret, allowed = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]\n"
            "spec = importlib.util.spec_from_file_location('ga_keychain_for_feishu', keychain_path)\n"
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "m.keys.set('feishu_app_id', app_id)\n"
            "m.keys.set('feishu_app_secret', app_secret)\n"
            "if allowed.strip(): m.keys.set('feishu_allowed_users', allowed.strip())\n"
        )
        p = subprocess.run(
            [self._python(), "-X", "utf8", "-c", script, str(keychain_path), app_id, app_secret, allowed_users],
            cwd=str(ga_root),
            env=self._base_env(),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=20,
        )
        if p.returncode != 0:
            raise RuntimeError((p.stdout or "keychain save failed").strip())
        self._last_check = None
        self._last_check_ts = 0.0
        evt = {"ok": True, "app_id_masked": self._mask(app_id), "allowed_users_saved": bool(allowed_users)}
        bus.publish("feishu:keys_saved", evt)
        return evt

    @staticmethod
    def _mask(value: str) -> str:
        value = str(value or "")
        if len(value) <= 8:
            return "*" * len(value)
        return value[:4] + "*" * (len(value) - 8) + value[-4:]

    def check(self, init_agent: bool = False, timeout: int = 25) -> dict[str, Any]:
        fsapp = self.fsapp_path()
        if not fsapp.is_file():
            out = {"ready": False, "ok": False, "error": f"fsapp.py not found: {fsapp}", "fsapp_path": str(fsapp)}
            self._last_check = out
            self._last_check_ts = time.time()
            return out
        cmd = [self._python(), "-X", "utf8", "-u", str(fsapp), "--check-agent" if init_agent else "--check"]
        try:
            p = subprocess.run(
                cmd,
                cwd=str(_paths.GA_ROOT),
                env=self._base_env(),
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=timeout,
            )
            raw = p.stdout or ""
            self._publish_chat_events_from_text(raw)
            start, end = raw.find("{"), raw.rfind("}")
            if start >= 0 and end >= start:
                parsed: dict[str, Any] = json.loads(raw[start:end + 1])
                extra = (raw[:start] + raw[end + 1:]).strip()
                if extra:
                    parsed["raw"] = raw.strip()
            else:
                parsed = {"ready": False, "error": "check did not return JSON", "raw": raw.strip()}
            parsed["returncode"] = p.returncode
            parsed["ok"] = bool(parsed.get("ready")) and p.returncode == 0
        except Exception as e:
            parsed = {"ready": False, "ok": False, "error": str(e)}
        self._last_check = parsed
        self._last_check_ts = time.time()
        bus.publish("feishu:check", parsed)
        return parsed

    def tail(self, n: int = 300) -> list[str]:
        path = self.log_file()
        if not path.is_file():
            return []
        n = max(1, min(int(n or 300), 5000))
        with path.open("r", encoding="utf-8", errors="replace") as f:
            return list(deque(f, maxlen=n))

    def start(self) -> dict[str, Any]:
        fsapp = self.fsapp_path()
        if not fsapp.is_file():
            raise FileNotFoundError(f"fsapp.py not found: {fsapp}")
        with self._lock:
            if self._running_locked():
                return {"started": False, "running": True, "pid": self._proc.pid}
            ext_pid = self._find_external_pid()
            if ext_pid:
                return {"started": False, "running": True, "pid": ext_pid, "external": True}
            log_file = self.log_file()
            log_file.parent.mkdir(parents=True, exist_ok=True)
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0
            log_fh = log_file.open("a", encoding="utf-8", errors="replace")
            log_fh.write("\n" + "=" * 18 + " GA-Hub start feishuapp " + time.strftime("%Y-%m-%d %H:%M:%S") + " " + "=" * 18 + "\n")
            log_fh.flush()
            self._proc = subprocess.Popen(
                [self._python(), "-X", "utf8", "-u", str(fsapp)],
                cwd=str(_paths.GA_ROOT),
                env=self._base_env(),
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=flags,
            )
            pid = self._proc.pid
        evt = {"started": True, "running": True, "pid": pid, "log_file": str(self.log_file())}
        self._publish_chat_events_from_log()
        self.start_log_watcher()
        bus.publish("feishu:started", evt)
        return evt

    def stop(self, timeout: float = 8.0) -> dict[str, Any]:
        with self._lock:
            proc = self._proc
            if not proc or proc.poll() is not None:
                self._proc = None
                return {"stopped": False, "running": False}
            pid = proc.pid
            try:
                if os.name == "nt":
                    proc.send_signal(signal.CTRL_BREAK_EVENT)  # type: ignore[attr-defined]
                else:
                    proc.terminate()
            except Exception:
                proc.terminate()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)
        with self._lock:
            self._proc = None
        evt = {"stopped": True, "running": False, "pid": pid}
        bus.publish("feishu:stopped", evt)
        return evt

    def send_text(self, receive_id: str, text: str, receive_id_type: str = "open_id", use_card: bool = False) -> dict[str, Any]:
        receive_id = (receive_id or "").strip()
        text = text or ""
        if not receive_id:
            raise ValueError("receive_id required")
        if not text.strip():
            raise ValueError("text required")
        helper = (
            "import importlib.util, json, sys\n"
            "fsapp_path, rid, text, rtype, use_card = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5] == '1'\n"
            "spec = importlib.util.spec_from_file_location('ga_fsapp_send', fsapp_path)\n"
            "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\n"
            "m.client = m.create_client()\n"
            "mid = m.send_message(rid, text, use_card=use_card, receive_id_type=rtype)\n"
            "print(json.dumps({'ok': bool(mid), 'message_id': mid}, ensure_ascii=False), flush=True)\n"
        )
        p = subprocess.run(
            [self._python(), "-X", "utf8", "-c", helper, str(self.fsapp_path()), receive_id, text, receive_id_type, "1" if use_card else "0"],
            cwd=str(_paths.GA_ROOT),
            env=self._base_env(),
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=45,
        )
        raw = p.stdout or ""
        self._publish_chat_events_from_text(raw)
        out: dict[str, Any] = {"ok": p.returncode == 0, "returncode": p.returncode, "raw": raw.strip()}
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end >= start:
            try:
                out.update(json.loads(raw[start:end + 1]))
            except Exception:
                pass
        bus.publish("feishu:send", out)
        return out
