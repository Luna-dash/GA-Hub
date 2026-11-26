"""ACP protocol normalization, permission policy, diff preview, and prompt builder.

Faithfully mirrors T3 Code's Antigravity ACP protocol layer
(`AntigravityAcpSupport`, `AntigravityProtocol`, `AntigravityClientFiles`,
`AntigravityEditLocation`, `clientPolicy`, `buildAntigravityPrompt`).
"""
from __future__ import annotations

import base64
import binascii
import difflib
import json
import math
import mimetypes
import os
import re
import sqlite3
import stat
import time
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Literal
from urllib.parse import unquote, urlsplit

from .agy_profile import AgyProfileError

PERMISSION_MODES = ("approval-required", "auto-accept-edits", "auto", "full-access")
EFFORT_VARIANTS = frozenset({"low", "medium", "high", "xhigh", "max"})

PROMPT_ACTIVITY_UPDATES = frozenset({
    "agent_message",
    "agent_message_chunk",
    "agent_thought",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "tool_call_content_chunk",
    "terminal_output_chunk",
    "terminal_update",
    "plan",
    "plan_update",
    "plan_removed",
    "compaction_update",
    "compaction_summary_chunk",
})

_READ_KINDS = frozenset({"read", "search", "think"})
_MUTATION_KINDS = frozenset({"edit", "delete", "move"})
_CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024
_PRE_EDIT_FILE_LIMIT = 1024 * 1024
_TOOL_TEXT_LIMIT = 8_000
_TOOL_TEXT_TRUNCATED = "[Earlier output truncated]\n\n"
_MAX_TERMINAL_OUTPUT_BYTES = 128 * 1024
_MAX_TERMINAL_FRAME_BYTES = 4 * 1024 * 1024
_TERMINAL_EMIT_INTERVAL = 0.25
_BACKGROUND_TOOL_MARKERS = ("invoke_subagent", "subagent", "schedule", "monitor", "background", "command_status")
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


class AgyModelSelectionError(AgyProfileError):
    """Raised when the active profile rejects or lacks the requested model without breaking the ACP session."""

    def __init__(self, model: str, detail: str | None = None):
        self.model = model
        super().__init__(422, detail or f"当前账号不支持模型「{model}」，请切换其他可用模型后重试。")


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

    def snapshot(self) -> list[str]:
        if self.allow_all_session:
            return ["*"]
        return sorted(self.allow_all_kinds)

    def clear(self, kind: str | None = None) -> None:
        if kind is None or kind == "*":
            self.allow_all_kinds.clear()
            self.allow_all_session = False
        else:
            self.allow_all_kinds.discard(kind)


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


def _trailing_incomplete_utf8_start(data: bytes) -> int:
    if not data:
        return 0
    lead_idx = len(data) - 1
    while lead_idx >= 0 and (data[lead_idx] & 0xC0) == 0x80:
        lead_idx -= 1
    if lead_idx < 0:
        return len(data)
    lead = data[lead_idx]
    if 0xC2 <= lead <= 0xDF:
        expected = 2
    elif 0xE0 <= lead <= 0xEF:
        expected = 3
    elif 0xF0 <= lead <= 0xF4:
        expected = 4
    else:
        expected = 1
    return lead_idx if (len(data) - lead_idx) < expected else len(data)


def _decode_terminal_chunk(pending: bytes, encoded: str) -> tuple[str, bytes] | None:
    if not isinstance(encoded, str):
        return None
    if len(encoded) > ((_MAX_TERMINAL_FRAME_BYTES + 2) // 3) * 4:
        return None
    try:
        frame = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error):
        return None
    if len(frame) > _MAX_TERMINAL_FRAME_BYTES:
        return None
    combined = pending + frame
    complete_end = _trailing_incomplete_utf8_start(combined)
    text = combined[:complete_end].decode("utf-8", errors="replace")
    return text, bytes(combined[complete_end:])


def _trim_utf8_tail(text: str, max_bytes: int) -> str:
    if max_bytes <= 0:
        return ""
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    tail = encoded[-max_bytes:]
    start = 0
    while start < len(tail) and (tail[start] & 0xC0) == 0x80:
        start += 1
    return tail[start:].decode("utf-8", errors="ignore")


def _embedded_terminal_ids(content: Any) -> list[str]:
    if not isinstance(content, list):
        return []
    out: list[str] = []
    for entry in content:
        if isinstance(entry, dict) and entry.get("type") == "terminal":
            tid = entry.get("terminalId")
            if isinstance(tid, str) and tid and tid not in out:
                out.append(tid)
    return out


def _extract_terminal_exit_code(exit_status: Any) -> int | None:
    if not isinstance(exit_status, dict):
        return None
    val = exit_status.get("exitCode") if exit_status.get("exitCode") is not None else exit_status.get("exit_code")
    return val if isinstance(val, int) and not isinstance(val, bool) else None


def _has_truncated_text(value: Any) -> bool:
    if isinstance(value, str):
        return value.startswith(_TOOL_TEXT_TRUNCATED)
    if isinstance(value, dict):
        return any(_has_truncated_text(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_truncated_text(v) for v in value)
    return False


_DATA_IMAGE_URL_RE = re.compile(r"^data:image/", re.I)
_IMAGE_PREVIEW_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"})


def sanitize_tool_payload(payload: Any, *, max_nodes: int = 512, max_text: int = 64_000) -> Any:
    """Bound ACP tool payload depth, node count, and total text while stripping inline base64 images."""
    budget = [max_nodes, max_text]

    def _walk(value: Any, depth: int, field: str | None = None) -> Any:
        if depth > 12 or budget[0] <= 0:
            return None
        budget[0] -= 1
        if isinstance(value, str):
            if _DATA_IMAGE_URL_RE.match(value) or budget[1] <= 0:
                return None
            limit = min(_TOOL_TEXT_LIMIT, budget[1])
            # Always tail-truncate with _TOOL_TEXT_TRUNCATED (T3 Code boundText) so
            # edit patch previewers reliably detect truncated TargetContent/ReplacementContent.
            text = _bound_text(value, limit, tail=True)
            budget[1] -= len(text)
            return text
        if isinstance(value, list):
            out_list: list[Any] = []
            for entry in value:
                if budget[0] <= 0:
                    break
                item = _walk(entry, depth + 1)
                if item is not None:
                    out_list.append(item)
            return out_list
        if not isinstance(value, dict):
            return value
        out_dict: dict[str, Any] = {}
        for key, entry in value.items():
            if budget[0] <= 0:
                break
            if (
                (value.get("type") == "image" and key in ("data", "blob"))
                or (key == "blob" and isinstance(value.get("mimeType"), str) and value["mimeType"].startswith("image/"))
                or (
                    key in ("formatted_output", "formattedOutput")
                    and (entry == value.get("combinedOutput") or entry == value.get("combined_output"))
                )
            ):
                continue
            cleaned = _walk(entry, depth + 1, key)
            if cleaned is not None:
                out_dict[key] = cleaned
        return out_dict

    return _walk(payload, 0)


def extract_local_image_path(image_path: Any) -> str | None:
    """Extract a safe local image path or file URI from Antigravity `rawOutput.imagePath`."""
    if not isinstance(image_path, str) or not image_path.strip() or len(image_path) > _TOOL_TEXT_LIMIT:
        return None
    raw = image_path.strip()
    if raw.lower().startswith("file://"):
        parsed = urlsplit(raw)
        if parsed.netloc and parsed.netloc.lower() != "localhost":
            return None
        pathname = unquote(parsed.path or "")
        if re.match(r"^/[a-zA-Z]:/", pathname):
            pathname = pathname[1:]
        raw = pathname
    elif re.match(r"^[a-zA-Z][a-zA-Z\d+.-]*:", raw) and not re.match(r"^[a-zA-Z]:[\\/]", raw):
        return None
    if not raw or Path(raw).suffix.lower() not in _IMAGE_PREVIEW_EXTS:
        return None
    return raw


def _is_mcp_tool_call(snapshot: dict[str, Any], update: dict[str, Any] | None = None) -> bool:
    for source in (update, snapshot):
        if isinstance(source, dict):
            meta = source.get("_meta")
            if isinstance(meta, dict) and meta.get("is_mcp_tool_call") is True:
                return True
    return False


def is_background_outliving_tool(
    snapshot: dict[str, Any],
    terminals: dict[str, dict[str, Any]] | None = None,
) -> bool:
    """Return True when an active tool represents background work that may outlive `session/prompt`."""
    if _map_tool_status(snapshot.get("status")) != "ACTIVE":
        return False
    if _is_mcp_tool_call(snapshot):
        return False
    if terminals:
        for term_id in _embedded_terminal_ids(snapshot.get("content")):
            term = terminals.get(term_id)
            if term is not None and term.get("exit_status") is None:
                return True
    raw_input = snapshot.get("rawInput") if isinstance(snapshot.get("rawInput"), dict) else {}
    for key in ("IsDaemon", "isDaemon", "background", "WaitMsBeforeAsync", "DurationSeconds", "CronExpression"):
        if raw_input.get(key):
            return True
    title_low = str(snapshot.get("title") or "").strip().lower()
    raw_tool = str(raw_input.get("ToolName") or raw_input.get("tool") or "").strip().lower()
    if any(marker in title_low or marker in raw_tool for marker in _BACKGROUND_TOOL_MARKERS):
        return True
    kind = str(snapshot.get("kind") or "").strip().lower()
    if kind == "execute" and "run_command" in title_low and (raw_input.get("WaitMsBeforeAsync") or raw_input.get("IsDaemon")):
        return True
    return False


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


_USAGE_FIELD_GROUPS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("input_tokens", ("inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "promptTokenCount")),
    (
        "output_tokens",
        (
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
            "candidatesTokens",
            "candidates_tokens",
            "candidatesTokenCount",
        ),
    ),
    (
        "cache_read_tokens",
        (
            "cachedReadTokens",
            "cacheReadTokens",
            "cache_read_tokens",
            "cache_read_input_tokens",
            "cachedContentTokenCount",
        ),
    ),
    (
        "cache_write_tokens",
        (
            "cachedWriteTokens",
            "cacheWriteTokens",
            "cache_write_tokens",
            "cacheCreationTokens",
            "cache_creation_tokens",
            "cache_creation_input_tokens",
        ),
    ),
    (
        "thinking_tokens",
        (
            "thinkingTokens",
            "thoughtTokens",
            "thoughtsTokens",
            "thinking_tokens",
            "thoughts_tokens",
            "thoughtsTokenCount",
        ),
    ),
)
_TOTAL_TOKEN_KEYS = ("totalTokens", "total_tokens", "totalTokenCount")
_ANTHROPIC_EXCLUSIVE_CACHE_KEYS = frozenset({"cache_read_input_tokens", "cache_creation_input_tokens"})
_ACP_EXCLUSIVE_CACHE_KEYS = frozenset({
    "cachedReadTokens",
    "cacheReadTokens",
    "cachedWriteTokens",
    "cacheWriteTokens",
    "cacheCreationTokens",
})
_GEMINI_INCLUSIVE_KEYS = frozenset({"promptTokenCount", "cachedContentTokenCount"})


def normalize_usage_payload(payload: Any, *, gemini_prompt_usage: bool = True) -> dict[str, int]:
    """Normalize ACP `usage_update` or `session/prompt` results to canonical inclusive totals.

    Matches T3 Code's canonical token contract (`geminiPromptUsage: true` for
    Antigravity 1.5+): `inputTokens` leaves out `cachedReadTokens`, while
    `outputTokens` already includes `thoughtTokens`. Ensures `input_tokens`
    ALWAYS represents total prompt input (fresh input + cache_read + cache_write),
    so `0 <= cache_read_tokens + cache_write_tokens <= input_tokens`.
    """
    if not isinstance(payload, dict):
        return {}
    candidates: list[dict[str, Any]] = [payload]
    for container_key in ("usage", "tokenUsage", "token_usage"):
        nested = payload.get(container_key)
        if isinstance(nested, dict):
            candidates.append(nested)
    meta = payload.get("_meta")
    if isinstance(meta, dict):
        for container_key in ("usage", "tokenUsage", "token_usage"):
            nested = meta.get(container_key)
            if isinstance(nested, dict):
                candidates.append(nested)

    raw: dict[str, int] = {}
    raw_total: int | None = None
    has_anthropic_exclusive = False
    has_acp_exclusive_cache = False
    has_gemini_inclusive = False

    for source in candidates:
        for dst, src_keys in _USAGE_FIELD_GROUPS:
            for src in src_keys:
                val = source.get(src)
                if isinstance(val, int) and not isinstance(val, bool) and val >= 0:
                    raw[dst] = val
                    if src in _ANTHROPIC_EXCLUSIVE_CACHE_KEYS:
                        has_anthropic_exclusive = True
                    if src in _ACP_EXCLUSIVE_CACHE_KEYS:
                        has_acp_exclusive_cache = True
                    if src in _GEMINI_INCLUSIVE_KEYS:
                        has_gemini_inclusive = True
        for src in _TOTAL_TOKEN_KEYS:
            val = source.get(src)
            if isinstance(val, int) and not isinstance(val, bool) and val >= 0:
                raw_total = val

    if not raw:
        return {}

    raw_in = raw.get("input_tokens", 0)
    raw_out = raw.get("output_tokens", 0)
    cr = raw.get("cache_read_tokens", 0)
    cw = raw.get("cache_write_tokens", 0)
    raw_th = raw.get("thinking_tokens", 0)
    cache_total = cr + cw

    out = dict(raw)
    if cache_total > 0:
        if cache_total > raw_in:
            is_exclusive = True
        elif raw_total is not None and raw_total > 0:
            excl_err = min(
                abs(raw_in + cache_total + raw_out + raw_th - raw_total),
                abs(raw_in + cache_total + raw_out - raw_total),
            )
            incl_err = min(
                abs(raw_in + raw_out + raw_th - raw_total),
                abs(raw_in + raw_out - raw_total),
            )
            is_exclusive = excl_err < incl_err
        elif has_anthropic_exclusive and not has_gemini_inclusive:
            is_exclusive = True
        elif gemini_prompt_usage and has_acp_exclusive_cache and not has_gemini_inclusive:
            is_exclusive = True
        else:
            is_exclusive = False

        if is_exclusive:
            out["input_tokens"] = raw_in + cache_total

    if "cache_write_tokens" in out and out["cache_write_tokens"] == 0:
        out.pop("cache_write_tokens")
    return out


def extract_usage_fields(payload: Any, target: dict[str, int]) -> None:
    """Extract normalized token counts from ACP `usage_update` or `session/prompt` results."""
    normalized = normalize_usage_payload(payload)
    if normalized:
        target.update(normalized)


class SessionUpdateNormalizer:
    """Translates raw ACP `session/update` notifications into GA-Hub AntiEvent dicts."""

    def __init__(self, pre_edit_reader: Any = None, *, clock: Any = None) -> None:
        self._seq = 0
        self._next_step_idx = 0
        self._tool_indices: dict[str, int] = {}
        self._tool_snapshots: dict[str, dict[str, Any]] = {}
        self._terminals: dict[str, dict[str, Any]] = {}
        self._terminal_to_tools: dict[str, list[str]] = {}
        self._last_terminal_emit: dict[str, float] = {}
        self._clock = clock or time.monotonic
        self._thought_idx: int | None = None
        self._reply_idx: int | None = None
        self._plan_idx: int | None = None
        self._pre_edit_reader = pre_edit_reader or read_pre_edit_file
        self.answer_chunks: list[str] = []
        self._current_reply_chunks: list[str] = []
        self.progress_messages: list[str] = []
        self.usage: dict[str, int] = {}
        self.available_commands: list[dict[str, Any]] = []
        self.config_options: list[dict[str, Any]] = []
        self.current_mode_id: str | None = None
        self.prompt_settled = False
        self.reply_open = False
        self._gen_burst_start: float | None = None
        self._gen_last_chunk: float | None = None
        self._gen_active_seconds: float = 0.0

    def _touch_generation_burst(self) -> None:
        now = float(self._clock())
        if self._gen_burst_start is None or self._gen_last_chunk is None:
            self._gen_burst_start = now
            self._gen_last_chunk = now
            return
        if (now - self._gen_last_chunk) > 2.5:
            self._gen_active_seconds += max(0.0, self._gen_last_chunk - self._gen_burst_start)
            self._gen_burst_start = now
        self._gen_last_chunk = now

    def _flush_generation_burst(self) -> None:
        if self._gen_burst_start is not None and self._gen_last_chunk is not None:
            self._gen_active_seconds += max(0.0, self._gen_last_chunk - self._gen_burst_start)
        self._gen_burst_start = None
        self._gen_last_chunk = None

    @property
    def generation_ms(self) -> int:
        total = self._gen_active_seconds
        if self._gen_burst_start is not None and self._gen_last_chunk is not None:
            total += max(0.0, self._gen_last_chunk - self._gen_burst_start)
        return max(0, int(round(total * 1000.0)))

    @property
    def final_answer(self) -> str:
        return "".join(self._current_reply_chunks)

    def _flush_reply_as_progress(self, events: list[dict[str, Any]]) -> None:
        if self._reply_idx is not None:
            events.append(self._emit("step.update", step={"index": self._reply_idx, "kind": "agent_response", "state": "DONE"}))
            self._reply_idx = None
        if self._current_reply_chunks:
            text = "".join(self._current_reply_chunks).strip()
            if text:
                self.progress_messages.append(text)
            self._current_reply_chunks.clear()

    def _emit(self, event_type: str, **payload: Any) -> dict[str, Any]:
        self._seq += 1
        return {"seq": self._seq, "type": event_type, **payload}

    def _alloc_idx(self) -> int:
        idx = self._next_step_idx
        self._next_step_idx += 1
        return idx

    def has_active_tools(self) -> bool:
        for snap in self._tool_snapshots.values():
            if _map_tool_status(snap.get("status")) == "ACTIVE":
                return True
        for term in self._terminals.values():
            if term.get("exit_status") is None:
                return True
        return False

    def has_outliving_background_work(self) -> bool:
        for snap in self._tool_snapshots.values():
            if is_background_outliving_tool(snap, self._terminals):
                return True
        for term_id, term in self._terminals.items():
            if term.get("exit_status") is None and not self._terminal_to_tools.get(term_id):
                return True
        return False

    def collect_subagent_tool_ids(self) -> list[str]:
        """Return toolCallIds of non-MCP subagent launches observed during this turn."""
        ids: list[str] = []
        for tid, snap in self._tool_snapshots.items():
            if _is_mcp_tool_call(snap):
                continue
            raw_input = snap.get("rawInput") if isinstance(snap.get("rawInput"), dict) else {}
            title_low = str(snap.get("title") or "").strip().lower()
            raw_tool = str(raw_input.get("ToolName") or raw_input.get("tool") or "").strip().lower()
            if (
                "invoke_subagent" in title_low
                or "start_subagent" in title_low
                or raw_tool in ("invoke_subagent", "start_subagent")
            ):
                ids.append(tid)
        return ids

    def emit_steer(self, prompt_text: str) -> list[dict[str, Any]]:
        self._flush_generation_burst()
        events: list[dict[str, Any]] = []
        if self._thought_idx is not None:
            events.append(self._emit("step.update", step={"index": self._thought_idx, "kind": "thought", "state": "DONE"}))
            self._thought_idx = None
        self._flush_reply_as_progress(events)
        idx = self._alloc_idx()
        cleaned = (prompt_text or "").strip()
        events.append(
            self._emit(
                "step.update",
                step={
                    "index": idx,
                    "kind": "user_steer",
                    "state": "DONE",
                    "tool": "user_steer",
                    "detail": _bound_text(cleaned, 512) or "运行中插话纠偏",
                    "text_delta": _bound_text(cleaned, 2000),
                },
            )
        )
        return events

    def _project_terminal_steps(
        self,
        terminal_id: str,
        events: list[dict[str, Any]],
        *,
        force_emit: bool = False,
    ) -> None:
        term = self._terminals.get(terminal_id)
        if term is None:
            return
        linked_ids = self._terminal_to_tools.get(terminal_id)
        now = float(self._clock())
        last_emit = self._last_terminal_emit.get(terminal_id)
        if not force_emit and last_emit is not None and (now - last_emit) < _TERMINAL_EMIT_INTERVAL:
            term["dirty"] = True
            return
        term["dirty"] = False
        self._last_terminal_emit[terminal_id] = now
        output_text = _bound_text(term["output"], _TOOL_TEXT_LIMIT, tail=True) if term.get("output") else None
        if linked_ids:
            for tid in linked_ids:
                idx = self._tool_indices.get(tid)
                if idx is None:
                    continue
                prev = self._tool_snapshots.get(tid, {})
                raw_input = prev.get("rawInput") if isinstance(prev.get("rawInput"), dict) else {}
                raw_output = prev.get("rawOutput") if isinstance(prev.get("rawOutput"), dict) else {}
                title = str(prev.get("title") or "").strip()
                tool_kind = str(prev.get("kind") or "execute")
                command = term.get("command") or _extract_command(raw_input, raw_output)
                cwd = term.get("cwd") or _extract_cwd(raw_input, raw_output)
                exit_code = term.get("exit_code")
                if exit_code is None:
                    raw_ec = raw_output.get("exitCode") if raw_output.get("exitCode") is not None else raw_output.get("exit_code")
                    if isinstance(raw_ec, int) and not isinstance(raw_ec, bool):
                        exit_code = raw_ec
                step: dict[str, Any] = {
                    "index": idx,
                    "kind": "tool_call",
                    "state": _map_tool_status(prev.get("status")),
                    "tool": _bound_text(title or tool_kind, 128),
                }
                if command:
                    step["command"] = command
                if cwd:
                    step["cwd"] = cwd
                eff_output = output_text or (
                    _bound_text(prev["_chunk_output"], _TOOL_TEXT_LIMIT, tail=True)
                    if isinstance(prev.get("_chunk_output"), str) and prev["_chunk_output"]
                    else None
                )
                if eff_output:
                    step["output"] = eff_output
                if isinstance(exit_code, int):
                    step["exit_code"] = exit_code
                events.append(self._emit("step.update", step=step))
            return

        synth_tid = f"acp-agent-terminal:{terminal_id}"
        if synth_tid not in self._tool_indices:
            self._flush_reply_as_progress(events)
            self._tool_indices[synth_tid] = self._alloc_idx()
            self._tool_snapshots[synth_tid] = {
                "toolCallId": synth_tid,
                "kind": "execute",
                "title": term.get("command") or "Terminal",
                "status": "in_progress",
            }
        idx = self._tool_indices[synth_tid]
        snap = self._tool_snapshots[synth_tid]
        exit_status = term.get("exit_status")
        if exit_status is None:
            state = "ACTIVE"
            snap["status"] = "in_progress"
        elif term.get("exit_code") == 0:
            state = "DONE"
            snap["status"] = "completed"
        else:
            state = "FAILED"
            snap["status"] = "failed"
        cmd = term.get("command")
        if cmd:
            snap["title"] = cmd
        step = {
            "index": idx,
            "kind": "tool_call",
            "state": state,
            "tool": _bound_text(cmd or "Terminal", 128),
        }
        if cmd:
            step["command"] = cmd
        if term.get("cwd"):
            step["cwd"] = term["cwd"]
        if output_text:
            step["output"] = output_text
        if isinstance(term.get("exit_code"), int):
            step["exit_code"] = term["exit_code"]
        events.append(self._emit("step.update", step=step))

    def flush_pending_terminals(self, events: list[dict[str, Any]]) -> None:
        for term_id, term in list(self._terminals.items()):
            if term.get("dirty"):
                self._project_terminal_steps(term_id, events, force_emit=True)

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
        self._flush_generation_burst()
        events: list[dict[str, Any]] = []
        self.flush_pending_terminals(events)
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
                self._touch_generation_burst()
                if self.prompt_settled:
                    self.reply_open = True
                self.answer_chunks.append(text)
                self._current_reply_chunks.append(text)
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
                self._touch_generation_burst()
                if self.prompt_settled:
                    self.reply_open = True
                self._flush_reply_as_progress(events)
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

        if kind == "tool_call_content_chunk":
            tid = str(update.get("toolCallId") or "")
            if not tid:
                return events
            content = update.get("content")
            chunk = (
                content.get("text")
                if isinstance(content, dict) and content.get("type") == "text"
                else update.get("text")
            )
            if not isinstance(chunk, str) or not chunk:
                return events
            if self.prompt_settled:
                self.reply_open = True
            if tid not in self._tool_indices:
                self._flush_reply_as_progress(events)
                self._tool_indices[tid] = self._alloc_idx()
                self._tool_snapshots[tid] = {"toolCallId": tid, "kind": "other", "status": "in_progress"}
            idx = self._tool_indices[tid]
            snap = self._tool_snapshots[tid]
            snap["_chunk_output"] = _trim_utf8_tail(
                str(snap.get("_chunk_output") or "") + chunk,
                _MAX_TERMINAL_OUTPUT_BYTES,
            )
            raw_input = snap.get("rawInput") if isinstance(snap.get("rawInput"), dict) else {}
            raw_output = snap.get("rawOutput") if isinstance(snap.get("rawOutput"), dict) else {}
            title = str(snap.get("title") or "").strip()
            tool_kind = str(snap.get("kind") or "other")
            step: dict[str, Any] = {
                "index": idx,
                "kind": "tool_call",
                "state": _map_tool_status(snap.get("status")),
                "tool": _bound_text(title or tool_kind, 128),
                "output": _bound_text(snap["_chunk_output"], _TOOL_TEXT_LIMIT, tail=True),
            }
            command = _extract_command(raw_input, raw_output)
            cwd = _extract_cwd(raw_input, raw_output)
            if command:
                step["command"] = command
            if cwd:
                step["cwd"] = cwd
            events.append(self._emit("step.update", step=step))
            return events

        if kind == "terminal_output_chunk":
            term_id = update.get("terminalId")
            encoded = update.get("data")
            if not isinstance(term_id, str) or not term_id or not isinstance(encoded, str):
                return events
            if self.prompt_settled:
                self.reply_open = True
            first_seen = term_id not in self._terminals
            term = self._terminals.setdefault(term_id, {
                "command": None,
                "cwd": None,
                "output": "",
                "pending_bytes": b"",
                "exit_code": None,
                "exit_status": None,
                "dirty": False,
            })
            decoded = _decode_terminal_chunk(term["pending_bytes"], encoded)
            if decoded is None:
                return events
            chunk_text, rest = decoded
            term["pending_bytes"] = rest
            had_output = bool(term["output"])
            if chunk_text:
                term["output"] = _trim_utf8_tail(term["output"] + chunk_text, _MAX_TERMINAL_OUTPUT_BYTES)
            self._project_terminal_steps(term_id, events, force_emit=first_seen or not had_output)
            return events

        if kind == "terminal_update":
            term_id = update.get("terminalId")
            if not isinstance(term_id, str) or not term_id:
                return events
            if self.prompt_settled:
                self.reply_open = True
            first_seen = term_id not in self._terminals
            term = self._terminals.setdefault(term_id, {
                "command": None,
                "cwd": None,
                "output": "",
                "pending_bytes": b"",
                "exit_code": None,
                "exit_status": None,
                "dirty": False,
            })
            if "command" in update:
                cmd_val = update["command"]
                term["command"] = (
                    _bound_text(cmd_val.strip(), _TOOL_TEXT_LIMIT, tail=True)
                    if isinstance(cmd_val, str) and cmd_val.strip()
                    else None
                )
            if "cwd" in update:
                cwd_val = update["cwd"]
                term["cwd"] = (
                    _bound_text(cwd_val.strip(), 512)
                    if isinstance(cwd_val, str) and cwd_val.strip()
                    else None
                )
            if "output" in update:
                out_val = update["output"]
                if out_val is None:
                    term["output"] = ""
                    term["pending_bytes"] = b""
                elif isinstance(out_val, dict) and isinstance(out_val.get("data"), str):
                    decoded = _decode_terminal_chunk(b"", out_val["data"])
                    if decoded is not None:
                        term["output"] = _trim_utf8_tail(decoded[0], _MAX_TERMINAL_OUTPUT_BYTES)
                        term["pending_bytes"] = decoded[1]
            if "exitStatus" in update:
                exit_val = update["exitStatus"]
                if exit_val is None:
                    term["exit_status"] = None
                    term["exit_code"] = None
                elif isinstance(exit_val, dict):
                    if term["pending_bytes"]:
                        flushed = bytes(term["pending_bytes"]).decode("utf-8", errors="replace")
                        term["output"] = _trim_utf8_tail(term["output"] + flushed, _MAX_TERMINAL_OUTPUT_BYTES)
                        term["pending_bytes"] = b""
                    term["exit_status"] = exit_val
                    term["exit_code"] = _extract_terminal_exit_code(exit_val)
            force_emit = bool(first_seen or "command" in update or "exitStatus" in update or "output" in update)
            self._project_terminal_steps(term_id, events, force_emit=force_emit)
            return events

        if kind in ("tool_call", "tool_call_update"):
            tid = str(update.get("toolCallId") or "")
            if not tid:
                return events
            if self.prompt_settled and kind == "tool_call":
                self.reply_open = True
            if kind == "tool_call" or tid not in self._tool_indices:
                self._flush_generation_burst()
                self._flush_reply_as_progress(events)
            if tid not in self._tool_indices:
                self._tool_indices[tid] = self._alloc_idx()
                self._tool_snapshots[tid] = {}
            idx = self._tool_indices[tid]
            prev = self._tool_snapshots[tid]
            sanitized_update: dict[str, Any] = {}
            for k, v in update.items():
                if v is None:
                    continue
                if k in ("rawInput", "rawOutput"):
                    sanitized_val = sanitize_tool_payload(v)
                    if sanitized_val is not None:
                        sanitized_update[k] = sanitized_val
                else:
                    sanitized_update[k] = v
            merged = {**prev, **sanitized_update}
            self._tool_snapshots[tid] = merged

            term_ids = _embedded_terminal_ids(merged.get("content"))
            for term_id in term_ids:
                linked = self._terminal_to_tools.setdefault(term_id, [])
                if tid not in linked:
                    linked.append(tid)
                synth_tid = f"acp-agent-terminal:{term_id}"
                if synth_tid in self._tool_snapshots:
                    self._tool_snapshots[synth_tid]["status"] = "completed"

            raw_input = merged.get("rawInput") if isinstance(merged.get("rawInput"), dict) else {}
            raw_output = merged.get("rawOutput") if isinstance(merged.get("rawOutput"), dict) else {}
            title = str(merged.get("title") or "").strip()
            tool_kind = str(merged.get("kind") or "other")
            command = _extract_command(raw_input, raw_output)
            cwd = _extract_cwd(raw_input, raw_output)
            image_path = extract_local_image_path(raw_output.get("imagePath"))
            output_text = raw_output.get("combinedOutput") or raw_output.get("combined_output")
            if output_text is None and isinstance(merged.get("rawOutput"), str):
                output_text = merged.get("rawOutput")
            exit_code = raw_output.get("exitCode") if raw_output.get("exitCode") is not None else raw_output.get("exit_code")
            for term_id in term_ids:
                term = self._terminals.get(term_id)
                if not term:
                    continue
                if not command and term.get("command"):
                    command = term["command"]
                if not cwd and term.get("cwd"):
                    cwd = term["cwd"]
                if output_text is None and term.get("output"):
                    output_text = term["output"]
                if exit_code is None and term.get("exit_code") is not None:
                    exit_code = term["exit_code"]
                term["dirty"] = False
                self._last_terminal_emit[term_id] = float(self._clock())
            if output_text is None and isinstance(merged.get("_chunk_output"), str) and merged["_chunk_output"]:
                output_text = merged["_chunk_output"]

            mapped_status = _map_tool_status(merged.get("status"))
            if mapped_status != "ACTIVE":
                for term_id, linked_tools in self._terminal_to_tools.items():
                    if tid in linked_tools:
                        term = self._terminals.get(term_id)
                        if term is not None and term.get("exit_status") is None and all(
                            _map_tool_status(self._tool_snapshots.get(other, {}).get("status")) != "ACTIVE"
                            for other in linked_tools
                        ):
                            term["exit_status"] = {"inferred": True}

            diff_text = _extract_diff_from_content(merged.get("content"))
            diff_omitted = False
            if diff_text is None and tool_kind == "edit":
                locs = merged.get("locations") if isinstance(merged.get("locations"), list) else []
                target_path = (locs[0].get("path") if locs and isinstance(locs[0], dict) else None) or raw_input.get("path") or raw_input.get("TargetFile")
                if _has_truncated_text(raw_input):
                    diff_omitted = True
                elif isinstance(target_path, str) and target_path:
                    diff_text = build_edit_patch(
                        target_path,
                        raw_input,
                        locs,
                        self._pre_edit_reader if merged.get("status") in (None, "pending", "in_progress") else None,
                    )
                    if diff_text is None and any(
                        k in raw_input for k in ("ReplacementChunks", "replacement_chunks", "TargetContent", "target_content")
                    ):
                        diff_omitted = True
                elif not any(
                    isinstance(entry, dict) and entry.get("type") == "diff"
                    for entry in (merged.get("content") if isinstance(merged.get("content"), list) else ())
                ):
                    diff_omitted = True

            step: dict[str, Any] = {
                "index": idx,
                "kind": "tool_call",
                "state": mapped_status,
                "tool": _bound_text(title or tool_kind, 128),
            }
            if command:
                step["command"] = command
            if cwd:
                step["cwd"] = cwd
            if image_path:
                step["image_path"] = image_path
            if isinstance(output_text, str) and output_text:
                step["output"] = _bound_text(output_text, _TOOL_TEXT_LIMIT, tail=True)
            if isinstance(exit_code, int):
                step["exit_code"] = exit_code
            if diff_text:
                step["diff"] = diff_text
            elif diff_omitted:
                step["diff_omitted"] = True
            detail = command or (
                merged["locations"][0].get("path")
                if isinstance(merged.get("locations"), list)
                and merged["locations"]
                and isinstance(merged["locations"][0], dict)
                else None
            ) or image_path
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
            parsed_usage = normalize_usage_payload(update)
            if parsed_usage:
                self.usage = parsed_usage
            if self.prompt_settled:
                self.reply_open = False
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
    # while explicit images/audio/PDFs/small text attachments are embedded natively when supported.
    total_bytes = 0
    seen_paths: set[str] = set()

    def _mark_seen(p: Path, raw: str = "") -> None:
        if raw:
            seen_paths.add(raw)
        seen_paths.add(str(p))
        with suppress(OSError):
            seen_paths.add(str(p.resolve()))

    def _is_seen(p: Path, raw: str = "") -> bool:
        if raw and raw in seen_paths:
            return True
        if str(p) in seen_paths:
            return True
        try:
            return str(p.resolve()) in seen_paths
        except OSError:
            return False

    def _append_file_block(p: Path, name: str, *, allow_text: bool) -> None:
        nonlocal total_bytes
        if not p.is_file():
            return
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
        elif allow_text and caps.get("embeddedContext") is True and is_txt and size <= _MAX_TEXT_ATTACHMENT_BYTES and total_bytes + size <= _MAX_TOTAL_ATTACHMENT_BYTES:
            try:
                raw_bytes = p.read_bytes()
                if raw_bytes.startswith((b"\xff\xfe", b"\xfe\xff")):
                    decoded = raw_bytes.decode("utf-16")
                else:
                    decoded = raw_bytes.decode("utf-8")
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

    for att in attachments:
        raw_path = str(att.get("path") or "").strip()
        if not raw_path:
            continue
        p = Path(raw_path)
        if att.get("is_path_only") or att.get("source_tag") == "pasted-text":
            _mark_seen(p, raw_path)
            continue
        if _is_seen(p, raw_path):
            continue
        _mark_seen(p, raw_path)
        _append_file_block(p, str(att.get("name") or p.name), allow_text=True)

    for staged in staged_paths:
        p = Path(staged)
        if _is_seen(p):
            continue
        _mark_seen(p)
        _append_file_block(p, p.name, allow_text=False)

    if not blocks:
        if staged_paths:
            blocks.append({"type": "text", "text": "请查看已附带的文件。"})
        else:
            raise AgyProfileError(422, "请输入内容或添加附件")
    return blocks


def is_orchestrator_model_id(model_id: str) -> bool:
    return "orchestrator" in (model_id or "").lower()


def find_model_config_option(config_options: Any) -> dict[str, Any] | None:
    if not isinstance(config_options, list):
        return None
    for opt in config_options:
        if isinstance(opt, dict) and (opt.get("id") == "model" or opt.get("category") == "model"):
            return opt
    return None


def find_thought_level_option(config_options: Any) -> tuple[str, list[str], str | None] | None:
    if not isinstance(config_options, list):
        return None
    for opt in config_options:
        if not isinstance(opt, dict) or opt.get("category") != "thought_level":
            continue
        cid = opt.get("id")
        if not isinstance(cid, str) or not cid:
            continue
        values: list[str] = []
        seen: set[str] = set()
        for entry in opt.get("options") or []:
            if not isinstance(entry, dict):
                continue
            if "options" in entry and isinstance(entry["options"], list):
                for sub in entry["options"]:
                    val = sub.get("value") if isinstance(sub, dict) else None
                    if isinstance(val, str) and val and val not in seen:
                        seen.add(val)
                        values.append(val)
            else:
                val = entry.get("value")
                if isinstance(val, str) and val and val not in seen:
                    seen.add(val)
                    values.append(val)
        cur = opt.get("currentValue")
        return cid, values, (cur if isinstance(cur, str) else None)
    return None


def _advertised_model_config_values(config_options: Any) -> set[str]:
    opt = find_model_config_option(config_options)
    if not isinstance(opt, dict):
        return set()
    values: set[str] = set()
    for entry in opt.get("options") or []:
        if not isinstance(entry, dict):
            continue
        if "options" in entry and isinstance(entry["options"], list):
            for sub in entry["options"]:
                val = sub.get("value") if isinstance(sub, dict) else None
                if isinstance(val, str) and val:
                    values.add(val)
        else:
            val = entry.get("value")
            if isinstance(val, str) and val:
                values.add(val)
    return values


def _extract_concrete_efforts_by_family(setup_result: dict[str, Any]) -> tuple[dict[str, list[str]], str | None]:
    models_block = setup_result.get("models")
    by_family: dict[str, list[str]] = {}
    current_id: str | None = None
    if not isinstance(models_block, dict):
        return by_family, None
    raw_cur = models_block.get("currentModelId")
    if isinstance(raw_cur, str) and raw_cur.strip():
        current_id = raw_cur.strip()
    for m in models_block.get("availableModels") or []:
        if not isinstance(m, dict):
            continue
        mid = m.get("modelId")
        if not isinstance(mid, str) or not mid.strip():
            continue
        mid = mid.strip()
        if is_orchestrator_model_id(mid):
            continue
        family, _, suffix = mid.rpartition("-")
        if family and suffix.lower() in EFFORT_VARIANTS:
            levels = by_family.setdefault(family, [])
            lvl = suffix.lower()
            if lvl not in levels:
                levels.append(lvl)
    return by_family, current_id


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


def extract_enriched_model_catalog_from_setup(setup_result: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract models with per-family efforts, default flags, and orchestrator markers."""
    base_items = extract_model_catalog_from_setup(setup_result)
    efforts_by_family, current_model_id = _extract_concrete_efforts_by_family(setup_result)
    model_opt = find_model_config_option(setup_result.get("configOptions"))
    current_opt_val = model_opt.get("currentValue") if isinstance(model_opt, dict) else None
    cur_family = current_opt_val if isinstance(current_opt_val, str) else None
    if cur_family is None and isinstance(current_model_id, str):
        fam, _, suf = current_model_id.rpartition("-")
        cur_family = fam if fam and suf.lower() in EFFORT_VARIANTS else current_model_id

    enriched: list[dict[str, Any]] = []
    for item in base_items:
        mid = item["id"]
        entry: dict[str, Any] = {
            "id": mid,
            "display_name": item["display_name"],
        }
        if is_orchestrator_model_id(mid):
            entry["is_orchestrator"] = True
        elif mid in efforts_by_family:
            entry["efforts"] = list(efforts_by_family[mid])
        if cur_family and mid == cur_family:
            entry["is_default"] = True
        enriched.append(entry)
    return enriched


def _match_in_available(model: str, available_set: set[str]) -> tuple[str, str | None] | None:
    if model in available_set:
        return model, None
    family, _, suffix = model.rpartition("-")
    if family and suffix.lower() in EFFORT_VARIANTS and family in available_set:
        return family, suffix.lower()
    return None


def resolve_model_target(
    setup_result: dict[str, Any],
    model: str,
    effort: str,
    *,
    default_model: str | None = None,
    aliases: dict[str, str] | None = None,
    allow_auto_fallback: bool = True,
) -> dict[str, Any]:
    """Resolve alias + upstream target model + auto-fallback candidates against live ACP setup."""
    requested = (model or "").strip()
    alias_from: str | None = None
    resolved_req = requested
    if isinstance(aliases, dict) and requested:
        seen = {requested}
        for _ in range(4):
            nxt = aliases.get(resolved_req)
            if not isinstance(nxt, str) or not nxt.strip() or nxt.strip() in seen:
                break
            alias_from = requested
            resolved_req = nxt.strip()
            seen.add(resolved_req)

    catalog = extract_model_catalog_from_setup(setup_result)
    available_order = [m["id"] for m in catalog]
    available_set = set(available_order)
    config_options = setup_result.get("configOptions")
    model_opt = find_model_config_option(config_options)
    model_cfg_values = _advertised_model_config_values(config_options)

    models_block = setup_result.get("models") if isinstance(setup_result.get("models"), dict) else {}
    current_candidates: list[str] = []
    if default_model and default_model.strip():
        current_candidates.append(default_model.strip())
    if isinstance(model_opt, dict) and isinstance(model_opt.get("currentValue"), str) and model_opt["currentValue"].strip():
        current_candidates.append(model_opt["currentValue"].strip())
    if isinstance(models_block.get("currentModelId"), str) and models_block["currentModelId"].strip():
        current_candidates.append(models_block["currentModelId"].strip())
    if available_order:
        current_candidates.append(available_order[0])

    resolved_effort = effort
    fallback_reason: str | None = None

    matched = _match_in_available(resolved_req, available_set) if available_set else (resolved_req, None)
    if matched is not None:
        target_model, suffix_effort = matched
        if suffix_effort:
            resolved_effort = suffix_effort
    else:
        if not allow_auto_fallback:
            raise AgyModelSelectionError(resolved_req)
        chosen: tuple[str, str | None] | None = None
        for cand in current_candidates:
            hit = _match_in_available(cand, available_set)
            if hit is not None:
                chosen = hit
                break
        if chosen is None:
            raise AgyModelSelectionError(resolved_req)
        target_model, suffix_effort = chosen
        if suffix_effort:
            resolved_effort = suffix_effort
        fallback_reason = f"当前账号不支持模型「{resolved_req}」"

    fallback_candidates: list[str] = []
    for cand in current_candidates:
        hit = _match_in_available(cand, available_set) if available_set else (cand, None)
        if hit is not None and hit[0] != target_model and hit[0] not in fallback_candidates:
            fallback_candidates.append(hit[0])

    use_config_option_id = (
        str(model_opt["id"])
        if isinstance(model_opt, dict) and isinstance(model_opt.get("id"), str) and target_model in model_cfg_values
        else None
    )

    return {
        "requested_model": requested,
        "alias_from": alias_from,
        "target_model": target_model,
        "resolved_effort": resolved_effort,
        "use_config_option_id": use_config_option_id,
        "fallback_reason": fallback_reason,
        "fallback_candidates": fallback_candidates,
    }


def select_effort_call_for_config(
    config_options: Any,
    target_model: str,
    effort: str,
) -> tuple[tuple[str, dict[str, Any]] | None, str | None]:
    """Build `session/set_config_option` for `thought_level` using live post-model configOptions."""
    if is_orchestrator_model_id(target_model):
        return None, None
    thought = find_thought_level_option(config_options)
    if thought is None:
        return None, None
    cid, values, current_val = thought
    if not values:
        return None, None
    desired = (effort or "high").strip().lower()
    if desired in values:
        return ("session/set_config_option", {"configId": cid, "value": desired}), None
    chosen = "high" if "high" in values else (current_val if isinstance(current_val, str) and current_val in values else values[0])
    return (
        ("session/set_config_option", {"configId": cid, "value": chosen}),
        f"模型「{target_model}」不支持思考档位「{desired}」，已自动调整为「{chosen}」",
    )


def select_model_and_effort_calls(
    setup_result: dict[str, Any],
    model: str,
    effort: str,
    *,
    validate: bool = False,
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
    elif validate and available and model not in available:
        raise AgyModelSelectionError(model)

    calls.append(("session/set_model", {"modelId": target_model}))

    if isinstance(config_options, list) and not is_orchestrator_model_id(target_model):
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


# ---------------------------------------------------------------------------
# Managed profile-path safety, turn-outcome diagnostics, and detached child work
# (mirrors T3 Code's AntigravityProfilePaths, AntigravityTurnOutcome, AntigravityChildWork)
# ---------------------------------------------------------------------------

_NATIVE_ID_RE = re.compile(r"^[\w-]+$")
_ERROR_STEP_TYPE = 17
_PLANNER_RESPONSE_STEP_TYPE = 15
_MAX_ERROR_PAYLOAD_BYTES = 16_384
_API_ERROR_RE = re.compile(r"Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)", re.S)
_STATUS_ERROR_RE = re.compile(r"(?<![A-Z_])([A-Z_]+) \(code (\d{3})\): ([^\x00-\x1f\x7f-\x9f]+)")
_QUOTA_EXHAUSTED_RE = re.compile(r"\breason:QUOTA_EXHAUSTED\b")
_INVALID_THINKING_SIGNATURE_RE = re.compile(
    r"\bmessages\.\d+\.content\.\d+(?:\.thinking\.signature: Field required|: Invalid `signature` in `thinking` block)"
)
_RESET_TIMESTAMP_RE = re.compile(r"\bquotaResetTimeStamp:([^\s\]]+)")
_RESET_DELAY_RE = re.compile(r"\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])")
_RETRY_DELAY_RE = re.compile(r"\bretryDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])")
_GO_DURATION_PART_RE = re.compile(r"(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)")
_GO_DURATION_UNITS = {
    "ns": 1e-9,
    "us": 1e-6,
    "µs": 1e-6,
    "μs": 1e-6,
    "ms": 1e-3,
    "s": 1.0,
    "m": 60.0,
    "h": 3600.0,
}

_PENDING_REPLY_TAIL_BYTES = 64 * 1024
_TRANSCRIPT_BYTE_CAP = 1024 * 1024
_MAX_STEP_BYTES = 1024 * 1024
_PLANNER_META_PREFIX_BYTES = 4096
_PROTO_TS_MIN_SEC = 1_000_000_000
_PROTO_TS_MAX_SEC = 4_102_444_800
_MAX_PLANNER_STEP_DURATION_SEC = 3600.0
_MAX_MESSAGE_FILES = 500
_MAX_DETACHED_CHILDREN = 256
_HIGH_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_HIGH"
_LOW_PRIORITY_MESSAGE = "MESSAGE_PRIORITY_LOW"


def _resolve_managed_path(
    app_data_dir: Path,
    segments: tuple[str, ...],
    kind: Literal["file", "directory"],
) -> tuple[Path, os.stat_result] | None:
    """Prove `app_data_dir / segments` exists with the expected type and no symlinks/junctions."""
    try:
        root_st = app_data_dir.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(root_st.st_mode) or not stat.S_ISDIR(root_st.st_mode):
        return None
    root_real = os.path.normcase(os.path.realpath(app_data_dir))
    cur = app_data_dir
    st: os.stat_result | None = None
    for idx, seg in enumerate(segments):
        if not seg or "/" in seg or "\\" in seg or seg in (".", ".."):
            return None
        cur = cur / seg
        try:
            st = cur.lstat()
        except OSError:
            return None
        if stat.S_ISLNK(st.st_mode):
            return None
        expect_file = kind == "file" and idx == len(segments) - 1
        if expect_file and not stat.S_ISREG(st.st_mode):
            return None
        if not expect_file and not stat.S_ISDIR(st.st_mode):
            return None
    if st is None:
        return None
    expected_real = os.path.normcase(os.path.join(root_real, *segments))
    if os.path.normcase(os.path.realpath(cur)) != expected_real:
        return None
    return cur, st


def _parse_reset_seconds(text: str, now_ts: float | None = None) -> int | None:
    now_val = time.time() if now_ts is None else now_ts
    ts_match = _RESET_TIMESTAMP_RE.search(text)
    if ts_match:
        raw_ts = ts_match.group(1).strip()
        try:
            iso_norm = raw_ts[:-1] + "+00:00" if raw_ts.endswith("Z") else raw_ts
            dt = datetime.fromisoformat(iso_norm)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            delta = dt.timestamp() - now_val
            if delta > 0:
                return max(1, int(math.ceil(delta)))
        except ValueError:
            pass
    delay_match = _RESET_DELAY_RE.search(text) or _RETRY_DELAY_RE.search(text)
    if not delay_match:
        return None
    total_sec = 0.0
    for amount, unit in _GO_DURATION_PART_RE.findall(delay_match.group(1)):
        total_sec += float(amount) * _GO_DURATION_UNITS.get(unit, 0.0)
    return max(1, int(math.ceil(total_sec))) if total_sec > 0 else None


def evaluate_turn_outcome(
    stop_reason: str | None,
    step_type: int | None,
    payload: bytes | str | None,
    reached_model: bool,
    *,
    now_ts: float | None = None,
) -> dict[str, Any] | None:
    """Classify hidden upstream API failures reported via `stopReason` / session log `steps`."""
    if step_type == _ERROR_STEP_TYPE:
        if isinstance(payload, (bytes, bytearray)):
            error_text: str | None = bytes(payload).decode("utf-8", errors="replace")
        elif isinstance(payload, str):
            error_text = payload
        else:
            error_text = ""
    else:
        error_text = None

    if error_text is None and stop_reason != "refusal":
        return None

    text = error_text or ""
    api_match = _API_ERROR_RE.search(text) or _STATUS_ERROR_RE.search(text)
    # _API_ERROR_RE yields (http, message, status); _STATUS_ERROR_RE yields (status, http, message).
    if api_match:
        if api_match.re is _API_ERROR_RE:
            http_status, message, status_name = api_match.group(1), api_match.group(2), api_match.group(3)
        else:
            status_name, http_status, message = api_match.group(1), api_match.group(2), api_match.group(3)
    else:
        http_status, message, status_name = None, None, None

    if stop_reason == "refusal" or _QUOTA_EXHAUSTED_RE.search(text):
        reset_sec = _parse_reset_seconds(text, now_ts=now_ts)
        return {
            "status": "rate_limited",
            "code": status_name or "QUOTA_EXHAUSTED",
            "error": "当前账号本周期 Antigravity 配额已耗尽，请稍后重试或切换账号。",
            "retryable": True,
            "thread_broken": False,
            "reset_seconds": reset_sec,
        }

    if _INVALID_THINKING_SIGNATURE_RE.search(text):
        return {
            "status": "cli_error",
            "code": "INVALID_THINKING_SIGNATURE",
            "error": "Antigravity 保存的会话 thinking 签名已失效，已自动重置会话映射，下一条消息将附带前文摘要开启新会话。",
            "retryable": True,
            "thread_broken": True,
            "reset_seconds": None,
        }

    if api_match is None or not http_status or not message:
        return {
            "status": "cli_error",
            "code": "PROVIDER_ERROR",
            "error": "Antigravity 因内部错误中止了本轮响应。",
            "retryable": False,
            "thread_broken": False,
            "reset_seconds": None,
        }

    rate_limited = http_status == "429" or status_name == "RESOURCE_EXHAUSTED"
    transient_not_found = http_status == "404" and reached_model
    reset_sec = _parse_reset_seconds(text, now_ts=now_ts)
    if rate_limited:
        return {
            "status": "rate_limited",
            "code": status_name or "RESOURCE_EXHAUSTED",
            "error": _bound_text(message.strip(), 512),
            "retryable": True,
            "thread_broken": False,
            "reset_seconds": reset_sec,
        }
    return {
        "status": "cli_error",
        "code": status_name,
        "error": _bound_text(message.strip(), 512),
        "retryable": transient_not_found or int(http_status) >= 500,
        "thread_broken": False,
        "transient_not_found": transient_not_found,
        "resume_with": "continue" if transient_not_found else None,
        "reset_seconds": reset_sec,
    }


def _read_varint(data: bytes, pos: int) -> tuple[int, int] | None:
    """Decode an unsigned base-128 protobuf varint within a 10-byte guard."""
    val = 0
    shift = 0
    n = len(data)
    while pos < n and shift < 70:
        b = data[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, pos
        shift += 7
    return None


def _iter_proto_fields(data: bytes) -> Iterator[tuple[int, int, Any]]:
    """Yield `(field_number, wire_type, value)` pairs, stopping cleanly on truncation."""
    pos = 0
    n = len(data)
    while pos < n:
        tag_res = _read_varint(data, pos)
        if tag_res is None:
            return
        tag, pos = tag_res
        field_num = tag >> 3
        wire_type = tag & 0x07
        if field_num <= 0:
            return
        if wire_type == 0:
            val_res = _read_varint(data, pos)
            if val_res is None:
                return
            val, pos = val_res
            yield field_num, wire_type, val
        elif wire_type == 1:
            if pos + 8 > n:
                return
            yield field_num, wire_type, data[pos : pos + 8]
            pos += 8
        elif wire_type == 2:
            len_res = _read_varint(data, pos)
            if len_res is None:
                return
            length, pos = len_res
            if length < 0 or pos + length > n:
                return
            yield field_num, wire_type, data[pos : pos + length]
            pos += length
        elif wire_type == 5:
            if pos + 4 > n:
                return
            yield field_num, wire_type, data[pos : pos + 4]
            pos += 4
        else:
            return


def _decode_proto_timestamp(data: bytes) -> float | None:
    """Decode a protobuf `google.protobuf.Timestamp` strictly into epoch seconds."""
    if not data or len(data) > 32:
        return None
    pos = 0
    n = len(data)
    seconds: int | None = None
    nanos = 0
    while pos < n:
        tag_res = _read_varint(data, pos)
        if tag_res is None:
            return None
        tag, pos = tag_res
        field_num = tag >> 3
        wire_type = tag & 0x07
        if wire_type != 0 or field_num not in (1, 2):
            return None
        val_res = _read_varint(data, pos)
        if val_res is None:
            return None
        val, pos = val_res
        if field_num == 1:
            seconds = val
        else:
            nanos = val
    if seconds is None or seconds < _PROTO_TS_MIN_SEC or seconds > _PROTO_TS_MAX_SEC:
        return None
    if nanos < 0 or nanos >= 1_000_000_000:
        return None
    return seconds + nanos / 1_000_000_000.0


def _extract_planner_step_duration_ms(payload: bytes) -> int | None:
    """Extract `completed_at - created_at` (ms) from `PLANNER_RESPONSE` metadata field 5."""
    if not payload:
        return None
    for field_num, wire_type, value in _iter_proto_fields(payload):
        if field_num != 5 or wire_type != 2:
            continue
        created_at: float | None = None
        completed_8: float | None = None
        completed_7: float | None = None
        completed_32: float | None = None
        for meta_num, meta_wire, meta_val in _iter_proto_fields(value):
            if meta_wire != 2:
                continue
            if meta_num == 1:
                created_at = _decode_proto_timestamp(meta_val)
            elif meta_num == 8:
                completed_8 = _decode_proto_timestamp(meta_val)
            elif meta_num == 7:
                completed_7 = _decode_proto_timestamp(meta_val)
            elif meta_num == 32:
                completed_32 = _decode_proto_timestamp(meta_val)
        completed_at = (
            completed_8
            if completed_8 is not None
            else (completed_7 if completed_7 is not None else completed_32)
        )
        if created_at is None or completed_at is None:
            return None
        delta_sec = completed_at - created_at
        if delta_sec <= 0.0 or delta_sec > _MAX_PLANNER_STEP_DURATION_SEC:
            return None
        ms = int(round(delta_sec * 1000.0))
        return ms if ms > 0 else None
    return None


def _read_steps_readonly(db_path: Path, fn: Any) -> Any:
    try:
        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=0.5)
    except (OSError, sqlite3.Error):
        return None
    try:
        conn.execute("PRAGMA busy_timeout = 100")
        has_steps = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'"
        ).fetchone()
        return fn(conn) if has_steps is not None else None
    except sqlite3.Error:
        return None
    finally:
        conn.close()


class PromptOutcomeWatcher:
    """Ports T3 Code's `watchAntigravityPromptOutcome` against `<app_data_dir>/conversations/<sid>.db`."""

    def __init__(self, app_data_dir: Path, session_id: str) -> None:
        self.app_data_dir = app_data_dir
        self.session_id = session_id
        self._untrusted = False
        self._identity: tuple[int, int] | None = None
        self._start_index: int = -1
        self._turn_start_index: int = -1

    def prepare(self, *, reset_turn: bool = True) -> None:
        self._untrusted = False
        self._identity = None
        self._start_index = -1
        if reset_turn:
            self._turn_start_index = -1
        if not _NATIVE_ID_RE.fullmatch(self.session_id):
            self._untrusted = True
            return
        if _resolve_managed_path(self.app_data_dir, ("conversations",), "directory") is None:
            return
        seg = ("conversations", f"{self.session_id}.db")
        resolved = _resolve_managed_path(self.app_data_dir, seg, "file")
        if resolved is None:
            # Fail closed if a symlink/foreign entry sits at the DB path.
            try:
                (self.app_data_dir / seg[0] / seg[1]).lstat()
                self._untrusted = True
            except OSError:
                pass
            return
        db_path, st = resolved
        self._identity = (st.st_dev, st.st_ino)
        idx = _read_steps_readonly(db_path, lambda conn: conn.execute("SELECT max(idx) FROM steps").fetchone())
        if isinstance(idx, tuple) and isinstance(idx[0], int):
            self._start_index = idx[0]
            if reset_turn:
                self._turn_start_index = idx[0]

    def check(self, prompt_result: dict[str, Any] | None) -> dict[str, Any] | None:
        stop_reason = prompt_result.get("stopReason") if isinstance(prompt_result, dict) else None
        if not isinstance(stop_reason, str):
            stop_reason = None
        if self._untrusted:
            return evaluate_turn_outcome(stop_reason, None, None, False)

        seg = ("conversations", f"{self.session_id}.db")
        after = _resolve_managed_path(self.app_data_dir, seg, "file")
        step_type: int | None = None
        payload: bytes | None = None
        reached_model = False
        if after is not None:
            after_path, after_st = after
            same_file = self._identity is None or (after_st.st_dev, after_st.st_ino) == self._identity
            if same_file:
                start_idx = self._start_index

                def _query(conn: sqlite3.Connection) -> tuple[int | None, bytes | None, bool]:
                    row = conn.execute(
                        "SELECT step_type, substr(step_payload, 1, ?) FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1",
                        (_MAX_ERROR_PAYLOAD_BYTES, start_idx),
                    ).fetchone()
                    if not row or not isinstance(row[0], int):
                        return None, None, False
                    reached = (
                        conn.execute(
                            "SELECT 1 FROM steps WHERE idx > ? AND step_type = ? LIMIT 1",
                            (start_idx, _PLANNER_RESPONSE_STEP_TYPE),
                        ).fetchone()
                        is not None
                    )
                    raw_payload = bytes(row[1]) if isinstance(row[1], (bytes, bytearray, memoryview)) else (
                        row[1].encode("utf-8", errors="replace") if isinstance(row[1], str) else None
                    )
                    return row[0], raw_payload, reached

                res = _read_steps_readonly(after_path, _query)
                if isinstance(res, tuple):
                    step_type, payload, reached_model = res

        return evaluate_turn_outcome(stop_reason, step_type, payload, reached_model)

    def turn_model_metrics(self) -> tuple[int, int]:
        """Return `(model_calls, generation_ms)` for planner steps recorded during this turn."""
        if self._untrusted:
            return 0, 0
        seg = ("conversations", f"{self.session_id}.db")
        resolved = _resolve_managed_path(self.app_data_dir, seg, "file")
        if resolved is None:
            return 0, 0
        db_path, st = resolved
        if self._identity is not None and (st.st_dev, st.st_ino) != self._identity:
            return 0, 0
        start_idx = self._turn_start_index

        def _query(conn: sqlite3.Connection) -> tuple[int, int]:
            rows = conn.execute(
                "SELECT idx, substr(step_payload, 1, ?), length(step_payload) "
                "FROM steps WHERE idx > ? AND step_type = ? ORDER BY idx",
                (_PLANNER_META_PREFIX_BYTES, start_idx, _PLANNER_RESPONSE_STEP_TYPE),
            ).fetchall()
            model_calls = len(rows)
            if model_calls == 0:
                return 0, 0
            total_ms = 0
            timed_calls = 0
            for idx, prefix, full_len in rows:
                raw = (
                    bytes(prefix)
                    if isinstance(prefix, (bytes, bytearray, memoryview))
                    else (prefix.encode("utf-8", errors="replace") if isinstance(prefix, str) else b"")
                )
                dur_ms = _extract_planner_step_duration_ms(raw)
                if (
                    dur_ms is None
                    and isinstance(full_len, int)
                    and _PLANNER_META_PREFIX_BYTES < full_len <= _MAX_STEP_BYTES
                ):
                    full_row = conn.execute("SELECT step_payload FROM steps WHERE idx = ?", (idx,)).fetchone()
                    if full_row and isinstance(full_row[0], (bytes, bytearray, memoryview)):
                        dur_ms = _extract_planner_step_duration_ms(bytes(full_row[0]))
                if dur_ms is not None:
                    total_ms += dur_ms
                    timed_calls += 1
            return model_calls, total_ms if timed_calls == model_calls else 0

        res = _read_steps_readonly(db_path, _query)
        return res if isinstance(res, tuple) else (0, 0)

    def model_call_count(self) -> int:
        """Count planner/model generation steps recorded in local `steps` during this turn."""
        return self.turn_model_metrics()[0]


def _read_inbox_messages(app_data_dir: Path, conversation_id: str) -> list[dict[str, Any]] | None:
    if not _NATIVE_ID_RE.fullmatch(conversation_id):
        return None
    directory = ("brain", conversation_id, ".system_generated", "messages")
    inbox = _resolve_managed_path(app_data_dir, directory, "directory")
    if inbox is None:
        return []
    inbox_path, _ = inbox
    try:
        names = [e for e in os.listdir(inbox_path) if e.endswith(".json") and e != "read.json"]
    except OSError:
        return None
    if len(names) > _MAX_MESSAGE_FILES:
        return None
    out: list[dict[str, Any]] = []
    for name in names:
        msg_file = _resolve_managed_path(app_data_dir, (*directory, name), "file")
        if msg_file is None or msg_file[1].st_size > _MAX_STEP_BYTES:
            return None
        try:
            data = json.loads(msg_file[0].read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            return None
        if isinstance(data, dict):
            out.append(data)
    return out


def has_pending_reply_on_disk(app_data_dir: Path, session_id: str) -> bool:
    """Mirror `readAntigravityPendingReply`: unread high-priority inbox wake or trailing SYSTEM_MESSAGE."""
    if not _NATIVE_ID_RE.fullmatch(session_id):
        return False

    msg_dir = ("brain", session_id, ".system_generated", "messages")
    inbox = _resolve_managed_path(app_data_dir, msg_dir, "directory")
    if inbox is not None:
        inbox_path, _ = inbox
        try:
            entries = os.listdir(inbox_path)
        except OSError:
            entries = []
        msg_names = [e for e in entries if e.endswith(".json") and e != "read.json"]
        if 0 < len(msg_names) <= _MAX_MESSAGE_FILES:
            read_receipts: dict[str, bool] = {}
            if "read.json" in entries:
                rf = _resolve_managed_path(app_data_dir, (*msg_dir, "read.json"), "file")
                if rf is not None and rf[1].st_size <= _MAX_STEP_BYTES:
                    try:
                        parsed_rcpts = json.loads(rf[0].read_text(encoding="utf-8"))
                        if isinstance(parsed_rcpts, dict):
                            read_receipts = {str(k): bool(v) for k, v in parsed_rcpts.items()}
                    except (OSError, UnicodeDecodeError, ValueError):
                        read_receipts = {}
            for name in msg_names:
                file_id = name[:-5]
                if read_receipts.get(file_id) is True:
                    continue
                mf = _resolve_managed_path(app_data_dir, (*msg_dir, name), "file")
                if mf is None or mf[1].st_size > _MAX_STEP_BYTES:
                    continue
                try:
                    msg = json.loads(mf[0].read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, ValueError):
                    continue
                if not isinstance(msg, dict):
                    continue
                mid = msg.get("id")
                if isinstance(mid, str) and read_receipts.get(mid) is True:
                    continue
                if msg.get("priority") == _HIGH_PRIORITY_MESSAGE:
                    return True

    transcript = _resolve_managed_path(
        app_data_dir,
        ("brain", session_id, ".system_generated", "logs", "transcript.jsonl"),
        "file",
    )
    if transcript is None or transcript[1].st_size == 0:
        return False
    t_path, t_st = transcript
    try:
        with open(t_path, "rb") as fp:
            for byte_cap in (_PENDING_REPLY_TAIL_BYTES, _TRANSCRIPT_BYTE_CAP):
                start = max(0, t_st.st_size - byte_cap)
                fp.seek(start)
                raw = fp.read(t_st.st_size - start).rstrip(b"\r\n")
                if not raw:
                    if start == 0:
                        return False
                    continue
                nl = raw.rfind(b"\n")
                if nl == -1 and start > 0:
                    continue
                line = raw[nl + 1 :].decode("utf-8", errors="replace")
                try:
                    step = json.loads(line)
                except ValueError:
                    return False
                if not isinstance(step, dict) or step.get("type") != "SYSTEM_MESSAGE":
                    return False
                content = step.get("content")
                if content is None:
                    return True
                if not isinstance(content, str):
                    return False
                return (f"priority={_HIGH_PRIORITY_MESSAGE}" in content) or (
                    f"priority={_LOW_PRIORITY_MESSAGE}" not in content
                )
    except OSError:
        return False
    return False


def read_detached_children_at_work(
    app_data_dir: Path,
    root_session_id: str,
    tool_call_ids: set[str] | list[str] | tuple[str, ...],
) -> list[str]:
    """Mirror `readAntigravityChildrenAtWork`: return subagent call IDs with live unreported children."""
    if not tool_call_ids or not _NATIVE_ID_RE.fullmatch(root_session_id):
        return []
    target_ids = set(tool_call_ids)
    sub_dir = ("brain", root_session_id, ".system_generated", "subagents")
    children_dir = _resolve_managed_path(app_data_dir, sub_dir, "directory")
    if children_dir is None:
        return []
    try:
        entries = os.listdir(children_dir[0])
    except OSError:
        return []
    child_ids = [
        e[:-5]
        for e in entries
        if e.endswith(".json") and _NATIVE_ID_RE.fullmatch(e[:-5])
    ]
    if not child_ids or len(child_ids) > _MAX_DETACHED_CHILDREN:
        return []
    parent_inbox = _read_inbox_messages(app_data_dir, root_session_id)
    if parent_inbox is None:
        return []
    reported_senders = {str(m.get("sender")) for m in parent_inbox if isinstance(m.get("sender"), str)}
    at_work: list[str] = []
    for child_id in child_ids:
        if child_id in reported_senders:
            continue
        sub_file = _resolve_managed_path(app_data_dir, (*sub_dir, f"{child_id}.json"), "file")
        if sub_file is None or sub_file[1].st_size > _MAX_STEP_BYTES:
            continue
        try:
            record = json.loads(sub_file[0].read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        rec_cid = record.get("conversationId")
        if rec_cid is not None and rec_cid != child_id:
            continue
        if record.get("state") == "SUBAGENT_STATE_KILLED":
            continue
        child_inbox = _read_inbox_messages(app_data_dir, child_id)
        if not child_inbox:
            continue
        for msg in child_inbox:
            if msg.get("sender") != root_session_id:
                continue
            tool_meta = (msg.get("sourceMetadata") or {}).get("tool") if isinstance(msg.get("sourceMetadata"), dict) else None
            if not isinstance(tool_meta, dict):
                continue
            meta_cid = tool_meta.get("conversationId")
            if meta_cid is not None and meta_cid != root_session_id:
                continue
            call = tool_meta.get("toolCall")
            if isinstance(call, dict) and call.get("name") == "invoke_subagent":
                call_id = call.get("id")
                if isinstance(call_id, str) and call_id in target_ids:
                    at_work.append(call_id)
    return at_work
