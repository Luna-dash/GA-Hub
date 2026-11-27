"""Generic IM adapter interface and zero-overhead registry for GA-Hub.

This module replaces the retired Feishu-specific integration with a neutral
extension point. When no adapter is registered, the registry allocates zero
background threads, zero subprocesses, and performs zero polling.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Protocol, runtime_checkable

from ..event_topics import IM_MESSAGE, IM_STARTED, IM_STATUS, IM_STOPPED
from .event_bus import bus

log = logging.getLogger(__name__)


@runtime_checkable
class IMAdapter(Protocol):
    """Minimal contract implemented by any future IM channel adapter."""

    id: str
    name: str

    def status(self) -> dict[str, Any]:
        """Return a JSON-serializable adapter status snapshot."""
        ...

    def start(self) -> dict[str, Any]:
        """Start the adapter and return its updated status."""
        ...

    def stop(self) -> dict[str, Any]:
        """Stop the adapter and return its updated status."""
        ...

    def send_text(self, target_id: str, text: str, **kwargs: Any) -> dict[str, Any]:
        """Send a text message to ``target_id``."""
        ...

    def shutdown(self) -> None:
        """Release any background threads, sockets, or child processes."""
        ...


class IMRegistry:
    """Thread-safe registry for optional IM channel adapters."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._adapters: dict[str, IMAdapter] = {}

    def register(self, adapter: IMAdapter) -> None:
        adapter_id = str(getattr(adapter, "id", "") or "").strip()
        if not adapter_id:
            raise ValueError("IM adapter must define a non-empty id")
        with self._lock:
            self._adapters[adapter_id] = adapter

    def unregister(self, adapter_id: str) -> IMAdapter | None:
        with self._lock:
            return self._adapters.pop(adapter_id, None)

    def get(self, adapter_id: str) -> IMAdapter | None:
        with self._lock:
            return self._adapters.get(adapter_id)

    def list_adapters(self) -> list[IMAdapter]:
        with self._lock:
            return list(self._adapters.values())

    def has_adapters(self) -> bool:
        with self._lock:
            return bool(self._adapters)

    def status_snapshot(self) -> dict[str, Any]:
        adapters = self.list_adapters()
        if not adapters:
            return {"configured": False, "adapters": []}
        items: list[dict[str, Any]] = []
        for adapter in adapters:
            adapter_id = str(getattr(adapter, "id", "unknown"))
            name = str(getattr(adapter, "name", adapter_id))
            try:
                raw = adapter.status()
                entry = dict(raw) if isinstance(raw, dict) else {}
                running = bool(entry.get("running", False))
                state = str(entry.get("state") or ("running" if running else "stopped"))
                summary = str(entry.get("summary") or ("运行中" if running else "已停止"))
                items.append({
                    "id": adapter_id,
                    "name": name,
                    "running": running,
                    "state": state,
                    "summary": summary,
                    "error": entry.get("error"),
                    "details": entry,
                })
            except Exception as exc:
                log.exception("IM adapter %s status read failed", adapter_id)
                items.append({
                    "id": adapter_id,
                    "name": name,
                    "running": False,
                    "state": "error",
                    "summary": f"状态读取失败：{exc}",
                    "error": str(exc),
                    "details": {},
                })
        return {"configured": True, "adapters": items}

    def shutdown_all(self) -> None:
        for adapter in self.list_adapters():
            adapter_id = str(getattr(adapter, "id", "unknown"))
            try:
                adapter.shutdown()
            except Exception:
                log.exception("IM adapter %s shutdown failed", adapter_id)

    @staticmethod
    def publish_started(adapter_id: str, payload: dict[str, Any] | None = None) -> None:
        bus.publish(IM_STARTED, {"adapter": adapter_id, **(payload or {})})

    @staticmethod
    def publish_stopped(adapter_id: str, payload: dict[str, Any] | None = None) -> None:
        bus.publish(IM_STOPPED, {"adapter": adapter_id, **(payload or {})})

    @staticmethod
    def publish_message(adapter_id: str, payload: dict[str, Any]) -> None:
        bus.publish(IM_MESSAGE, {"adapter": adapter_id, **payload})

    @staticmethod
    def publish_status(adapter_id: str, payload: dict[str, Any]) -> None:
        bus.publish(IM_STATUS, {"adapter": adapter_id, **payload})


im_registry = IMRegistry()
