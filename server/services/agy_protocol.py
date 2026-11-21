"""ACP protocol normalization, permission policy, diff preview, and prompt builder.

Faithfully mirrors T3 Code's Antigravity ACP protocol layer
(`AntigravityAcpSupport`, `AntigravityProtocol`, `AntigravityClientFiles`,
`AntigravityEditLocation`, `clientPolicy`, `buildAntigravityPrompt`).
"""
from __future__ import annotations

import base64
import difflib
import mimetypes
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .agy_profile import AgyProfileError

PERMISSION_MODES = ("approval-required", "auto-accept-edits", "auto", "full-access")
EFFORT_VARIANTS = frozenset({"low", "medium", "high", "xhigh", "max"})

_READ_KINDS = frozenset({"read", "search", "think"})
_MUTATION_KINDS = frozenset({"edit", "delete", "move"})
_CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024
_PRE_EDIT_FILE_LIMIT = 1024 * 1024
_TOOL_TEXT_LIMIT = 8_000
_TOOL_TEXT_TRUNCATED = "[Earlier output truncated]\n\n"
_MAX_IMAGE_BYTES = 10 * 1024 * 1024
_MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024
_MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024
_MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024

_IMAGE_MIME_TYPES = frozenset({"image/bmp", "image/jpeg", "image/png", "image/webp"})
_AUDIO_MIME_TYPES = frozenset({
    "audio/aac", "audio/flac", "audio/mp3", "audio/mpeg", "audio/mp4",
    "audio/m4a", "audio/x-m4a", "audio/ogg", "audio/wav", "audio/x-wav", "audio/webm",
})
_TEXT_MIME_TYPES = frozenset({
    "application/json", "application/ld+json", "application/javascript",
    "application/typescript", "application/xml", "application/yaml",
    "application/x-yaml", "application/x-sh",
})
_TEXT_EXTENSIONS = frozenset({
    ".txt", ".md", ".mdx", ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
    ".csv", ".tsv", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".html",
    ".css", ".scss", ".less", ".py", ".rs", ".go", ".java", ".kt", ".swift",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".sh", ".bash",
    ".zsh", ".sql", ".graphql", ".svelte", ".vue", ".log", ".diff", ".patch",
    ".ini", ".conf",
})
_CLIENT_READ_TITLES = frozenset({"Running client_view_file", "Run client_view_file?"})
_SECURITY_WARNING_META_KEY = "agy.security.warning"


def parse_version(version: str | None) -> tuple[int, int, int] | None:
    if not version:
        return None
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version.strip())
    if not match:
        return None
    return int(match.group(1)), int(match.group(2)), int(match.group(3))


def client_info_for_version(version: str | None) -> dict[str, str]:
    """Older agy releases (<1.5.1) allowlist editor names like zed for non-Gemini models."""
    parsed = parse_version(version)
    if parsed is not None and parsed >= (1, 5, 1):
        return {"name": "ga-hub", "title": "GA-Hub", "version": "1.0.0"}
    return {"name": "zed", "version": "0.0.0"}


def supports_prompt_steering(init_result: dict[str, Any]) -> bool:
    info = init_result.get("agentInfo")
    parsed = parse_version(info.get("version") if isinstance(info, dict) else None)
    return parsed is not None and parsed >= (1, 5, 0)


def supports_system_prompt_append(init_result: dict[str, Any]) -> bool:
    caps = init_result.get("agentCapabilities")
    meta = caps.get("_meta") if isinstance(caps, dict) else None
    ag = meta.get("antigravity") if isinstance(meta, dict) else None
    sp = ag.get("systemPrompt") if isinstance(ag, dict) else None
    return isinstance(sp, dict) and sp.get("append") is True


def default_permission_mode(mode: str, permission_mode: str | None) -> str:
    if permission_mode in PERMISSION_MODES:
        return permission_mode
    return "approval-required"


def session_mode_for_policy(
    mode: str,
    permission_mode: str,
    available_modes: list[dict[str, Any]] | None = None,
) -> str:
    """Resolve the ACP `session/set_mode` wire ID (T3 Code antigravitySessionMode).

    The agy CLI rejects `yolo` and `auto_edit`; those stay in `default` where
    GA-Hub evaluates `session/request_permission` against live `permission_mode`.
    """
    available = {str(m.get("id")) for m in (available_modes or []) if isinstance(m, dict) and m.get("id")}
    if mode == "plan":
        if not available or "plan" in available:
            return "plan"
        return "default"
    if permission_mode == "auto" and "auto" in available:
        return "auto"
    if "default" in available or not available:
        return "default"
    return "accept-edits" if "accept-edits" in available else next(iter(available))


def _bound_text(text: str, limit: int = _TOOL_TEXT_LIMIT, *, tail: bool = False) -> str:
    if len(text) <= limit:
        return text
    if tail:
        return _TOOL_TEXT_TRUNCATED + text[-limit:]
    return text[: limit - 3] + "..."


def _is_within_roots(candidate: Path, roots: list[Path]) -> bool:
    try:
        real = Path(os.path.realpath(candidate))
    except OSError:
        return False
    for root in roots:
        try:
            real_root = Path(os.path.realpath(root))
            if real == real_root or real.is_relative_to(real_root):
                return True
        except OSError:
            continue
    return False


def _resolve_permission_path(raw: str, workspace: Path | None) -> Path | None:
    text = raw.strip()
    if not text:
        return None
    p = Path(text)
    if p.is_absolute():
        return p
    return (workspace / p) if workspace is not None else None


@dataclass
class RuntimeGrants:
    """Session-level allow_always grants accumulated during a conversation."""

    allow_all_kinds: set[str] = field(default_factory=set)
    allow_all_session: bool = False

    def record(self, kind: str) -> None:
        if kind:
            self.allow_all_kinds.add(kind)
        else:
            self.allow_all_session = True

    def allows(self, kind: str) -> bool:
        return self.allow_all_session or (kind in self.allow_all_kinds)


def is_user_input_request(params: dict[str, Any]) -> bool:
    """Native agy questions share `session/request_permission` with id `interaction_*`."""
    tool_call = params.get("toolCall")
    tid = tool_call.get("toolCallId") if isinstance(tool_call, dict) else None
    return isinstance(tid, str) and tid.startswith("interaction_")


def evaluate_permission(
    mode: str,
    permission_mode: str,
    params: dict[str, Any],
    grants: RuntimeGrants,
    workspace: Path | None,
    extra_roots: list[Path] | None = None,
) -> str:
    """Return 'allow', 'ask', or 'deny' per T3 Code's `clientPolicy` + `antigravityPermissionDisposition`."""
    if is_user_input_request(params):
        return "ask"
    tool_call = params.get("toolCall") or {}
    kind = str(tool_call.get("kind") or "other")
    if kind in _READ_KINDS:
        return "allow"
    if permission_mode == "full-access":
        return "allow"
    if grants.allows(kind):
        return "allow"
    if permission_mode == "auto":
        # agy's native Auto only sends what still needs confirmation.
        return "ask"
    if permission_mode == "auto-accept-edits":
        if kind in _MUTATION_KINDS:
            locations = tool_call.get("locations") or []
            roots = [r for r in [workspace, *(extra_roots or [])] if r is not None]
            if not locations and workspace is not None:
                raw_input = tool_call.get("rawInput") or {}
                for key in ("path", "TargetFile", "target_file", "file_path", "AbsolutePath"):
                    val = raw_input.get(key) if isinstance(raw_input, dict) else None
                    if isinstance(val, str) and val.strip():
                        locations = [{"path": val.strip()}]
                        break
            if roots and locations and all(
                isinstance(loc, dict)
                and isinstance(loc.get("path"), str)
                and (resolved := _resolve_permission_path(loc["path"], workspace)) is not None
                and _is_within_roots(resolved, roots)
                for loc in locations
            ):
                return "allow"
        return "ask"
    # approval-required (or plan mode falling through)
    return "ask"


def _security_warning(option: dict[str, Any]) -> str | None:
    meta = option.get("_meta")
    if not isinstance(meta, dict):
        return None
    warning = meta.get(_SECURITY_WARNING_META_KEY)
    if not isinstance(warning, dict):
        return None
    text = str(warning.get("message") or warning.get("title") or "").strip()
    return _bound_text(text, 512) if text else None


def extract_permission_prompt(
    params: dict[str, Any],
    pre_edit_reader: Any = None,
) -> dict[str, Any]:
    """Build structured UI/Nova prompt + wire option mapping from ACP `session/request_permission`."""
    tool_call = params.get("toolCall") if isinstance(params.get("toolCall"), dict) else {}
    options = [o for o in (params.get("options") or []) if isinstance(o, dict) and o.get("optionId")]
    kind = str(tool_call.get("kind") or "other")

    if is_user_input_request(params):
        question_text = str(tool_call.get("title") or "请选择一个选项").strip()
        q_options = [
            {
                "id": str(opt["optionId"]),
                "label": _bound_text(str(opt.get("name") or opt["optionId"]).strip(), 512),
            }
            for opt in options
        ]
        return {
            "prompt_type": "question",
            "tool_kind": kind,
            "title": "Agy 提问",
            "details": _bound_text(question_text, 2000),
            "question": {
                "question": _bound_text(question_text, 2000),
                "options": q_options,
            },
            "option_map": {opt["id"]: opt["id"] for opt in q_options},
            "default_option": q_options[-1]["id"] if q_options else None,
        }

    option_map: dict[str, str] = {}
    warning: str | None = None
    for opt in options:
        okind = opt.get("kind")
        oid = str(opt["optionId"])
        if okind == "allow_once" and "allow" not in option_map:
            option_map["allow"] = oid
        elif okind == "allow_always" and "allow_always" not in option_map:
            option_map["allow_always"] = oid
            warning = _security_warning(opt)
        elif okind == "reject_once" and "reject" not in option_map:
            option_map["reject"] = oid

    title = str(tool_call.get("title") or "请求执行操作").strip()
    raw_input = tool_call.get("rawInput") if isinstance(tool_call.get("rawInput"), dict) else {}
    locations = tool_call.get("locations") if isinstance(tool_call.get("locations"), list) else []
    detail_parts: list[str] = []
    cmd = _extract_command(raw_input, {})
    if cmd:
        detail_parts.append(cmd)
    for loc in locations:
        if isinstance(loc, dict) and isinstance(loc.get("path"), str) and loc["path"].strip():
            detail_parts.append(loc["path"].strip())
    if not detail_parts:
        for key in ("path", "TargetFile", "target_file", "file_path", "AbsolutePath", "url"):
            val = raw_input.get(key)
            if isinstance(val, str) and val.strip():
                detail_parts.append(val.strip())
                break
    details = " · ".join(dict.fromkeys(detail_parts)) or title

    diff_preview: str | None = None
    if kind == "edit":
        target_path = detail_parts[0] if detail_parts else ""
        if target_path:
            diff_preview = build_edit_patch(target_path, raw_input, locations, pre_edit_reader)

    return {
        "prompt_type": "approval",
        "tool_kind": kind,
        "title": _bound_text(title, 200),
        "details": _bound_text(details, 1000),
        "allow_always": "allow_always" in option_map,
        "security_warning": warning,
        "command": cmd,
        "diff": diff_preview,
        "option_map": option_map,
        "default_option": option_map.get("reject") or (str(options[-1]["optionId"]) if options else None),
    }


def handle_read_text_file(params: dict[str, Any], allowed_roots: list[Path]) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Serve ACP `fs/read_text_file` safely within allowed workspace/staging roots."""
    raw_path = params.get("path")
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None, {"code": -32602, "message": "Invalid params: missing path"}
    candidate = Path(raw_path.strip())
    if not candidate.is_absolute():
        candidate = (allowed_roots[0] / candidate) if allowed_roots else candidate
    if not _is_within_roots(candidate, allowed_roots):
        return None, {"code": -32602, "message": f"Path '{raw_path}' is outside the session workspace."}
    try:
        real = Path(os.path.realpath(candidate))
        st = real.stat()
        if not real.is_file() or st.st_size > _CLIENT_FILE_MAX_BYTES:
            return None, {"code": -32602, "message": f"File '{raw_path}' is not a readable text file."}
        raw = real.read_bytes()
        text = raw.decode("utf-8")
    except FileNotFoundError:
        return None, {"code": -32002, "message": f"File '{raw_path}' not found."}
    except UnicodeDecodeError:
        return None, {"code": -32602, "message": f"File '{raw_path}' is not UTF-8 text."}
    except OSError as exc:
        return None, {"code": -32603, "message": str(exc)}
    if "\0" in text:
        return None, {"code": -32602, "message": f"File '{raw_path}' contains binary data."}
    line = params.get("line")
    limit = params.get("limit")
    if line is None and limit is None:
        return {"content": text}, None
    lines = text.replace("\r\n", "\n").split("\n")
    start = max(0, (int(line) if isinstance(line, int) else 1) - 1)
    end = len(lines) if limit is None else min(len(lines), start + max(0, int(limit)))
    return {"content": "\n".join(lines[start:end])}, None


def read_pre_edit_file(path: str) -> str | None:
    try:
        p = Path(path)
        st = p.stat()
        if p.is_file() and st.st_size <= _PRE_EDIT_FILE_LIMIT:
            return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        pass
    return None


def _unique_start_line(text: str | None, snippet: str, start_hint: int | None, end_hint: int | None) -> int | None:
    if not text or not snippet:
        return None
    norm_text = text.replace("\r\n", "\n")
    norm_snip = snippet.replace("\r\n", "\n")
    matches: list[int] = []
    idx = 0
    while True:
        pos = norm_text.find(norm_snip, idx)
        if pos == -1:
            break
        line_no = norm_text.count("\n", 0, pos) + 1
        if (start_hint is None or line_no >= start_hint) and (end_hint is None or line_no <= end_hint):
            matches.append(line_no)
            if len(matches) > 1:
                return None
        idx = pos + 1
    return matches[0] if len(matches) == 1 else None


def build_edit_patch(
    path: str,
    raw_input: dict[str, Any] | None,
    locations: list[dict[str, Any]] | None = None,
    pre_edit_reader: Any = None,
) -> str | None:
    """Build a unified diff preview for Antigravity replace_file_content / multi_replace_file_content."""
    if not isinstance(raw_input, dict):
        return None
    chunks = raw_input.get("ReplacementChunks") or raw_input.get("replacement_chunks")
    if isinstance(chunks, list) and chunks:
        chunk_list = [c for c in chunks if isinstance(c, dict)]
    elif any(k in raw_input for k in ("TargetContent", "target_content", "ReplacementContent", "replacement_content")):
        chunk_list = [raw_input]
    else:
        return None
    if not chunk_list:
        return None
    file_text = pre_edit_reader(path) if callable(pre_edit_reader) else None
    diff_blocks: list[str] = []
    total_chars = 0
    for chunk in chunk_list:
        old = str(chunk.get("TargetContent") if chunk.get("TargetContent") is not None else chunk.get("target_content") or "")
        new = str(chunk.get("ReplacementContent") if chunk.get("ReplacementContent") is not None else chunk.get("replacement_content") or "")
        total_chars += len(old) + len(new)
        if total_chars > 64_000:
            return None
        start_hint = chunk.get("StartLine") or chunk.get("start_line")
        end_hint = chunk.get("EndLine") or chunk.get("end_line")
        if start_hint is None and len(chunk_list) == 1 and locations:
            loc_line = locations[0].get("line") if isinstance(locations[0], dict) else None
            if isinstance(loc_line, int) and loc_line > 0:
                start_hint = loc_line
        placed = _unique_start_line(
            file_text,
            old,
            start_hint if isinstance(start_hint, int) and start_hint > 0 else None,
            end_hint if isinstance(end_hint, int) and end_hint > 0 else None,
        )
        old_lines = old.replace("\r\n", "\n").splitlines(keepends=True)
        new_lines = new.replace("\r\n", "\n").splitlines(keepends=True)
        patch_lines = list(difflib.unified_diff(old_lines, new_lines, fromfile=path, tofile=path, n=2))
        if patch_lines:
            header_shifted = []
            for ln in patch_lines:
                if placed is not None and ln.startswith("@@ -"):
                    m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$", ln)
                    if m:
                        o_s = int(m.group(1)) + placed - 1
                        n_s = int(m.group(3)) + placed - 1
                        o_c = f",{m.group(2)}" if m.group(2) else ""
                        n_c = f",{m.group(4)}" if m.group(4) else ""
                        ln = f"@@ -{o_s}{o_c} +{n_s}{n_c} @@{m.group(5)}\n"
                header_shifted.append(ln)
            diff_blocks.append("".join(header_shifted))
    result = "\n".join(diff_blocks).strip()
    return _bound_text(result, _TOOL_TEXT_LIMIT) if result else None


def _extract_command(raw_input: dict[str, Any], raw_output: dict[str, Any]) -> str | None:
    for source in (raw_input, raw_output):
        if not isinstance(source, dict):
            continue
        for key in ("CommandLine", "command_line", "commandLine", "command"):
            val = source.get(key)
            if isinstance(val, str) and val.strip():
                return _bound_text(val.strip(), _TOOL_TEXT_LIMIT, tail=True)
    return None


def _extract_cwd(raw_input: dict[str, Any], raw_output: dict[str, Any]) -> str | None:
    for source in (raw_input, raw_output):
        if not isinstance(source, dict):
            continue
        for key in ("Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd"):
            val = source.get(key)
            if isinstance(val, str) and val.strip():
                return _bound_text(val.strip(), 512)
    return None


def _extract_diff_from_content(content: Any) -> str | None:
    if not isinstance(content, list):
        return None
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "diff":
            continue
        patch = item.get("patch")
        if isinstance(patch, dict) and isinstance(patch.get("text"), str) and patch["text"].strip():
            parts.append(patch["text"].strip())
            continue
        path = str(item.get("path") or "file")
        old = item.get("oldText")
        new = item.get("newText")
        if isinstance(old, str) and isinstance(new, str):
            diff_lines = list(difflib.unified_diff(
                old.splitlines(keepends=True),
                new.splitlines(keepends=True),
                fromfile=path,
                tofile=path,
                n=2,
            ))
            if diff_lines:
                parts.append("".join(diff_lines).strip())
    text = "\n\n".join(parts).strip()
    return _bound_text(text, _TOOL_TEXT_LIMIT) if text else None


def _map_tool_status(status: Any) -> str:
    if status in ("completed", "done"):
        return "DONE"
    if status in ("failed", "error"):
        return "FAILED"
    if status in ("cancelled", "canceled"):
        return "CANCELLED"
    return "ACTIVE"


class ReadRepair:
    """Ports T3 Code's `makeAntigravityReadRepair` for `client_view_file`."""

    def __init__(self) -> None:
        self._open_reads: dict[str, tuple[str, str | None]] = {}
        self._early_outcomes: list[tuple[str, bool]] = []

    def reset(self) -> None:
        self._open_reads.clear()
        self._early_outcomes.clear()

    def attempted(self, path: str, served: bool) -> str | None:
        for tid, (rpath, outcome) in list(self._open_reads.items()):
            if rpath == path and outcome is None:
                self._open_reads[tid] = (rpath, "served" if served else "refused")
                return tid if served else None
        self._early_outcomes.append((path, served))
        return None

    def track_update(self, update: dict[str, Any]) -> dict[str, Any]:
        title = update.get("title")
        tid = update.get("toolCallId")
        if not isinstance(tid, str) or not tid:
            return update
        if isinstance(title, str) and title in _CLIENT_READ_TITLES and tid not in self._open_reads:
            locs = update.get("locations") or []
            raw_in = update.get("rawInput") if isinstance(update.get("rawInput"), dict) else {}
            target = (locs[0].get("path") if locs and isinstance(locs[0], dict) else None) or raw_in.get("absolute_path")
            if isinstance(target, str) and target:
                outcome = None
                for idx, (epath, eserved) in enumerate(self._early_outcomes):
                    if epath == target:
                        self._early_outcomes.pop(idx)
                        outcome = "served" if eserved else "refused"
                        break
                self._open_reads[tid] = (target, outcome)
        entry = self._open_reads.get(tid)
        status = update.get("status")
        if entry and status in ("pending", "in_progress") and entry[1] == "served":
            return {**update, "status": "completed"}
        if status in ("completed", "failed"):
            self._open_reads.pop(tid, None)
            if status == "failed" and entry and entry[1] == "served":
                cleaned = {k: v for k, v in update.items() if k != "rawOutput"}
                cleaned["status"] = "completed"
                return cleaned
        return update


class SessionUpdateNormalizer:
    """Translates raw ACP `session/update` notifications into GA-Hub AntiEvent dicts."""

    def __init__(self, pre_edit_reader: Any = None) -> None:
        self._seq = 0
        self._next_step_idx = 0
        self._tool_indices: dict[str, int] = {}
        self._tool_snapshots: dict[str, dict[str, Any]] = {}
        self._thought_idx: int | None = None
        self._reply_idx: int | None = None
        self._plan_idx: int | None = None
        self._pre_edit_reader = pre_edit_reader or read_pre_edit_file
        self.answer_chunks: list[str] = []
        self.usage: dict[str, int] = {}
        self.available_commands: list[dict[str, Any]] = []
        self.config_options: list[dict[str, Any]] = []
        self.current_mode_id: str | None = None

    def _emit(self, event_type: str, **payload: Any) -> dict[str, Any]:
        self._seq += 1
        return {"seq": self._seq, "type": event_type, **payload}

    def _alloc_idx(self) -> int:
        idx = self._next_step_idx
        self._next_step_idx += 1
        return idx

    def emit_notice(self, tool: str, detail: str) -> dict[str, Any]:
        idx = self._alloc_idx()
        return self._emit(
            "step.update",
            step={
                "index": idx,
                "kind": "tool_call",
                "state": "DONE",
                "tool": _bound_text(tool, 128),
                "detail": _bound_text(detail, 512),
            },
        )

    def finish_turn(self) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        if self._thought_idx is not None:
            events.append(self._emit("step.update", step={"index": self._thought_idx, "kind": "thought", "state": "DONE"}))
            self._thought_idx = None
        if self._reply_idx is not None:
            events.append(self._emit("step.update", step={"index": self._reply_idx, "kind": "agent_response", "state": "DONE"}))
            self._reply_idx = None
        return events

    def normalize(self, update: dict[str, Any]) -> list[dict[str, Any]]:
        kind = update.get("sessionUpdate")
        events: list[dict[str, Any]] = []

        if kind == "agent_message_chunk":
            content = update.get("content")
            text = content.get("text") if isinstance(content, dict) and content.get("type") == "text" else None
            if isinstance(text, str) and text:
                self.answer_chunks.append(text)
                if self._thought_idx is not None:
                    events.append(self._emit("step.update", step={"index": self._thought_idx, "kind": "thought", "state": "DONE"}))
                    self._thought_idx = None
                if self._reply_idx is None:
                    self._reply_idx = self._alloc_idx()
                events.append(
                    self._emit(
                        "message.delta",
                        text=text,
                        step={"index": self._reply_idx, "kind": "agent_response", "state": "ACTIVE"},
                    )
                )
            return events

        if kind == "agent_thought_chunk":
            content = update.get("content")
            text = content.get("text") if isinstance(content, dict) and content.get("type") == "text" else None
            if isinstance(text, str) and text:
                if self._thought_idx is None:
                    self._thought_idx = self._alloc_idx()
                events.append(
                    self._emit(
                        "step.update",
                        step={
                            "index": self._thought_idx,
                            "kind": "thought",
                            "state": "ACTIVE",
                            "text_delta": text,
                        },
                    )
                )
            return events

        if kind in ("tool_call", "tool_call_update"):
            tid = str(update.get("toolCallId") or "")
            if not tid:
                return events
            if tid not in self._tool_indices:
                self._tool_indices[tid] = self._alloc_idx()
                self._tool_snapshots[tid] = {}
            idx = self._tool_indices[tid]
            prev = self._tool_snapshots[tid]
            merged = {**prev, **{k: v for k, v in update.items() if v is not None}}
            self._tool_snapshots[tid] = merged

            raw_input = merged.get("rawInput") if isinstance(merged.get("rawInput"), dict) else {}
            raw_output = merged.get("rawOutput") if isinstance(merged.get("rawOutput"), dict) else {}
            title = str(merged.get("title") or "").strip()
            tool_kind = str(merged.get("kind") or "other")
            command = _extract_command(raw_input, raw_output)
            cwd = _extract_cwd(raw_input, raw_output)
            output_text = raw_output.get("combinedOutput") or raw_output.get("combined_output")
            if output_text is None and isinstance(merged.get("rawOutput"), str):
                output_text = merged.get("rawOutput")
            exit_code = raw_output.get("exitCode") if raw_output.get("exitCode") is not None else raw_output.get("exit_code")
            diff_text = _extract_diff_from_content(merged.get("content"))
            if diff_text is None and tool_kind == "edit":
                locs = merged.get("locations") if isinstance(merged.get("locations"), list) else []
                target_path = (locs[0].get("path") if locs and isinstance(locs[0], dict) else None) or raw_input.get("path") or raw_input.get("TargetFile")
                if isinstance(target_path, str) and target_path:
                    diff_text = build_edit_patch(
                        target_path,
                        raw_input,
                        locs,
                        self._pre_edit_reader if merged.get("status") in (None, "pending", "in_progress") else None,
                    )

            step: dict[str, Any] = {
                "index": idx,
                "kind": "tool_call",
                "state": _map_tool_status(merged.get("status")),
                "tool": _bound_text(title or tool_kind, 128),
            }
            if command:
                step["command"] = command
            if cwd:
                step["cwd"] = cwd
            if isinstance(output_text, str) and output_text:
                step["output"] = _bound_text(output_text, _TOOL_TEXT_LIMIT, tail=True)
            if isinstance(exit_code, int):
                step["exit_code"] = exit_code
            if diff_text:
                step["diff"] = diff_text
            detail = command or (
                merged["locations"][0].get("path")
                if isinstance(merged.get("locations"), list)
                and merged["locations"]
                and isinstance(merged["locations"][0], dict)
                else None
            )
            if isinstance(detail, str) and detail:
                step["detail"] = _bound_text(detail, 512)
            events.append(self._emit("step.update", step=step))
            return events

        if kind == "plan":
            entries = update.get("entries")
            if isinstance(entries, list):
                if self._plan_idx is None:
                    self._plan_idx = self._alloc_idx()
                lines = []
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    mark = "[x]" if entry.get("status") == "completed" else "[-]" if entry.get("status") == "in_progress" else "[ ]"
                    lines.append(f"{mark} {entry.get('content', '')}".strip())
                if lines:
                    events.append(
                        self._emit(
                            "step.update",
                            step={
                                "index": self._plan_idx,
                                "kind": "planner_response",
                                "state": "DONE",
                                "text_delta": "\n".join(lines),
                            },
                        )
                    )
            return events

        if kind == "usage_update":
            for src, dst in (
                ("inputTokens", "input_tokens"),
                ("input_tokens", "input_tokens"),
                ("outputTokens", "output_tokens"),
                ("output_tokens", "output_tokens"),
                ("cachedReadTokens", "cache_read_tokens"),
                ("cacheReadTokens", "cache_read_tokens"),
                ("thinkingTokens", "thinking_tokens"),
                ("thoughtTokens", "thinking_tokens"),
            ):
                val = update.get(src)
                if isinstance(val, int) and val >= 0:
                    self.usage[dst] = val
            return events

        if kind == "available_commands_update":
            cmds = update.get("availableCommands")
            if isinstance(cmds, list):
                self.available_commands = cmds
            return events

        if kind == "config_option_update":
            opts = update.get("configOptions")
            if isinstance(opts, list):
                self.config_options = opts
            return events

        if kind == "current_mode_update":
            mid = update.get("currentModeId")
            if isinstance(mid, str) and mid:
                self.current_mode_id = mid
            return events

        return events


def build_prompt_blocks(
    prompt_text: str,
    staged_paths: list[Path],
    attachments: list[dict[str, Any]],
    prompt_capabilities: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build ACP content blocks (`text`, `image`, `audio`, `resource`, `resource_link`)."""
    caps = prompt_capabilities if isinstance(prompt_capabilities, dict) else {}
    blocks: list[dict[str, Any]] = []
    if prompt_text.strip():
        blocks.append({"type": "text", "text": prompt_text})

    # Staged files already referenced in prompt_text stay available via workspace/add-dir,
    # while explicit images/audio/small text attachments are embedded natively when supported.
    total_bytes = 0
    seen_paths: set[str] = set()
    for att in attachments:
        raw_path = str(att.get("path") or "").strip()
        if not raw_path or raw_path in seen_paths:
            continue
        p = Path(raw_path)
        if not p.is_file():
            continue
        seen_paths.add(raw_path)
        name = str(att.get("name") or p.name)
        mime, _ = mimetypes.guess_type(name)
        mime = (mime or "").lower()
        ext = p.suffix.lower()
        size = p.stat().st_size

        is_img = mime in _IMAGE_MIME_TYPES
        is_aud = mime in _AUDIO_MIME_TYPES
        is_pdf = mime == "application/pdf" or ext == ".pdf"
        is_txt = mime.startswith("text/") or mime in _TEXT_MIME_TYPES or ext in _TEXT_EXTENSIONS

        if is_img and caps.get("image") is True and size <= _MAX_IMAGE_BYTES and total_bytes + size <= _MAX_TOTAL_ATTACHMENT_BYTES:
            total_bytes += size
            data = base64.b64encode(p.read_bytes()).decode("ascii")
            blocks.append({"type": "image", "data": data, "mimeType": mime})
        elif is_aud and caps.get("audio") is True and size <= _MAX_AUDIO_ATTACHMENT_BYTES and total_bytes + size <= _MAX_TOTAL_ATTACHMENT_BYTES:
            total_bytes += size
            data = base64.b64encode(p.read_bytes()).decode("ascii")
            blocks.append({"type": "audio", "data": data, "mimeType": mime})
        elif caps.get("embeddedContext") is True and is_pdf and total_bytes + size <= _MAX_TOTAL_ATTACHMENT_BYTES:
            total_bytes += size
            blocks.append({
                "type": "resource_link",
                "uri": p.resolve().as_uri(),
                "name": name,
                "mimeType": "application/pdf",
                "size": size,
            })
        elif caps.get("embeddedContext") is True and is_txt and size <= _MAX_TEXT_ATTACHMENT_BYTES and total_bytes + size <= _MAX_TOTAL_ATTACHMENT_BYTES:
            try:
                decoded = p.read_text(encoding="utf-8")
                if "\0" not in decoded:
                    total_bytes += size
                    blocks.append({
                        "type": "resource",
                        "resource": {
                            "uri": p.resolve().as_uri(),
                            "mimeType": mime or "text/plain",
                            "text": decoded,
                        },
                    })
            except (OSError, UnicodeDecodeError):
                pass

    if not blocks:
        if staged_paths:
            blocks.append({"type": "text", "text": "请查看已附带的文件。"})
        else:
            raise AgyProfileError(422, "请输入内容或添加附件")
    return blocks


def extract_model_catalog_from_setup(setup_result: dict[str, Any]) -> list[dict[str, str]]:
    """Extract normalized `{id, display_name}` models from ACP `session/new` or `session/resume`."""
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    config_options = setup_result.get("configOptions")
    if isinstance(config_options, list):
        for opt in config_options:
            if not isinstance(opt, dict) or (opt.get("id") != "model" and opt.get("category") != "model"):
                continue
            for entry in opt.get("options") or []:
                if not isinstance(entry, dict):
                    continue
                if "options" in entry and isinstance(entry["options"], list):
                    for sub in entry["options"]:
                        val = sub.get("value") if isinstance(sub, dict) else None
                        if isinstance(val, str) and val and val not in seen:
                            seen.add(val)
                            items.append({"id": val, "display_name": str(sub.get("name") or val)})
                else:
                    val = entry.get("value")
                    if isinstance(val, str) and val and val not in seen:
                        seen.add(val)
                        items.append({"id": val, "display_name": str(entry.get("name") or val)})
    models_block = setup_result.get("models")
    if not items and isinstance(models_block, dict):
        for m in models_block.get("availableModels") or []:
            if isinstance(m, dict) and isinstance(m.get("modelId"), str) and m["modelId"] not in seen:
                seen.add(m["modelId"])
                items.append({"id": m["modelId"], "display_name": str(m.get("name") or m["modelId"])})
    return items


def select_model_and_effort_calls(
    setup_result: dict[str, Any],
    model: str,
    effort: str,
) -> list[tuple[str, dict[str, Any]]]:
    """Compute ACP RPC calls to apply model + thought_level across agy 1.3..1.5+."""
    calls: list[tuple[str, dict[str, Any]]] = []
    config_options = setup_result.get("configOptions")
    available = {m["id"] for m in extract_model_catalog_from_setup(setup_result)}

    family, _, suffix = model.rpartition("-")
    has_variant_suffix = bool(family and suffix.lower() in EFFORT_VARIANTS)

    target_model = model
    resolved_effort = suffix.lower() if has_variant_suffix else effort
    if available and model not in available and has_variant_suffix and family in available:
        target_model = family

    calls.append(("session/set_model", {"modelId": target_model}))

    if isinstance(config_options, list):
        for opt in config_options:
            if not isinstance(opt, dict) or opt.get("category") != "thought_level":
                continue
            cid = opt.get("id")
            values = {
                str(o.get("value"))
                for o in (opt.get("options") or [])
                if isinstance(o, dict) and o.get("value") is not None
            }
            if isinstance(cid, str) and resolved_effort in values:
                calls.append(("session/set_config_option", {"configId": cid, "value": resolved_effort}))
            break
    return calls
