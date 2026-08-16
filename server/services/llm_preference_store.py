"""Cached persistence for the user's preferred LLM."""
from __future__ import annotations

import logging
import threading
from typing import Any

from .. import _paths

log = logging.getLogger(__name__)

_UNSET = object()


class LlmPreferenceStore:
    """Read and update the preferred LLM without owning config.json.

    ``preferred_llm_key`` is the durable truth. ``preferred_llm_no`` remains
    only for older GA-Hub callers and is updated as a compatibility snapshot.
    """

    def __init__(self, *, load_config: Any = None, save_config: Any = None) -> None:
        self._load_config = load_config or (lambda: _paths.load_config())
        self._save_config = save_config or (lambda cfg: _paths.save_config(cfg))
        self._lock = threading.RLock()
        self._cache: Any = _UNSET
        self._key_cache: Any = _UNSET

    def get(self) -> int | None:
        with self._lock:
            if self._cache is _UNSET:
                try:
                    self._cache = self._load_config().get("preferred_llm_no")
                except Exception as exc:
                    log.warning("failed to read preferred llm: %s", exc)
                    self._cache = None
            return self._cache

    def get_key(self) -> str | None:
        with self._lock:
            if self._key_cache is not _UNSET:
                return self._key_cache
            try:
                value = self._load_config().get("preferred_llm_key")
            except Exception as exc:
                log.warning("failed to read preferred llm key: %s", exc)
                self._key_cache = None
                return None
            self._key_cache = value.strip() if isinstance(value, str) and value.strip() else None
            return self._key_cache

    def get_selection(self) -> tuple[str | None, int | None]:
        """Read both preference fields with at most one config load."""
        with self._lock:
            if self._key_cache is not _UNSET and self._cache is not _UNSET:
                return self._key_cache, self._cache
            try:
                config = self._load_config()
                value = config.get("preferred_llm_key")
                self._key_cache = (
                    value.strip()
                    if isinstance(value, str) and value.strip()
                    else None
                )
                self._cache = config.get("preferred_llm_no")
            except Exception as exc:
                log.warning("failed to read preferred llm selection: %s", exc)
                self._key_cache = None
                self._cache = None
            return self._key_cache, self._cache

    def set_key(self, key: str) -> None:
        key = key.strip()
        if not key:
            raise ValueError("preferred llm key cannot be empty")
        with self._lock:
            if self._key_cache == key:
                return
            config = dict(self._load_config())
            if config.get("preferred_llm_key") == key:
                self._key_cache = key
                return
            config["preferred_llm_key"] = key
            self._save_config(config)
            self._key_cache = key
            log.info("preferred_llm_key persisted: %s", key)

    def set(self, index: int) -> None:
        index = int(index)
        with self._lock:
            if self._cache == index:
                return
            config = dict(self._load_config())
            if config.get("preferred_llm_no") == index:
                self._cache = index
                return
            config["preferred_llm_no"] = index
            self._save_config(config)
            self._cache = index
            log.info("preferred_llm_no persisted: %s", index)

    def set_selection(self, key: str, index: int) -> None:
        """Persist the durable key and compatibility index together."""
        key = key.strip()
        if not key:
            raise ValueError("preferred llm key cannot be empty")
        index = int(index)
        with self._lock:
            if self._key_cache == key and self._cache == index:
                return
            config = dict(self._load_config())
            if (
                config.get("preferred_llm_key") == key
                and config.get("preferred_llm_no") == index
            ):
                self._key_cache = key
                self._cache = index
                return
            config["preferred_llm_key"] = key
            config["preferred_llm_no"] = index
            self._save_config(config)
            self._key_cache = key
            self._cache = index
            log.info("preferred llm selection persisted: %s@%s", key, index)
