"""Recoverable chat-stream retry policy and error classification.

The retry decision lives on the backend because the agent stream can finish with
transport errors embedded in the final assistant text. Keep marker matching in
this module so adding future recoverable errors is localized.
"""
from __future__ import annotations

import math
import random
import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from .. import _paths

CONFIG_KEY = "chat_error_retry"
DEFAULT_ENABLED = True
DEFAULT_MAX_ATTEMPTS = 3
MAX_CONFIG_ATTEMPTS = 5
# Scheduled/autonomous chats fire unattended (nobody watching), so they get a
# deeper retry budget than interactive chats. The chain keeps this identity
# across retries via StreamHandle.error_retry_origin.
DEFAULT_SCHEDULED_MAX_ATTEMPTS = 6
MAX_SCHEDULED_CONFIG_ATTEMPTS = 10
SCHEDULED_RETRY_SOURCES = frozenset({"scheduled", "scheduled_task", "autonomous"})
_BACKOFF_JITTER_RANGE = (0.85, 1.15)
DEFAULT_BACKOFF_BASE_SECONDS = 2.0
DEFAULT_BACKOFF_FACTOR = 2.0
DEFAULT_BACKOFF_MAX_SECONDS = 60.0
MAX_CONFIG_BACKOFF_SECONDS = 600.0
MAX_CONFIG_BACKOFF_FACTOR = 10.0
# Unattended scheduled chats also ride a longer backoff curve: later ramp-up
# (5s base) and a much higher per-wait ceiling (10 min) because nobody is
# watching progress between attempts.
DEFAULT_SCHEDULED_BACKOFF_BASE_SECONDS = 5.0
DEFAULT_SCHEDULED_BACKOFF_MAX_SECONDS = 600.0
_FINAL_MARKER_WINDOW_CHARS = 500


@dataclass(frozen=True)
class ChatRetryConfig:
    enabled: bool = DEFAULT_ENABLED
    max_attempts: int = DEFAULT_MAX_ATTEMPTS
    scheduled_max_attempts: int = DEFAULT_SCHEDULED_MAX_ATTEMPTS
    backoff_base_seconds: float = DEFAULT_BACKOFF_BASE_SECONDS
    backoff_factor: float = DEFAULT_BACKOFF_FACTOR
    backoff_max_seconds: float = DEFAULT_BACKOFF_MAX_SECONDS
    scheduled_backoff_base_seconds: float = DEFAULT_SCHEDULED_BACKOFF_BASE_SECONDS
    scheduled_backoff_max_seconds: float = DEFAULT_SCHEDULED_BACKOFF_MAX_SECONDS

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": bool(self.enabled),
            "max_attempts": int(self.max_attempts),
            "scheduled_max_attempts": int(self.scheduled_max_attempts),
            "backoff_base_seconds": float(self.backoff_base_seconds),
            "backoff_factor": float(self.backoff_factor),
            "backoff_max_seconds": float(self.backoff_max_seconds),
            "scheduled_backoff_base_seconds": float(self.scheduled_backoff_base_seconds),
            "scheduled_backoff_max_seconds": float(self.scheduled_backoff_max_seconds),
        }


@dataclass(frozen=True)
class RecoverableErrorMatch:
    code: str
    label: str
    marker: str
    delay_scale: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "label": self.label,
            "marker": self.marker,
            "delay_scale": float(self.delay_scale),
        }


@dataclass(frozen=True)
class RecoverableErrorPattern:
    code: str
    label: str
    pattern: re.Pattern[str]
    # Multiplier applied on top of the global backoff curve: fast-families
    # (sse/json) retry quickly, environment-level failures wait longer.
    delay_scale: float = 1.0


_EXC_ERROR_PREFIX = r"!!!\s*Error:\s*(?:requests\.)?(?:exceptions\.)?"

# Status codes are decisive. Any tail opening with ``!!!Error: HTTP <code>``
# may only retry when <code> is in this set; every other status — regardless
# of keywords inside its body (a 403 that mentions "rate limit", a 528 saying
# "retry later") — is fatal and never reaches the keyword families below.
# Superset of the http_retryable regex below because 429 folds into the
# rate_limit family instead.
_RETRYABLE_HTTP_STATUSES = frozenset(
    (408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529)
)
_HTTP_STATUS_TAIL_RE = re.compile(r"!!!\s*Error:\s*HTTP\s+(\d{3})\b", re.IGNORECASE)
_ERROR_MARKER_RE = re.compile(r"!!!\s*Error:", re.IGNORECASE)

_RECOVERABLE_ERROR_PATTERNS = (
    RecoverableErrorPattern(
        code="rate_limit",
        label="RateLimitError",
        # HTTP 429 bodies fold into this family: quota windows are long, so
        # these retries get the deepest backoff multiplier. Status-bearing
        # tails were already screened by _RETRYABLE_HTTP_STATUSES above.
        pattern=re.compile(
            r"!!!\s*Error:\s*(?:[^\r\n]*rate[\s_-]?limit[^\r\n]*|HTTP\s+429\b[^\r\n]*)\s*\Z",
            re.IGNORECASE,
        ),
        delay_scale=8.0,
    ),
    RecoverableErrorPattern(
        code="http_retryable",
        label="HTTPError",
        pattern=re.compile(
            r"!!!\s*Error:\s*HTTP\s+(?:408|409|425|500|502|503|504|52[0-7]|529)\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
        delay_scale=2.0,
    ),
    RecoverableErrorPattern(
        code="upstream_failure",
        label="UpstreamFailure",
        # Gateways sometimes wrap upstream blowups in an HTTP 200 SSE stream
        # whose error-event message is bare free text like "Upstream request
        # failed" — no status code, no exception class — so none of the
        # status/keyword families above can fire. This last-mile family lets
        # such turns re-drive instead of ending fatal.
        pattern=re.compile(
            r"!!!\s*Error:\s*upstream[\s_-]*(?:request)?[\s_-]*(?:fail(?:ed|ure)?|fault)[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
        delay_scale=2.0,
    ),
    RecoverableErrorPattern(
        code="sse_error",
        label="SSEError",
        pattern=re.compile(
            r"!!!\s*Error:\s*SSE\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
        # Stream drops usually heal fast, but unattended runs tolerate a
        # longer pause; aligned with ssl_error at 4x.
        delay_scale=4.0,
    ),
    RecoverableErrorPattern(
        code="timeout",
        label="Timeout",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"(?:Read|Connect|Write)?Timeout\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
        delay_scale=1.5,
    ),
    RecoverableErrorPattern(
        code="connection_error",
        label="ConnectionError",
        pattern=re.compile(
            _EXC_ERROR_PREFIX + r"(?:ConnectionError|ProtocolError|ChunkedEncodingError)\b[^\r\n]*\s*\Z",
            re.IGNORECASE,
        ),
        delay_scale=2.5,
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
        delay_scale=4.0,
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
    try:
        scheduled_max_attempts = int(
            raw.get("scheduled_max_attempts", DEFAULT_SCHEDULED_MAX_ATTEMPTS)
        )
    except (TypeError, ValueError):
        scheduled_max_attempts = DEFAULT_SCHEDULED_MAX_ATTEMPTS
    scheduled_max_attempts = max(
        0, min(MAX_SCHEDULED_CONFIG_ATTEMPTS, scheduled_max_attempts)
    )
    backoff_base = _coerce_finite_float(raw.get("backoff_base_seconds"), DEFAULT_BACKOFF_BASE_SECONDS)
    backoff_base = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, backoff_base))
    backoff_factor = _coerce_finite_float(raw.get("backoff_factor"), DEFAULT_BACKOFF_FACTOR)
    backoff_factor = max(1.0, min(MAX_CONFIG_BACKOFF_FACTOR, backoff_factor))
    backoff_max = _coerce_finite_float(raw.get("backoff_max_seconds"), DEFAULT_BACKOFF_MAX_SECONDS)
    backoff_max = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, backoff_max))
    backoff_max = max(backoff_max, backoff_base)
    sched_base = _coerce_finite_float(
        raw.get("scheduled_backoff_base_seconds"), DEFAULT_SCHEDULED_BACKOFF_BASE_SECONDS
    )
    sched_base = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, sched_base))
    sched_backoff_max = _coerce_finite_float(
        raw.get("scheduled_backoff_max_seconds"), DEFAULT_SCHEDULED_BACKOFF_MAX_SECONDS
    )
    sched_backoff_max = max(0.0, min(MAX_CONFIG_BACKOFF_SECONDS, sched_backoff_max))
    sched_backoff_max = max(sched_backoff_max, sched_base)
    return ChatRetryConfig(
        enabled=enabled,
        max_attempts=max_attempts,
        scheduled_max_attempts=scheduled_max_attempts,
        backoff_base_seconds=backoff_base,
        backoff_factor=backoff_factor,
        backoff_max_seconds=backoff_max,
        scheduled_backoff_base_seconds=sched_base,
        scheduled_backoff_max_seconds=sched_backoff_max,
    )


def compute_backoff_delay(
    attempt_index: int,
    cfg: ChatRetryConfig,
    delay_scale: float = 1.0,
    *,
    jitter: bool = False,
    scheduled: bool = False,
) -> float:
    """Exponential backoff before retry ``attempt_index`` (0-based).

    ``delay = base * factor ** attempt_index * delay_scale``, clamped to the
    applicable cap (``backoff_max_seconds``, or its ``scheduled_*``
    counterpart when ``scheduled=True``). ``delay_scale`` lifts whole error
    families (e.g. rate limits) above the base curve. With ``jitter=True`` a
    uniform ±15% wobble is applied so simultaneous retries do not sync up.
    Never negative.
    """
    if scheduled:
        base = max(0.0, float(cfg.scheduled_backoff_base_seconds))
        cap = max(0.0, float(cfg.scheduled_backoff_max_seconds))
    else:
        base = max(0.0, float(cfg.backoff_base_seconds))
        cap = max(0.0, float(cfg.backoff_max_seconds))
    factor = max(1.0, float(cfg.backoff_factor))
    index = max(0, int(attempt_index))
    try:
        delay = base * (factor ** index)
    except OverflowError:
        delay = cap
    if jitter:
        lo, hi = _BACKOFF_JITTER_RANGE
        delay *= random.uniform(lo, hi)
    try:
        delay *= float(delay_scale)
    except (TypeError, ValueError):
        pass
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

    # A stream can contain more than one terminal-looking marker when an
    # upstream error is wrapped or appended during fanout.  Classification
    # must be based on the last marker, not on an earlier HTTP status in the
    # same bounded window.
    marker_matches = list(_ERROR_MARKER_RE.finditer(final_text))
    if not marker_matches:
        return None
    error_text = final_text[marker_matches[-1].start():]

    status_match = _HTTP_STATUS_TAIL_RE.match(error_text)
    if status_match and int(status_match.group(1)) not in _RETRYABLE_HTTP_STATUSES:
        # Explicit non-whitelisted HTTP status => fatal; body keywords
        # ("rate limit", "retry later", ...) never rescue such a tail.
        return None
    for spec in _RECOVERABLE_ERROR_PATTERNS:
        match = spec.pattern.search(error_text)
        if match:
            return RecoverableErrorMatch(
                code=spec.code,
                label=spec.label,
                marker=match.group(0),
                delay_scale=spec.delay_scale,
            )
    return None
