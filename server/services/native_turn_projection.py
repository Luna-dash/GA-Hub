"""Project GA's native queue turn/outputs window, never parse display text."""
from __future__ import annotations

from .archive_turn_segments import valid_turn_segments


class NativeTurnProjection:
    def __init__(self) -> None:
        self._turns: list[str] = []

    def update(self, item: dict, content: str, *, final: bool = False) -> list[str] | None:
        turn, outputs = item.get("turn"), item.get("outputs")
        if (type(turn) is not int or turn < 1 or not isinstance(outputs, list)
                or not outputs or any(not isinstance(s, str) for s in outputs)):
            return None
        if final:
            # done carries all turns, next only the last two. A native error
            # trailer may follow the outputs; it belongs to the last real turn.
            if len(outputs) != turn:
                return None
            candidate = outputs.copy()
            joined = "".join(candidate)
            if joined and content.startswith(joined):
                candidate[-1] += content[len(joined):]
        else:
            if len(outputs) != min(turn, 2) or turn > len(self._turns) + 1:
                return None
            start = turn - len(outputs)
            candidate = self._turns[:start] + outputs
        valid = valid_turn_segments(candidate, content)
        if valid is not None:
            self._turns = valid.copy()
        return valid
