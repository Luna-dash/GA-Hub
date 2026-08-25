"""Recoverable chat-stream retry policy and error classification.

The retry decision lives on the backend because the agent stream can finish with
transport errors embedded in the final assistant text. Keep marker matching in
this module so adding future recoverable errors is localized.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .. import _paths

CONFIG_KEY = "chat_error_retry"
DEFAULT_ENABLED = True
DEFAULT_MAX_ATTEMPTS = 2
MAX_CONFIG_ATTEMPTS = 5
DEFAULT_BACKOFF_BASE_SECONDS = 2.0
DEFAULT_BACKOFF_FACTOR = 2.0
DEFAULT_BACKOFF_MAX_SECONDS = 60.0
MAX_CONFIG_BACKOFF_SECONDS = 600.0
MAX_CONFIG_BACKOFF_FACTOR = 10.0
_FINAL_MARKER_WINDOW_CHARS = 500


@dataclass(frozen=True)
class ChatRetryConfig:
    enabled: bool = DEFAULT_ENABLED
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    backoff_base_seconds: float = DEFAULT_BACKOFF_BASE_SECONDS
    backoff_factor: float = DEFAULT_BACKOFF_FACTOR
    backoff_max_seconds: float = DEFAULT_BACKOFF_MAX_SECONDS

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.enabled),
            "max_attempts": int(self.max_attempts),
            "backoff_base_seconds": float(self.backoff_base_seconds),
            "backoff_factor": float(self.backoff_factor),
            "backoff_max_seconds": float(self.backoff_max_seconds),
        }


@dataclass(frozen=True)
class RecoverableErrorMatch:
    code: str
    label: str
    marker: str

    def to_dict(self) -> dict[str, str]:
        return {
            "code": self.code,
            "label": self.label,
            "marker": self.marker,
        }


@dataclass(frozen=True)
class RecoverableErrorPattern:
    code: str
    label: str
    pattern: re.Pattern[str]


_EXC_ERROR_PREFIX = r"!!!\s*Error:\s*(?:requests\.)?(?:exceptions\.)?"

_RECOVERABLE_ERROR_PATTERNS = (
    RecoverableErrorPattern(
        code="rate_limit",
        label="RateLimitError",
        pattern=re.compile(
            r"!!!\s*Error:\s*[^\r\n]*rate[\s_-]?limit[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="http_retryable",
        label="HTTPError",
        pattern=re.compile(
            r"!!!\s*Error:\s*HTTP\s+(?:408|409|425|429|500|502|503|504|52[0-7]|529)\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="sse_error",
        label="SSEError",
        pattern=re.compile(
            r"!!!\s*Error:\s*SSE\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="timeout",
        label="Timeout",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"(?:Read|Connect|Write)?Timeout\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="connection_error",
        label="ConnectionError",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"(?:ConnectionError|ProtocolError|ChunkedEncodingError)\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="json_decode_error",
        label="JSONDecodeError",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"(?:json\.)?JSONDecodeError\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
    RecoverableErrorPattern(
        code="ssl_error",
        label="SSLError",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"SSLError\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
    ),
)


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    if value is None:
        return default
    return bool(value)


def _coerce_finite_float(value: Any, default: float) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(out):
        return default
    return out


def normalize_chat_retry_config(payload: Mapping[str, Any] | None) -> ChatRetryConfig:
    raw = payload if isinstance(payload, Mapping) else {}
    enabled = _coerce_bool(raw.get("enabled"), DEFAULT_ENABLED)
    try:
        max_attempts = int(raw.get("max_attempts", DEFAULT_MAX_ATTEMPTS))
    except (TypeError, ValueError):
        max_attempts = DEFAULT_MAX_ATTEMPTS
    max_attempts = max(0, min(MAX_CONFIG_ATTEMPTS, max_attempts))
    backoff_base = _coerce_finite_float(raw.get("backoff_base_seconds"), DEFAULT_BACKOFF_BASE_SECONDS)
    backoff_base = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, backoff_base))
    backoff_factor = _coerce_finite_float(raw.get("backoff_factor"), DEFAULT_BACKOFF_FACTOR)
    backoff_factor = max(1.0, min(MAX_CONFIG_BACKOFF_FACTOR, backoff_factor))
    backoff_max = _coerce_finite_float(raw.get("backoff_max_seconds"), DEFAULT_BACKOFF_MAX_SECONDS)
    backoff_max = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, backoff_max))
    backoff_max = max(backoff_max, backoff_base)
    return ChatRetryConfig(
        enabled=enabled,
        max_attempts=max_attempts,
        backoff_base_seconds=backoff_base,
        backoff_factor=backoff_factor,
        backoff_max_seconds=backoff_max,
    )


def compute_backoff_delay(attempt_index: int, cfg: ChatRetryConfig) -> float:
    """Exponential backoff before retry ``attempt_index`` (0-based).

    ``delay = base * factor ** attempt_index``, clamped to
    ``backoff_max_seconds``. Never negative.
    """
    base = max(0.0, float(cfg.backoff_base_seconds))
    factor = max(1.0, float(cfg.backoff_factor))
    cap = max(0.0, float(cfg.backoff_max_seconds))
    index = max(0, int(attempt_index))
    try:
        delay = base * (factor ** index)
    except OverflowError:
        delay = cap
    if delay > cap:
        delay = cap
    return max(0.0, delay)


def load_chat_retry_config() -> ChatRetryConfig:
    cfg = _paths.load_config()
    payload = cfg.get(CONFIG_KEY)
    return normalize_chat_retry_config(payload if isinstance(payload, Mapping) else None)


def save_chat_retry_config(payload: Mapping[str, Any] | None) -> ChatRetryConfig:
    cfg = _paths.load_config()
    normalized = normalize_chat_retry_config(payload)
    cfg[CONFIG_KEY] = normalized.to_dict()
    _paths.save_config(cfg)
    return normalized


def classify_recoverable_error(content: str) -> RecoverableErrorMatch | None:
    """Return the recoverable stream error near the final output, if any."""
    final_text = (content or "").rstrip()[-_FINAL_MARKER_WINDOW_CHARS:]
    if not final_text:
        return None
    for spec in _RECOVERABLE_ERROR_PATTERNS:
        match = spec.pattern.search(final_text)
        if match:
            return RecoverableErrorMatch(
                code=spec.code,
                label=spec.label,
                marker=match.group(0),
            )
    return None
