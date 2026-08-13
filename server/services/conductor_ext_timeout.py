"""Hub-only Conductor output budgets and timeout warnings (Phase C.2)."""
from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable
from typing import Any


Publish = Callable[[str, dict], Any]
TokenCounter = Callable[[str], int]


class OutputBudget:
    """Bound one subagent's accumulated output without a tokenizer dependency.

    The default counts Unicode code points.  It is intentionally conservative
    for ordinary English and Chinese text, and callers may inject an exact
    tokenizer later without changing the orchestration path.
    """

    MARKER = "[output truncated by Conductor budget]"

    def __init__(
        self,
        agent_id: str,
        *,
        max_tokens: int = 12_000,
        max_lines: int = 2_000,
        token_counter: TokenCounter = len,
        publish: Publish | None = None,
    ) -> None:
        if max_tokens < 1 or max_lines < 1:
            raise ValueError("output limits must be positive")
        self.agent_id = agent_id
        self.max_tokens = max_tokens
        self.max_lines = max_lines
        self.token_counter = token_counter
        self.publish = publish
        self.output = ""
        self.truncated = False

    def append(self, chunk: str) -> str:
        """Append a stream chunk and return the complete bounded output."""
        if self.truncated or not chunk:
            return self.output

        candidate = self.output + chunk
        token_hit = self.token_counter(candidate) > self.max_tokens
        line_hit = candidate.count("\n") + 1 > self.max_lines
        if not token_hit and not line_hit:
            self.output = candidate
            return self.output

        base = self.output
        low, high = 0, len(chunk)
        while low < high:
            middle = (low + high + 1) // 2
            trial = base + chunk[:middle]
            fits_tokens = self.token_counter(trial) <= self.max_tokens
            fits_lines = trial.count("\n") + 1 <= self.max_lines
            if fits_tokens and fits_lines:
                low = middle
            else:
                high = middle - 1

        kept = chunk[:low]
        bounded = base + kept
        self.output = bounded + self.MARKER
        self.truncated = True
        if self.publish is not None:
            self.publish("conductor:subagent_timeout_output", {
                "id": self.agent_id,
                "max_tokens": self.max_tokens,
                "max_lines": self.max_lines,
                "estimated_tokens": self.token_counter(bounded),
                "lines": bounded.count("\n") + 1,
            })
        return self.output

    def finish(self, final_output: str) -> str:
        """Reconcile a final full response with chunks already observed."""
        if self.truncated:
            return self.output
        if final_output.startswith(self.output):
            return self.append(final_output[len(self.output):])
        self.output = ""
        return self.append(final_output)


class TimeoutMonitor:
    """Emit one warning per running subagent and timeout kind; never kill it."""

    def __init__(
        self,
        core: Any,
        *,
        silence_timeout: float = 120.0,
        total_timeout: float = 600.0,
        check_interval: float = 10.0,
        publish: Publish | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        if min(silence_timeout, total_timeout, check_interval) <= 0:
            raise ValueError("timeouts and check interval must be positive")
        self.core = core
        self.silence_timeout = silence_timeout
        self.total_timeout = total_timeout
        self.check_interval = check_interval
        self.publish = publish
        self.clock = clock
        self._emitted: set[tuple[str, str]] = set()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def _states(self) -> Iterable[Any]:
        lock = getattr(self.core, "lock", None)
        if lock is None:
            return list(getattr(self.core, "subagents", {}).values())
        with lock:
            return list(getattr(self.core, "subagents", {}).values())

    def check_once(self) -> list[tuple[str, str]]:
        """Evaluate current state and return newly emitted ``(id, kind)`` pairs."""
        now = self.clock()
        emitted: list[tuple[str, str]] = []
        for state in self._states():
            if getattr(state, "status", None) != "running":
                continue
            agent_id = str(state.id)
            checks = (
                ("silence", now - float(state.updated_at), self.silence_timeout),
                ("total", now - float(state.created_at), self.total_timeout),
            )
            for kind, elapsed, limit in checks:
                key = (agent_id, kind)
                if elapsed < limit or key in self._emitted:
                    continue
                self._emitted.add(key)
                emitted.append(key)
                if self.publish is not None:
                    self.publish(f"conductor:subagent_timeout_{kind}", {
                        "id": agent_id,
                        "elapsed_seconds": elapsed,
                        "limit_seconds": limit,
                        "action": "warning_only",
                    })
        return emitted

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run, name="conductor-timeout-monitor", daemon=True
        )
        self._thread.start()

    def stop(self, timeout: float = 1.0) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(0.0, timeout))

    def _run(self) -> None:
        while not self._stop.wait(self.check_interval):
            self.check_once()
