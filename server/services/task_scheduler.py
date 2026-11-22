"""Generic scheduled task runner backed by APScheduler.

The shared singleton/lifecycle/persistence/CRUD skeleton lives in
``scheduler_domain_base.SchedulerDomainBase``; this module only carries the
task-specific schedule/run models and the error-commit
watcher semantics.
"""
from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any

from apscheduler.schedulers.background import BackgroundScheduler

from .. import _paths
from .event_bus import bus
from .scheduler_domain_base import (  # noqa: F401 — MISFIRE_GRACE_SECONDS re-exported for test seams
    MISFIRE_GRACE_SECONDS,
    SchedulerDomainBase,
)
from .system_channels import SystemChannel
from ..event_topics import (
    TASK_DELETE,
    TASK_DONE,
    TASK_ERROR,
    TASK_FIRED,
    TASK_UPSERT,
)

log = logging.getLogger(__name__)


@dataclass
class TaskSchedule:
    id: str
    type: str = "cron"              # cron | interval
    enabled: bool = True
    prompt: str = ""
    cron: str = "0 8 * * *"
    interval_minutes: int = 60
    last_fired_at: int = 0
    fire_count: int = 0
    name: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TaskRun:
    id: str
    task_id: str
    task_name: str
    fired_at: int
    stream_id: str = ""
    finished_at: int = 0
    status: str = "running"         # running | done | error | timeout
    prompt_preview: str = ""
    result_preview: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class TaskScheduler(SchedulerDomainBase):
    _instance: "TaskScheduler | None" = None

    schedule_cls = TaskSchedule
    display_name = "task scheduler"
    source = "scheduled_task"
    job_prefix = "task_"
    id_prefix = "task_"
    watch_prefix = "task"
    topic_fired = TASK_FIRED
    topic_upsert = TASK_UPSERT
    topic_delete = TASK_DELETE

    # The scheduled-task system channel: admission goes through the same
    # SessionCoordinator gate as web sessions (merge of the two chat chains);
    # ``channel`` duck-types the AgentService submit surface.
    def __init__(
        self,
        channel: SystemChannel,
        *,
        scheduler_runtime: Any | None = None,
    ):
        super().__init__(channel, scheduler_runtime=scheduler_runtime)

    # ── persistence paths ────────────────────────────────────────
    def _sched_file(self) -> str:
        return str(_paths.tasks_schedules_file())

    def _runs_file(self) -> str:
        return str(_paths.tasks_runs_file())

    def _new_runtime(self) -> BackgroundScheduler:
        return BackgroundScheduler(timezone=self._tz) if self._tz else BackgroundScheduler()

    # ── fire hooks ───────────────────────────────────────────────
    def _build_run(self, s: TaskSchedule, now: int, handle: Any, prompt: str) -> TaskRun:
        return TaskRun(
            id=uuid.uuid4().hex,
            task_id=s.id,
            task_name=s.name,
            fired_at=now,
            stream_id=handle.stream_id,
            prompt_preview=prompt[:160],
        )

    def _fired_payload(self, s: TaskSchedule, run: TaskRun, handle: Any, now: int) -> dict:
        return {
            "task_id": s.id, "task_name": s.name, "run_id": run.id,
            "stream_id": handle.stream_id, "fired_at": now,
        }

    def _watch_deadline_reached(self, run: TaskRun) -> bool:
        # The one-hour watch deadline mirrors the autonomous domain.
        if time.time() > (run.fired_at + 60 * 60):
            run.status = "timeout"
            run.note = "watch_timeout"
            return True
        return False

    def _finalize_run(self, s: TaskSchedule, run: TaskRun, handle: Any, context: Any) -> None:
        raw_final = (
            getattr(handle, "run_final_text", "")
            or getattr(handle, "final_text", "")
            or getattr(handle, "last_chunk", "")
            or ""
        )
        raw_partial = getattr(handle, "last_chunk", "") or ""
        if handle.finished:
            run.status = "done"
            run.finished_at = int(time.time())
            run.result_preview = extract_task_result_preview(raw_final)
        else:
            run.finished_at = int(time.time())
            run.result_preview = extract_task_result_preview(raw_partial)

        def commit_done() -> None:
            self._record_run(run)
            bus.publish(TASK_DONE, run.to_dict())

        self._watchers.run_if_active(commit_done)

    def _on_watch_crash(
        self, s: TaskSchedule, run: TaskRun, stop_event: threading.Event, exc: Exception,
    ) -> None:
        if stop_event.is_set():
            return
        run.status = "error"
        run.finished_at = int(time.time())
        run.note = str(exc)[:400]

        def commit_error() -> None:
            self._record_run(run)
            bus.publish(TASK_ERROR, run.to_dict())

        self._watchers.run_if_active(commit_error)

    def _apply_upsert_defaults(self, base: dict) -> None:
        if not base.get("cron"):
            base["cron"] = "0 8 * * *"

_FINAL_MARKER_RE = re.compile(
    r"\n*(?:`{3,5}[^\r\n]*\r?\n?)?\[Info\]\s*Final response to user\.\s*(?:\r?\n?`{3,5})?\s*$",
    re.IGNORECASE,
)
_TURN_MARKER_RE = re.compile(r"(?:\*\*)?LLM Running \(Turn \d+\) \.\.\.(?:\*\*)?", re.IGNORECASE)
_META_TAG_RE = re.compile(r"<(summary|thinking|think|analysis)>", re.IGNORECASE)
_TOOL_HEADER_RE = re.compile(r"🛠️?\s*Tool\s*[:：]\s*`([\w.-]+)`(?:[ \t]*📥[ \t]*args:)?", re.IGNORECASE)
_COMPACT_TOOL_RE = re.compile(r"🛠️?\s*([\w.-]+)\s*\(")
_FENCE_EDGE_RE = re.compile(r"[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|$)")
_STATUS_LINE_RE = re.compile(
    r"^[ \t]*\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\][^\r\n]*$",
    re.IGNORECASE | re.MULTILINE,
)
_THINKING_BLOCK_RE = re.compile(
    r"<(thinking|think|analysis)>[\s\S]*?(?:</\1>|$)",
    re.IGNORECASE,
)
_SUMMARY_BLOCK_RE = re.compile(
    r"<summary>[\s\S]*?</summary>",
    re.IGNORECASE,
)
_OPEN_SUMMARY_RE = re.compile(r"<summary>[\s\S]*$", re.IGNORECASE)


def _balanced_call_end(source: str, start: int) -> int | None:
    depth = 1
    quoted = False
    escaped = False
    for idx in range(start, len(source)):
        ch = source[idx]
        if escaped:
            escaped = False
            continue
        if quoted and ch == "\\":
            escaped = True
            continue
        if ch == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return idx + 1
    return None


def _fence_end(source: str, start: int) -> int:
    open_match = _FENCE_EDGE_RE.match(source, start)
    if not open_match:
        return start
    fence = open_match.group(1)
    char = fence[0]
    size = len(fence)
    close_re = re.compile(rf"^[ \t]*{re.escape(char)}{{{size},}}[ \t]*$")
    glued_re = re.compile(rf"(?<!`){'`' * size}[ \t]*$") if char == "`" else None
    pos = open_match.end()
    n = len(source)
    while pos < n:
        nl = source.find("\n", pos)
        end = n if nl < 0 else nl + 1
        line = source[pos:end].rstrip("\r\n")
        if close_re.match(line):
            return end
        if glued_re and (glued := glued_re.search(line)) and glued.start() > 0:
            return end
        pos = end
    return n


def _skip_tool_fences(source: str, pos: int) -> int:
    n = len(source)
    while pos < n:
        ws = pos
        while ws < n and source[ws].isspace():
            ws += 1
        edge = _FENCE_EDGE_RE.match(source, ws)
        if edge and edge.group(1).startswith("`") and len(edge.group(1)) >= 4:
            pos = _fence_end(source, ws)
            continue
        if ws < n and re.fullmatch(r"`{1,3}", source[ws:]):
            return n
        break
    return pos


def _split_top_level_turns(source: str) -> list[str]:
    turns: list[str] = []
    cur_start = 0
    pos = 0
    n = len(source)
    while pos < n:
        line_start = pos == 0 or source[pos - 1] == "\n"
        if line_start and _FENCE_EDGE_RE.match(source, pos):
            pos = _fence_end(source, pos)
            continue
        m_turn = _TURN_MARKER_RE.match(source, pos)
        if m_turn:
            seg = source[cur_start:pos].strip()
            if seg:
                turns.append(seg)
            pos = m_turn.end()
            cur_start = pos
            continue
        m_meta = _META_TAG_RE.match(source, pos)
        if m_meta:
            tag = m_meta.group(1)
            close = re.search(rf"</{re.escape(tag)}>", source[m_meta.end():], re.IGNORECASE)
            pos = m_meta.end() + close.end() if close else n
            continue
        pos += 1
    tail = source[cur_start:].strip()
    if tail:
        turns.append(tail)
    return turns


def _extract_turn_conclusion(turn_text: str) -> tuple[str, list[str]]:
    """Return ``(conclusion_after_last_tool, summaries)`` for one turn."""
    summaries: list[str] = []
    prose_after_tool: list[str] = []
    last_tool_seen = False
    pos = 0
    n = len(turn_text)
    while pos < n:
        line_start = pos == 0 or turn_text[pos - 1] == "\n"
        m_meta = _META_TAG_RE.match(turn_text, pos)
        if m_meta:
            tag = m_meta.group(1).lower()
            inner_start = m_meta.end()
            close = re.search(rf"</{re.escape(tag)}>", turn_text[inner_start:], re.IGNORECASE)
            if close:
                if tag == "summary":
                    collapsed = " · ".join(
                        line.strip()
                        for line in turn_text[inner_start:inner_start + close.start()].splitlines()
                        if line.strip()
                    )
                    if collapsed:
                        summaries.append(collapsed)
                pos = inner_start + close.end()
            else:
                pos = n
            continue

        tool_header = _TOOL_HEADER_RE.match(turn_text, pos)
        if tool_header:
            suffix = turn_text[tool_header.end():].lstrip(" \t")
            if suffix and not (
                suffix.startswith(("📥", "`", "\n", "\r"))
                or "📥 args:".startswith(suffix)
            ):
                tool_header = None
        compact = (
            _COMPACT_TOOL_RE.match(turn_text, pos)
            if (tool_header is None and line_start)
            else None
        )
        if tool_header or compact:
            if tool_header:
                end = tool_header.end()
                complete = True
            else:
                assert compact is not None
                balanced = _balanced_call_end(turn_text, compact.end())
                end = balanced if balanced is not None else n
                complete = balanced is not None
            if complete:
                end = _skip_tool_fences(turn_text, end)
            last_tool_seen = True
            prose_after_tool.clear()
            pos = end
            continue

        if line_start and _FENCE_EDGE_RE.match(turn_text, pos):
            end = _fence_end(turn_text, pos)
            # Standalone 4+-backtick fenced blocks when preceded by no prose are
            # typically orphaned tool outputs; treat normal >=3 fences after text
            # as part of the conclusion prose.
            prose_after_tool.append(turn_text[pos:end])
            pos = end
            continue

        next_special = n
        for token in ("<", "🛠️", "`", "~"):
            found = turn_text.find(token, pos + 1)
            if 0 <= found < next_special:
                next_special = found
        nl = turn_text.find("\n", pos + 1)
        if 0 <= nl < next_special:
            next_special = nl + 1
        prose_after_tool.append(turn_text[pos:next_special])
        pos = next_special

    raw_conclusion = "".join(prose_after_tool)
    raw_conclusion = _STATUS_LINE_RE.sub("", raw_conclusion)
    raw_conclusion = _THINKING_BLOCK_RE.sub("", raw_conclusion)
    raw_conclusion = _SUMMARY_BLOCK_RE.sub("", raw_conclusion)
    raw_conclusion = _OPEN_SUMMARY_RE.sub("", raw_conclusion).strip()
    if last_tool_seen and not raw_conclusion:
        return "", summaries
    return raw_conclusion, summaries


def extract_task_result_preview(raw: str, *, limit: int = 500) -> str:
    """Extract the final conclusion preview from a GA multi-turn transcript.

    Prefers the last turn's conclusion prose after any tool dumps; when no turn
    carries trailing prose (e.g. tool-only/interrupted runs), falls back to the
    last ``<summary>`` instead of slicing Turn 1's opening process summary.
    """
    text = _FINAL_MARKER_RE.sub("", (raw or "")).strip()
    if not text:
        return ""
    turns = _split_top_level_turns(text)
    if not turns:
        turns = [text]

    parsed = [_extract_turn_conclusion(turn) for turn in turns]
    chosen = ""
    for conclusion, _summaries in reversed(parsed):
        if conclusion:
            chosen = conclusion
            break
    if not chosen:
        all_summaries = [s for _c, sums in parsed for s in sums if s]
        if all_summaries:
            chosen = all_summaries[-1]
    if not chosen:
        cleaned = _TURN_MARKER_RE.sub(" ", text)
        cleaned = _THINKING_BLOCK_RE.sub("", cleaned)
        cleaned = _SUMMARY_BLOCK_RE.sub(" ", cleaned)
        cleaned = _OPEN_SUMMARY_RE.sub("", cleaned)
        chosen = cleaned.strip()

    chosen = re.sub(r"\n{3,}", "\n\n", chosen).strip()
    return chosen[:limit]