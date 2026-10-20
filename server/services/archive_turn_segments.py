"""Validate optional GA turn boundaries without changing message text or identity."""
from typing import Any


def valid_turn_segments(value: Any, content: Any, role: str = "assistant") -> list[str] | None:
    """All-or-nothing: partial salvage could silently discard a real turn."""
    if role != "assistant" or not isinstance(value, list) or not value:
        return None
    if not all(isinstance(part, str) and part.strip() for part in value):
        return None
    return list(value) if isinstance(content, str) and "".join(value) == content else None
