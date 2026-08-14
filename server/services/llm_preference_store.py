"""Cached persistence for the user's preferred LLM."""
from __future__ import annotations

import logging
import threading
from typing import Any

from .. import _paths

log = logging.getLogger(__name__)

_UNSET = object()


class LlmPreferenceStore:
    """Read and update preferred_llm_no without owning config.json."""

    def __init__(self, *, load_config: Any = None, save_config: Any = None) -> None:
        self._load_config = load_config or (lambda: _paths.load_config())
        self._save_config = save_config or (lambda cfg: _paths.save_config(cfg))
        self._lock = threading.RLock()
        self._cache: Any = _UNSET

    def get(self) -> int | None:
        with self._lock:
            if self._cache is _UNSET:
                try:
                    self._cache = self._load_config().get("preferred_llm_no")
                except Exception as exc:
                    log.warning("failed to read preferred llm: %s", exc)
                    self._cache = None
            return self._cache

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
