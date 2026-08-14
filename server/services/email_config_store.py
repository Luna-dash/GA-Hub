"""Atomic persistence for SMTP configuration."""
from __future__ import annotations

import json
import logging
import os
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from .. import _paths

log = logging.getLogger(__name__)

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "",
    "port": 587,
    "username": "",
    "password": "",
    "from_addr": "",
    "default_to": "",
    "use_tls": True,
    "use_ssl": False,
}


class EmailConfigFormatError(RuntimeError):
    """Raised when persisted email configuration is unreadable or invalid."""


class EmailConfigStore:
    """Own every read and write for email_config.json."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _paths.email_config_file()
        self._lock = threading.RLock()

    def read(self, *, public: bool = False) -> dict[str, Any]:
        with self._lock:
            config = dict(DEFAULT_CONFIG)
            if self.path.is_file():
                try:
                    data = json.loads(self.path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError) as exc:
                    raise EmailConfigFormatError(f"unable to read email config: {exc}") from exc
                if not isinstance(data, dict):
                    raise EmailConfigFormatError("email config must be a JSON object")
                unknown = set(data) - set(DEFAULT_CONFIG)
                if unknown:
                    log.warning("ignoring unknown email config keys: %s", sorted(unknown))
                config.update({key: value for key, value in data.items() if key in DEFAULT_CONFIG})
            config = self._normalize(config)
            return self._public_view(config) if public else config

    def update(self, changes: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            config = self.read()
            for key in DEFAULT_CONFIG:
                if key not in changes:
                    continue
                if key == "password" and not changes.get(key) and config.get(key):
                    continue
                config[key] = changes[key]
            config = self._normalize(config)
            self._write(config)
            return self._public_view(config)

    @staticmethod
    def _normalize(config: dict[str, Any]) -> dict[str, Any]:
        try:
            config["port"] = int(config.get("port") or 587)
        except (TypeError, ValueError) as exc:
            raise EmailConfigFormatError("email port must be an integer") from exc
        if not 1 <= config["port"] <= 65535:
            raise EmailConfigFormatError("email port must be between 1 and 65535")
        config["use_tls"] = bool(config.get("use_tls"))
        config["use_ssl"] = bool(config.get("use_ssl"))
        return config

    @staticmethod
    def _public_view(config: dict[str, Any]) -> dict[str, Any]:
        view = dict(config)
        view["password_set"] = bool(view.pop("password", ""))
        return view

    def _write(self, config: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(f".{uuid4().hex}.tmp")
        try:
            tmp.write_text(
                json.dumps(config, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            os.replace(tmp, self.path)
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass


_STORE = EmailConfigStore()
