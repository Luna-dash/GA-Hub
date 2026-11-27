"""Pure-Python canonical transcript scanner, assistant parser, and snapshot merger.

Ports the exact semantics of:
- webui/src/utils/transcriptProtocol.ts
- webui/src/utils/archiveTurnSegments.ts
- webui/src/utils/replySegments.ts
- webui/src/utils/assistantTranscript.ts
- webui/src/utils/messageModel.ts
- webui/src/utils/messagePresentation.ts

Parity with the TypeScript implementation is locked by shared golden contract
tests in tests/fixtures/message_presentation_golden.json,
tests/test_message_presentation_golden.py, and
webui/src/utils/messagePresentation.golden.test.ts.
"""
from __future__ import annotations

import json
import math
import re
import time
from datetime import datetime
from typing import Any

# ---------------------------------------------------------------------------
# 1. Transcript protocol scanner (transcriptProtocol.ts)
# ---------------------------------------------------------------------------

_TOOL_RE = re.compile(
    r"🛠\ufe0f?\s*Tool\s*[:：]\s*`([A-Za-z0-9_.-]+)`(?:[ \t]*📥[ \t]*args:)?",
    re.IGNORECASE,
)
_COMPACT_RE = re.compile(r"🛠\ufe0f?\s*([A-Za-z0-9_.-]+)\s*\(")
_TURN_RE = re.compile(
    r"(?:\*\*)?LLM Running \(Turn (\d+)\) \.\.\.(?:\*\*)?",
    re.IGNORECASE,
)
_META_RE = re.compile(r"<(summary|thinking|think|analysis)>", re.IGNORECASE)
_EDGE_RE = re.compile(r"[ \t]*(`{3,}|~{3,})([^\r\n]*)(?:\r?\n|\Z)")
_WS_RE = re.compile(r"\s*")
_ARGS_PREFIX_RE = re.compile(r"(?:📥\s*args:|`{1,})")
_PENDING_TAIL_RE = re.compile(
    r"^(?:🛠\ufe0f?\s*(?:T(?:o(?:o(?:l(?::\s*(?:`[A-Za-z0-9_.]*)?)?)?)?)?)?"
    r"|<(?:s(?:u(?:m(?:m(?:a(?:r(?:y)?)?)?)?)?)?)?)\Z",
    re.IGNORECASE,
)
_BACKTICK_TAIL_RE = re.compile(r"^`{1,3}\Z")
_PENDING_OPEN_TAGS = ("<thinking>", "<think>", "<analysis>")

_WS_CHARS = frozenset((" ", "\t", "\n", "\r", "\x0b", "\x0c", "\xa0"))


def _is_ws_char(ch: str) -> bool:
    return ch in _WS_CHARS


def _skip_ws(source: str, pos: int) -> int:
    n = len(source)
    while pos < n and source[pos] in _WS_CHARS:
        pos += 1
    return pos


def _skip_inline_spaces(source: str, pos: int) -> int:
    n = len(source)
    while pos < n and source[pos] in (" ", "\t"):
        pos += 1
    return pos


def _is_word_or_tool_char(ch: str) -> bool:
    code = ord(ch)
    return (
        ch == "\U0001f6e0"
        or ch in ("_", ".", "-")
        or (48 <= code <= 57)
        or (65 <= code <= 90)
        or (97 <= code <= 122)
    )


def _balanced_call(source: str, start: int) -> int | None:
    depth = 1
    quoted = False
    escaped = False
    for i in range(start, len(source)):
        ch = source[i]
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
                return i + 1
    return None


def _fence(source: str, start: int, tool: bool) -> dict[str, Any]:
    open_m = _EDGE_RE.match(source, start)
    assert open_m is not None
    size = len(open_m.group(1))
    char = open_m.group(1)[0]
    close_re = re.compile(rf"^[ \t]*{'`' if char == '`' else '~'}{{{size},}}[ \t]*\Z")
    glued_re = (
        re.compile(rf"(?<!`)`{{{size}}}[ \t]*\Z")
        if (tool and char == "`")
        else None
    )
    pos = open_m.end()
    n = len(source)
    while pos < n:
        nl = source.find("\n", pos)
        end = n if nl < 0 else nl + 1
        line_end = end
        if line_end > pos and source[line_end - 1] == "\n":
            line_end -= 1
        if line_end > pos and source[line_end - 1] == "\r":
            line_end -= 1
        line = source[pos:line_end]
        if close_re.match(line):
            return {"end": end, "complete": True, "repair": None}
        if glued_re is not None:
            glued = glued_re.search(line)
            if glued and glued.start() > 0:
                return {"end": end, "complete": True, "repair": pos + glued.start()}
        pos = end
    return {"end": n, "complete": False, "repair": None}


def scan_transcript(source: str) -> list[dict[str, Any]]:
    nodes: list[dict[str, Any]] = []
    n = len(source)
    pos = 0
    text_start = 0

    def push(kind: str, start: int, end: int, **extra: Any) -> None:
        node: dict[str, Any] = {
            "kind": kind,
            "start": start,
            "end": end,
            "raw": source[start:end],
            "complete": True,
        }
        node.update(extra)
        nodes.append(node)

    def flush() -> None:
        if pos > text_start:
            push("text", text_start, pos)

    while pos < n:
        ch = source[pos]
        line_start = pos == 0 or source[pos - 1] == "\n"
        if ch in ("*", "L", "l"):
            turn_m = _TURN_RE.match(source, pos)
            if turn_m:
                flush()
                push("turn", pos, turn_m.end(), turn=int(turn_m.group(1)))
                pos = turn_m.end()
                text_start = pos
                continue
        if ch == "<":
            meta_m = _META_RE.match(source, pos)
            if meta_m:
                tag = meta_m.group(1)
                close_re = re.compile(rf"</{tag}>", re.IGNORECASE)
                close_m = close_re.search(source, meta_m.end())
                end = close_m.end() if close_m else n
                flush()
                push(
                    "summary" if tag.lower() == "summary" else "thinking",
                    pos,
                    end,
                    complete=bool(close_m),
                )
                pos = end
                text_start = pos
                continue

        ws = _is_ws_char(ch)
        header_match: tuple[str, int] | None = None
        if ch in ("\U0001f6e0", "T", "t") or ws:
            probe = _skip_ws(source, pos) if ws else pos
            probe_ch = source[probe] if probe < n else ""
            if probe_ch in ("\U0001f6e0", "T", "t"):
                h = _TOOL_RE.match(source, pos)
                if h:
                    h_name = h.group(1)
                    h_end = h.end()
                    ws_m = _WS_RE.match(source, h_end)
                    suffix_start = ws_m.end() if ws_m else h_end
                    rem_len = n - suffix_start
                    if rem_len > 0 and rem_len <= 8 and "📥 args:".startswith(source[suffix_start:]):
                        header_match = (h_name, n)
                    elif rem_len > 0:
                        if _ARGS_PREFIX_RE.match(source, suffix_start):
                            header_match = (h_name, h_end)
                    else:
                        header_match = (h_name, h_end)

        adjacent_tool = bool(nodes and nodes[-1]["kind"] == "tool" and nodes[-1]["end"] == pos)
        compact = None
        if header_match is None and (line_start or adjacent_tool) and (ws or _is_word_or_tool_char(ch)):
            compact = _COMPACT_RE.match(source, pos)

        if header_match is not None or compact is not None:
            flush()
            start = pos
            if header_match is not None:
                name, hdr_end_val = header_match
                header_end: int | None = hdr_end_val
            else:
                assert compact is not None
                name = compact.group(1)
                header_end = _balanced_call(source, compact.end())
            end = header_end if header_end is not None else n
            complete = header_end is not None
            opaque: list[dict[str, int]] = []
            repairs: list[int] = []
            while complete:
                ws_m = _WS_RE.match(source, end)
                nxt = ws_m.end() if ws_m else end
                edge = _EDGE_RE.match(source, nxt)
                if edge and edge.group(1)[0] == "`" and len(edge.group(1)) >= 4:
                    block = _fence(source, nxt, True)
                    opaque.append({"start": nxt, "end": block["end"]})
                    if block["repair"] is not None:
                        repairs.append(block["repair"])
                    end = block["end"]
                    complete = block["complete"]
                    continue
                if nxt < n and n - nxt <= 3 and _BACKTICK_TAIL_RE.match(source[nxt:]):
                    opaque.append({"start": nxt, "end": n})
                    end = n
                    complete = False
                break
            push(
                "tool",
                start,
                end,
                name=name,
                headerEnd=(compact.end() if compact is not None else header_end),
                complete=complete,
                opaque=opaque,
                repairs=repairs,
            )
            pos = end
            text_start = pos
            continue

        if line_start and ch in ("`", "~", " ", "\t"):
            fence_check = _skip_inline_spaces(source, pos) if ch in (" ", "\t") else pos
            fence_ch = source[fence_check] if fence_check < n else ""
            if fence_ch in ("`", "~"):
                if _EDGE_RE.match(source, pos):
                    flush()
                    block = _fence(source, pos, False)
                    push("code", pos, block["end"], complete=block["complete"])
                    pos = block["end"]
                    text_start = pos
                    continue

        if ch == "<" and n - pos <= 10:
            tail_lower = source[pos:].lower()
            if any(tag.startswith(tail_lower) for tag in _PENDING_OPEN_TAGS):
                flush()
                push("pending", pos, n, complete=False)
                pos = n
                text_start = pos
                break
        if n - pos <= 256 and (ch in ("<", "\U0001f6e0", "T", "t") or ws):
            if _PENDING_TAIL_RE.match(source[pos:]):
                flush()
                push("pending", pos, n, complete=False)
                pos = n
                text_start = pos
                break
        pos += 1

    flush()
    return nodes


# ---------------------------------------------------------------------------
# 2. Archive turn segments (archiveTurnSegments.ts)
# ---------------------------------------------------------------------------

def valid_turn_segments(value: Any, content: str) -> list[str] | None:
    if (
        isinstance(value, list)
        and len(value) > 0
        and all(isinstance(part, str) and len(part.strip()) > 0 for part in value)
        and "".join(value) == content
    ):
        return list(value)
    return None


# ---------------------------------------------------------------------------
# 3. Assistant transcript parser (assistantTranscript.ts)
# ---------------------------------------------------------------------------

_FINAL_MARKER_RE = re.compile(
    r"\n*(?:`{3,5}[^\r\n]*\r?\n?)?\[Info\]\s*Final response to user\.\s*(?:\r?\n?`{3,5})?\s*\Z",
    re.IGNORECASE,
)
_ANCHORED_TURN_HEADER_RE = re.compile(
    r"^\*?\*?LLM Running \(Turn \d+\) \.\.\.\*?\*?[^\S\r\n]*(?:\r?\n|\Z)",
    re.IGNORECASE,
)
_STATUS_LINE_RE = re.compile(
    r"^[ \t]*\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\][^\r\n]*$",
    re.IGNORECASE | re.MULTILINE,
)

_FALLBACK_SUMMARY_LIMIT = 80
_FALLBACK_TOOL_CUT_RES = (
    re.compile(r"`{4,}"),
    re.compile(r"🛠\ufe0f"),
    re.compile(r"</arg_value>|</parameter>"),
    re.compile(r"^\[(?:Info|Warn|Error|Status|Stdout|Stderr|系统)\]", re.MULTILINE),
)
_FALLBACK_ERROR_RE = re.compile(
    r"^\s*(?:[!！]{1,4}\s*)?(?:\[(?:ERROR|DANGER)\]|\[\s*!{2,}|流异常中断|Incomplete response|上一条回复|Error[:：])",
    re.IGNORECASE,
)
_DSML_RESIDUE_RE = re.compile(r"(?:\s*(?:</?)?\s*[｜|]+\s*DSML[^>]*>?)+", re.IGNORECASE)
_OPEN_SHELL_RE = re.compile(r"^(?:\s*<[A-Za-z][^<>]{0,80}>)+\s*")
_LEADING_THINKING_RE = re.compile(r"^(\s*<thinking>[\s\S]*?</thinking>)+\s*", re.IGNORECASE)
_CLOSE_SHELL_RE = re.compile(r"(?:\s*</[A-Za-z][^<>]{0,80}>)+\s*\Z")
_TRAILING_DSML_RE = re.compile(r"\s*[｜|]+\s*DSML.*\Z", re.IGNORECASE)
_LABEL_RESIDUE_RE = re.compile(
    r"</?(?:summary|parameter|arg_value|antml:[a-z_]+)(?:\s[^<>]{0,200})?>",
    re.IGNORECASE,
)
_DECORATION_ONLY_RE = re.compile(r"^[|>#*=\-•·`]+\s*\Z")
_LEAD_PREFIX_RE = re.compile(r"^\s*[#>*\-•·]+\s*")
_ALNUM_CJK_RE = re.compile(r"[0-9A-Za-z\u4e00-\u9fff]")
_SENTINEL_RE = re.compile(r"[。！？]")
_COMPACT_CANDIDATES_SEP_RE = re.compile(r"\n[ \t]*candidates:[ \t]*(\r?\n|\Z)", re.IGNORECASE)
_COMPACT_ITEM_RE = re.compile(r"^[ \t]*-[ \t]?(.*)$")
_TRAILING_PAREN_RE = re.compile(r"\)\s*\Z")


def strip_final_response_marker(text: str) -> str:
    return _FINAL_MARKER_RE.sub("", text or "").strip()


def _extract_summary(text: str) -> str:
    summary_nodes = [n for n in scan_transcript(text) if n["kind"] == "summary" and n["complete"]]
    if not summary_nodes:
        return ""
    raw = summary_nodes[-1]["raw"]
    inner = re.sub(r"^<summary>\s*|\s*</summary>\Z", "", raw, flags=re.IGNORECASE)
    return " · ".join(line.strip() for line in re.split(r"\r?\n", inner) if line.strip())


def _strip_trace_meta(text: str) -> str:
    parts = [
        n["raw"]
        for n in scan_transcript(text or "")
        if n["kind"] != "thinking" and (not n["complete"] or n["kind"] != "summary")
    ]
    return "".join(parts).strip()


def _read_json_object_after(text: str, offset: int) -> str:
    start = text.find("{", offset)
    if start < 0:
        return ""
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        ch = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    return ""


def _candidate_label(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    label = next((value.get(k) for k in ("label", "title", "value") if isinstance(value.get(k), str)), None)
    description = value["description"].strip() if isinstance(value.get("description"), str) else ""
    label_str = label.strip() if isinstance(label, str) else ""
    sep = "：" if (label and description) else ""
    return f"{label_str}{sep}{description}"


def _read_lenient_string_field(source: str, key: str) -> str:
    match = re.search(rf'"{key}"\s*:\s*"', source, re.IGNORECASE)
    if not match:
        return ""
    index = match.end()
    chars: list[str] = []
    n = len(source)
    while index < n:
        ch = source[index]
        if ch == "\\" and index + 1 < n:
            nxt = source[index + 1]
            if nxt == "n":
                chars.append("\n")
            elif nxt == "t":
                chars.append("\t")
            else:
                chars.append(nxt)
            index += 2
            continue
        if ch == '"':
            break
        chars.append(ch)
        index += 1
    return "".join(chars).strip()


def _read_lenient_string_array_field(source: str, key: str) -> list[str]:
    match = re.search(rf'"{key}"\s*:\s*\[', source, re.IGNORECASE)
    if not match:
        return []
    index = match.end()
    items: list[str] = []
    n = len(source)
    while index < n:
        ch = source[index]
        if ch == "]":
            break
        if ch == '"':
            index += 1
            chars: list[str] = []
            while index < n:
                item_ch = source[index]
                if item_ch == "\\" and index + 1 < n:
                    nxt = source[index + 1]
                    if nxt == "n":
                        chars.append("\n")
                    elif nxt == "t":
                        chars.append("\t")
                    else:
                        chars.append(nxt)
                    index += 2
                    continue
                if item_ch == '"':
                    break
                chars.append(item_ch)
                index += 1
            index += 1
            val = "".join(chars)
            if val.strip():
                items.append(val)
            continue
        index += 1
    return items


def _ask_user_payload_from_object(payload: Any) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    if isinstance(payload.get("question"), str):
        question = payload["question"].strip()
    elif isinstance(payload.get("prompt"), str):
        question = payload["prompt"].strip()
    else:
        question = ""
    if not question:
        return None
    raw_candidates = (
        payload["candidates"]
        if isinstance(payload.get("candidates"), list)
        else payload["options"]
        if isinstance(payload.get("options"), list)
        else []
    )
    candidates = [c for c in (_candidate_label(item) for item in raw_candidates) if c]
    return {"question": question, "candidates": candidates}


def render_ask_user_payload(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates") or []
    if candidates:
        bullet_list = "\n".join(f"- {c}" for c in candidates)
        return f"{payload['question']}\n\n可选项：\n{bullet_list}"
    return str(payload["question"])


def _tool_short_name(name: str | None) -> str:
    if not name:
        return ""
    return name.split(".")[-1]


def _last_ask_user_node(text: str) -> dict[str, Any] | None:
    matches = [
        n
        for n in scan_transcript(text)
        if n["kind"] == "tool" and _tool_short_name(n.get("name")).lower() == "ask_user"
    ]
    return matches[-1] if matches else None


def _parse_compact_ask_user(tail: str) -> dict[str, Any] | None:
    sep = _COMPACT_CANDIDATES_SEP_RE.search(tail)
    question = ""
    candidates: list[str] = []
    if sep:
        question = _TRAILING_PAREN_RE.sub("", tail[: sep.start()]).strip()
        for line in re.split(r"\r?\n", tail[sep.end() :]):
            item = _COMPACT_ITEM_RE.match(line)
            if not item:
                break
            closing = _TRAILING_PAREN_RE.search(item.group(1))
            text = (item.group(1)[: closing.start()] if closing else item.group(1)).strip()
            if text:
                candidates.append(text)
            if closing:
                break
    else:
        lines: list[str] = []
        closed = False
        for line in re.split(r"\r?\n", tail):
            closing = _TRAILING_PAREN_RE.search(line)
            if closing:
                text = line[: closing.start()].rstrip()
                if text:
                    lines.append(text)
                closed = True
                break
            text = line.strip()
            if text:
                lines.append(text)
        if not closed:
            return None
        question = "\n".join(lines).strip()
    if not question:
        return None
    return {
        "question": question,
        "candidates": [c for c in (_candidate_label(item) for item in candidates) if c],
    }


def extract_ask_user_payload(text: str) -> dict[str, Any] | None:
    node = _last_ask_user_node(text)
    if node is None:
        return None
    header_end = node["headerEnd"] if node.get("headerEnd") is not None else node["end"]
    header_str = text[node["start"] : header_end]
    tail = text[header_end : node["end"]]
    encoded = _read_json_object_after(tail, 0)
    if encoded:
        try:
            parsed = _ask_user_payload_from_object(json.loads(encoded))
            if parsed:
                return parsed
        except (ValueError, TypeError):
            pass
    question = (_read_lenient_string_field(tail, "question") or _read_lenient_string_field(tail, "prompt")).strip()
    if not question:
        return _parse_compact_ask_user(tail) if re.search(r"\(\s*\Z", header_str) else None
    candidates = _read_lenient_string_array_field(tail, "candidates")
    if not candidates:
        candidates = _read_lenient_string_array_field(tail, "options")
    return {
        "question": question,
        "candidates": [c for c in (_candidate_label(item) for item in candidates) if c],
    }


def _project_final_body(content: str, ask_replacement: str | None = None) -> str:
    without_meta = _strip_trace_meta(content).strip()
    if not without_meta:
        return ""
    ask_node = _last_ask_user_node(without_meta)
    if ask_node is None:
        return without_meta
    if ask_replacement is not None:
        rendered = ask_replacement
    else:
        payload = extract_ask_user_payload(without_meta)
        rendered = render_ask_user_payload(payload) if payload else ""
    if ask_replacement is None and not rendered:
        return without_meta
    before = without_meta[: ask_node["start"]].rstrip()
    after = without_meta[ask_node["end"] :].strip()
    return "\n\n".join(part for part in (before, rendered, after) if part)


def _is_dangling_tool_turn(content: str) -> bool:
    nodes = scan_transcript(content)
    if any(n["kind"] == "tool" and _tool_short_name(n.get("name")) == "ask_user" for n in nodes):
        return False
    last_call = -1
    for idx, node in enumerate(nodes):
        if node["kind"] == "tool":
            last_call = idx
    if last_call < 0:
        visible = [n for n in nodes if n["kind"] not in ("summary", "thinking") and n["raw"].strip()]
        return bool(visible) and all(
            n["kind"] == "code" and bool(re.match(r"^\s*`{4,}", n["raw"])) for n in visible
        )
    tail = "".join(
        "MARKDOWN_CODE" if n["kind"] == "code" else n["raw"]
        for n in nodes[last_call + 1 :]
        if n["kind"] in ("text", "code")
    )
    tail = _STATUS_LINE_RE.sub("", tail)
    return tail.strip() == ""


def _fallback_strip_markdown(text: str) -> str:
    return re.sub(r"\*\*|__|`|~~", "", text)


def _fallback_trim_tail(text: str, hard: bool = False) -> str:
    value = text.rstrip()
    strip_chars = "，、；,;:—～~-" if hard else "，、；,;—～~-"

    def drop_trailing(val: str) -> str:
        while True:
            val = val.rstrip()
            if not val or val[-1] not in strip_chars:
                return val
            val = val[:-1]

    value = drop_trailing(value)
    for _ in range(2):
        opened: list[int] = []
        for idx, ch in enumerate(value):
            if ch in "（({[【":
                opened.append(idx)
            elif ch in "）)}]】" and opened:
                opened.pop()
        if not opened:
            break
        value = drop_trailing(value[: opened[0]])
    return value


def _fallback_lead_line(raw: str) -> str:
    text = "".join(
        n["raw"] for n in scan_transcript(raw) if n["kind"] not in ("thinking", "pending")
    )
    text = _DSML_RESIDUE_RE.sub(" ", text)
    text = _OPEN_SHELL_RE.sub("", text)
    text = _LEADING_THINKING_RE.sub("", text)
    cut = -1
    for pattern in _FALLBACK_TOOL_CUT_RES:
        m = pattern.search(text)
        if m and (cut < 0 or m.start() < cut):
            cut = m.start()
    if cut >= 0:
        text = text[:cut]
    text = _CLOSE_SHELL_RE.sub("", text)
    text = _TRAILING_DSML_RE.sub("", text)
    text = _LABEL_RESIDUE_RE.sub(" ", text)
    text = _DSML_RESIDUE_RE.sub(" ", text)
    line = ""
    for candidate in re.split(r"\r?\n", text):
        trimmed = candidate.strip()
        if not trimmed or _DECORATION_ONLY_RE.match(trimmed):
            continue
        line = trimmed
        break
    if not line:
        return ""
    return re.sub(r"\s+", " ", _LEAD_PREFIX_RE.sub("", line)).strip()


def _fallback_colon_tail(text: str) -> str:
    if text.endswith("：") or text.endswith(":"):
        return f"{text[:-1]}。"
    return text


def _fallback_derive(text: str) -> str:
    if len(text) < 2 or not _ALNUM_CJK_RE.search(text):
        return ""
    if len(text) <= _FALLBACK_SUMMARY_LIMIT:
        whole = _fallback_colon_tail(_fallback_trim_tail(_fallback_strip_markdown(text)))
        if len(whole) >= 2 and _ALNUM_CJK_RE.search(whole):
            return whole
        return ""
    positions = [m.start() for m in _SENTINEL_RE.finditer(text)]
    in_limit = [idx for idx in positions if idx < _FALLBACK_SUMMARY_LIMIT]
    cut = in_limit[-1] if in_limit else (positions[0] if positions else None)
    if cut is not None:
        derived = _fallback_trim_tail(_fallback_strip_markdown(text[: cut + 1]))
        if len(derived) >= 15:
            return _fallback_colon_tail(derived)
    whole = _fallback_colon_tail(_fallback_trim_tail(_fallback_strip_markdown(text)))
    if len(whole) >= 2 and _ALNUM_CJK_RE.search(whole):
        return whole
    return ""


def fallback_summary(raw: str) -> str:
    trimmed = "".join(
        n["raw"] for n in scan_transcript(raw) if n["kind"] not in ("thinking", "pending")
    ).strip()
    if _FALLBACK_ERROR_RE.match(trimmed):
        return ""
    lead = _fallback_lead_line(trimmed)
    if not lead:
        return ""
    return _fallback_derive(lead)


def _select_transcript_turns(leading: str, turns: list[dict[str, Any]]) -> dict[str, Any]:
    final_body = ""
    final_turn_index: int | None = None
    final_ask_user: dict[str, Any] | None = None
    stopped = False
    terminal_index = len(turns) - 1
    while terminal_index >= 0 and not turns[terminal_index]["content"].strip():
        terminal_index -= 1
    for index in range(len(turns) - 1, -1, -1):
        turn_content = turns[index]["content"]
        if not turn_content.strip():
            continue
        if index == terminal_index and _is_dangling_tool_turn(turn_content):
            stopped = True
            continue
        has_ask = _last_ask_user_node(turn_content) is not None
        payload = extract_ask_user_payload(turn_content) if has_ask else None
        final_ask_user = payload if (payload and len(payload["candidates"]) > 0) else None
        final_body = _project_final_body(turn_content, "" if final_ask_user else None)
        final_turn_index = index if has_ask else None
        break
    return {
        "leading": leading,
        "turns": turns,
        "finalBody": final_body,
        "finalTurnIndex": final_turn_index,
        "finalAskUser": final_ask_user,
        "stopped": stopped,
    }


def parse_assistant_transcript(
    text: str,
    streaming: bool = False,
    turn_segments: Any = None,
) -> dict[str, Any]:
    trusted = valid_turn_segments(turn_segments, text)
    if trusted is not None:
        opaque = [
            n
            for n in scan_transcript(text)
            if n["kind"] not in ("text", "turn")
            and not (n["kind"] == "thinking" and not n["complete"])
        ]
        offset = 0
        for part in trusted[:-1]:
            offset += len(part)
            if any(n["start"] < offset < n["end"] for n in opaque):
                trusted = None
                break
    if trusted is not None:
        turns: list[dict[str, Any]] = []
        for idx, part in enumerate(trusted):
            raw_content = _ANCHORED_TURN_HEADER_RE.sub(
                "", strip_final_response_marker(part).strip()
            ).strip()
            turn_entry: dict[str, Any] = {
                "turn": idx + 1,
                "summary": _extract_summary(raw_content) or fallback_summary(raw_content),
                "content": _strip_trace_meta(raw_content),
            }
            if any(n["kind"] == "thinking" for n in scan_transcript(raw_content)):
                turn_entry["rawContent"] = raw_content
            turns.append(turn_entry)
        return _select_transcript_turns("", turns)

    source = strip_final_response_marker(text)
    safe = "".join(
        n["raw"]
        for n in scan_transcript(source)
        if not streaming or not (not n["complete"] and n["kind"] in ("summary", "pending"))
    )
    matches = [n for n in scan_transcript(safe) if n["kind"] == "turn"]
    if not matches:
        payload = extract_ask_user_payload(safe)
        final_ask_user = payload if (payload and len(payload["candidates"]) > 0) else None
        return {
            "leading": "",
            "turns": [],
            "finalBody": _project_final_body(safe, "" if final_ask_user else None),
            "finalTurnIndex": None,
            "finalAskUser": final_ask_user,
            "stopped": False,
        }

    leading = _strip_trace_meta(safe[: matches[0]["start"]])
    turns = []
    for idx, match in enumerate(matches):
        start = match["end"]
        end = matches[idx + 1]["start"] if idx + 1 < len(matches) else len(safe)
        raw_content = safe[start:end].strip()
        turn_entry = {
            "turn": match["turn"],
            "summary": _extract_summary(raw_content) or fallback_summary(raw_content),
            "content": _strip_trace_meta(raw_content),
        }
        if any(n["kind"] == "thinking" for n in scan_transcript(raw_content)):
            turn_entry["rawContent"] = raw_content
        turns.append(turn_entry)
    return _select_transcript_turns(leading, turns)


# ---------------------------------------------------------------------------
# 4. Reply segments & snapshot merge (replySegments.ts + messageModel.ts)
# ---------------------------------------------------------------------------

_HIDDEN_SOURCES = frozenset(("wechat",))
_ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS = 2 * 60 * 1000


def _is_hidden_source(source: Any) -> bool:
    return isinstance(source, str) and source in _HIDDEN_SOURCES


def _epoch_ms(value: Any) -> float | None:
    if not value or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return value * 1000 if value < 1e12 else value


def _now_ms() -> int:
    return int(time.time() * 1000)


def _belongs_to_run(message: dict[str, Any], run_id: Any) -> bool:
    return message.get("runId") == run_id


def _update_reply_segments(
    previous: list[dict[str, Any]],
    stream_id: str,
    phase: str,
    content: str | None = None,
    turn_segments: Any = None,
) -> list[dict[str, Any]]:
    index = next((i for i, p in enumerate(previous) if p.get("streamId") == stream_id), -1)
    old = None if index < 0 else previous[index]
    if old and old.get("archived") and phase == "started":
        return list(previous)
    if old and old.get("done") and not old.get("archived") and phase != "done":
        return list(previous)
    if (
        old
        and not old.get("archived")
        and content is not None
        and old.get("content") != content
        and str(old.get("content", "")).startswith(content)
    ):
        return list(previous)
    old_content = old.get("content", "") if old else ""
    new_content = old_content if phase == "started" else (content if content is not None else old_content)
    t_segs = valid_turn_segments(turn_segments, content if content is not None else old_content)
    if t_segs is None and (content is None or content == old_content):
        t_segs = old.get("turnSegments") if old else None
    part: dict[str, Any] = {
        "streamId": stream_id,
        "content": new_content,
        "done": phase == "done" or (bool(old.get("done")) and not old.get("archived")) if old else (phase == "done"),
    }
    if t_segs is not None:
        part["turnSegments"] = t_segs
    if index < 0:
        return [*previous, part]
    nxt = list(previous)
    nxt[index] = part
    return nxt


def _reply_segments_content(parts: list[dict[str, Any]]) -> str:
    return "\n\n".join(p["content"] for p in parts if p.get("content"))


def _reply_segments_turns(parts: list[dict[str, Any]]) -> list[str] | None:
    if not any(valid_turn_segments(p.get("turnSegments"), p.get("content", "")) for p in parts):
        return None
    result: list[str] = []
    for part in parts:
        content = part.get("content", "")
        if not content:
            continue
        trusted = valid_turn_segments(part.get("turnSegments"), content)
        if trusted is not None:
            turns = list(trusted)
        else:
            starts = [n["start"] for n in scan_transcript(content) if n["kind"] == "turn"]
            cuts = sorted({0, *starts, len(content)})
            turns = [content[cuts[i] : cuts[i + 1]] for i in range(len(cuts) - 1)]
        if result and turns:
            turns[0] = "\n\n" + turns[0]
        result.extend(turns)
    return result if result else None


def _upsert_retry_notice(
    prev: list[dict[str, Any]],
    retry_key: str,
    content: str,
    timestamp: float | None = None,
    retry_stream_id: str | None = None,
    run_id: str | None = None,
) -> list[dict[str, Any]]:
    idx = next(
        (
            i
            for i, m in enumerate(prev)
            if m.get("role") == "assistant"
            and _belongs_to_run(m, run_id)
            and (
                m.get("logicalId") == retry_key
                or m.get("streamId") == retry_key
                or any(p.get("streamId") == retry_key for p in (m.get("segments") or []))
            )
        ),
        -1,
    )
    notice = re.sub(r"^_|_\Z", "", content)
    if idx < 0:
        return [
            *prev,
            {
                "role": "assistant",
                "content": "",
                "streamId": retry_key,
                "logicalId": retry_key,
                "runId": run_id,
                "recoveryNotice": notice,
                "recoveryOffset": 0,
                "recoveryStreamId": retry_stream_id,
                "segments": [],
                "timestamp": timestamp,
            },
        ]
    nxt = list(prev)
    old = prev[idx]
    segs = old.get("segments") or []
    part_index = (
        next((i for i, p in enumerate(segs) if p.get("streamId") == retry_stream_id), -1)
        if retry_stream_id
        else -1
    )
    offset = (
        len(_reply_segments_content(segs[:part_index]))
        if part_index >= 0
        else len(old.get("content", ""))
    )
    nxt[idx] = {
        **old,
        "recoveryNotice": notice,
        "recoveryOffset": (
            old.get("recoveryOffset", offset)
            if (retry_stream_id and old.get("recoveryStreamId") == retry_stream_id and old.get("recoveryOffset") is not None)
            else offset
        ),
        "recoveryStreamId": retry_stream_id,
    }
    return nxt


def _merge_run_reply(old: dict[str, Any], incoming: dict[str, Any]) -> dict[str, Any]:
    segments = list(old.get("segments") or [])
    archive_cursor = 0
    for part in incoming.get("segments") or []:
        index = next((i for i, p in enumerate(segments) if p.get("streamId") == part.get("streamId")), -1)
        if index < 0 and part.get("content"):
            for i in range(archive_cursor, len(segments)):
                prev_p = segments[i]
                prev_content = prev_p.get("content", "")
                if (
                    str(prev_p.get("streamId", "")).startswith("history:")
                    and prev_content
                    and (part["content"].startswith(prev_content) or prev_content.startswith(part["content"]))
                ):
                    index = i
                    archive_cursor = i + 1
                    break
        if index < 0:
            segments.append(dict(part))
        else:
            prev_p = segments[index]
            from_archive = bool(prev_p.get("archived")) or str(prev_p.get("streamId", "")).startswith("history:")
            keep_prev = (not part.get("content")) if from_archive else str(prev_p.get("content", "")).startswith(part.get("content", ""))
            merged_part = dict(part)
            merged_part["content"] = prev_p.get("content", "") if keep_prev else part.get("content", "")
            if prev_p.get("content") == part.get("content"):
                merged_part["turnSegments"] = part.get("turnSegments") if part.get("turnSegments") is not None else prev_p.get("turnSegments")
            else:
                merged_part["turnSegments"] = prev_p.get("turnSegments") if keep_prev else part.get("turnSegments")
            merged_part["archived"] = prev_p.get("archived") if keep_prev else part.get("archived")
            merged_part["done"] = bool(part.get("done")) or ((not from_archive) and bool(prev_p.get("done")))
            segments[index] = merged_part
    merged = {
        **old,
        **incoming,
        "segments": segments,
        "content": _reply_segments_content(segments),
        "turnSegments": _reply_segments_turns(segments),
    }
    return merged


def _update_logical_reply(prev: list[dict[str, Any]], evt: dict[str, Any], now: float) -> list[dict[str, Any]]:
    sid = evt.get("stream_id", "")
    key = evt.get("logical_id") or evt.get("retry_of") or sid
    run_id = evt.get("run_id")
    idx = next(
        (
            i
            for i, m in enumerate(prev)
            if m.get("role") == "assistant"
            and _belongs_to_run(m, run_id)
            and (
                bool(run_id)
                or m.get("logicalId") == key
                or m.get("streamId") == key
                or m.get("streamId") == sid
                or any(
                    p.get("streamId") in (sid, evt.get("retry_of"))
                    for p in (m.get("segments") or [])
                )
            )
        ),
        -1,
    )
    old = None if idx < 0 else prev[idx]
    if old and old.get("outcome"):
        return prev
    if old and old.get("segments") is not None:
        initial = old["segments"]
    elif old and old.get("streamId"):
        initial = [{
            "streamId": old["streamId"],
            "content": old.get("content", ""),
            "done": not old.get("streaming") and not old.get("stopped"),
        }]
    else:
        initial = []
    if evt.get("type") == "started" and any(p.get("streamId") == sid for p in initial):
        return prev
    has_content = "content" in evt
    content_val = evt.get("content") if has_content else None
    part = _update_reply_segments([], sid, evt["type"], content_val, evt.get("turn_segs"))
    if old and old.get("runId"):
        segments = _merge_run_reply({**old, "segments": initial}, {**old, "segments": part})["segments"]
    else:
        segments = _update_reply_segments(initial, sid, evt["type"], content_val, evt.get("turn_segs"))
    latest = segments[-1]
    streaming = not (old and old.get("stopped")) and not latest.get("done")
    message: dict[str, Any] = {
        **(old or {}),
        "role": "assistant",
        "logicalId": (old.get("logicalId") if old else None) or key,
        "runId": run_id or (old.get("runId") if old else None),
        "streamId": (old.get("streamId") if old else None) or sid,
        "source": (old.get("source") if old else None) or evt.get("source"),
        "segments": segments,
        "content": _reply_segments_content(segments),
        "turnSegments": _reply_segments_turns(segments),
        "streaming": streaming,
        "timestamp": old["timestamp"] if (old and old.get("timestamp") is not None) else now,
        "startedAt": old["startedAt"] if (old and old.get("startedAt") is not None) else now,
        "finishedAt": None if streaming else (old["finishedAt"] if (old and old.get("finishedAt") is not None) else now),
    }
    if not streaming:
        message["recoveryNotice"] = None
        message["recoveryOffset"] = None
        message["recoveryStreamId"] = None
    if idx < 0:
        return [*prev, message]
    nxt = list(prev)
    nxt[idx] = message
    return nxt


def _apply_snapshot(streams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    retry_notice_entries: dict[str, dict[str, Any]] = {}

    def retry_notice_label(s: dict[str, Any], attempt: int) -> str:
        state_str = "已完成" if s.get("done") else "进行中"
        attempt_str = str(attempt or "?")
        max_str = f"/{s['retry_max']}" if s.get("retry_max") else ""
        reason_str = f" · {s['retry_reason']}" if s.get("retry_reason") else ""
        return f"_自动重试请求{state_str}（{attempt_str}{max_str}{reason_str}）。_"

    for s in streams:
        if _is_hidden_source(s.get("source")):
            continue
        if s.get("source") in ("chat_error_retry", "auto_continue"):
            attempt = s.get("retry_attempt") or 0
            done = bool(s.get("done"))
            retry_key = s.get("logical_id") or s.get("retry_of") or s.get("stream_id") or ""
            notice_key = f"{s.get('run_id') or 'legacy'}:{retry_key}"
            meta = retry_notice_entries.get(notice_key)
            if not done and (meta is None or attempt > meta["attempt"]):
                retry_notice_entries[notice_key] = {"idx": 0, "attempt": attempt, "done": done}
                out = _upsert_retry_notice(
                    out,
                    retry_key,
                    retry_notice_label(s, attempt),
                    _epoch_ms(s.get("started_at")),
                    s.get("stream_id"),
                    s.get("run_id"),
                )
            if s.get("content") or not done:
                ts = _epoch_ms(s.get("finished_at") if done else s.get("started_at"))
                out = _update_logical_reply(
                    out,
                    {
                        "type": "done" if done else "next",
                        "stream_id": s.get("stream_id"),
                        "logical_id": s.get("logical_id"),
                        "run_id": s.get("run_id"),
                        "retry_of": s.get("retry_of"),
                        "source": s.get("source"),
                        "content": s.get("content", ""),
                        "turn_segs": s.get("turn_segs"),
                    },
                    ts if ts is not None else _now_ms(),
                )
            continue
        if s.get("query"):
            out.append({
                "role": "user",
                "content": s["query"],
                "logicalId": s.get("logical_id"),
                "runId": s.get("run_id"),
                "streamId": s.get("stream_id"),
                "source": s.get("source"),
                "timestamp": _epoch_ms(s.get("started_at")),
            })
        if s.get("content") or not s.get("done"):
            content = s.get("content", "")
            t_segs = valid_turn_segments(s.get("turn_segs"), content)
            done = bool(s.get("done"))
            out.append({
                "role": "assistant",
                "content": content,
                "logicalId": s.get("logical_id"),
                "runId": s.get("run_id"),
                "outcome": s.get("outcome"),
                "turnSegments": t_segs,
                "segments": [{
                    "streamId": s.get("stream_id"),
                    "content": content,
                    "done": done,
                    "turnSegments": t_segs,
                }],
                "streamId": s.get("stream_id"),
                "source": s.get("source"),
                "streaming": not done,
                "startedAt": _epoch_ms(s.get("started_at")),
                "timestamp": _epoch_ms(s.get("finished_at") if done else s.get("started_at")),
            })
    return out


def _timestamps_overlap(a: dict[str, Any], b: dict[str, Any]) -> bool:
    ta, tb = a.get("timestamp"), b.get("timestamp")
    if ta is None or tb is None:
        return True
    return abs(ta - tb) <= _ARCHIVE_SNAPSHOT_TIME_TOLERANCE_MS


def _pairs_describe_same_turn(
    archived_q: dict[str, Any],
    archived_a: dict[str, Any],
    query: dict[str, Any],
    answer: dict[str, Any],
) -> bool:
    if archived_q.get("role") != "user" or archived_a.get("role") != "assistant":
        return False
    if archived_q.get("runId") or query.get("runId"):
        return bool(archived_q.get("runId")) and archived_q.get("runId") == query.get("runId")
    if archived_q.get("logicalId") or query.get("logicalId"):
        return bool(archived_q.get("logicalId")) and archived_q.get("logicalId") == query.get("logicalId")
    if archived_q.get("content") != query.get("content"):
        return False
    if not _timestamps_overlap(archived_q, query) or not _timestamps_overlap(archived_a, answer):
        return False
    temporal = (
        archived_q.get("timestamp") is not None
        and query.get("timestamp") is not None
        and archived_a.get("timestamp") is not None
        and answer.get("timestamp") is not None
    )
    if not temporal and archived_a.get("content") != answer.get("content"):
        return False
    return True


def _remove_archived_snapshot_overlap(base: list[dict[str, Any]], live: list[dict[str, Any]]) -> list[dict[str, Any]]:
    archived = [m for m in base if m.get("source") == "history"]
    skipped: set[int] = set()
    for index in range(len(live) - 1):
        query = live[index]
        answer = live[index + 1]
        if (
            query.get("role") != "user"
            or answer.get("role") != "assistant"
            or query.get("streamId") is None
            or query.get("streamId") != answer.get("streamId")
            or answer.get("streaming") is not False
        ):
            continue
        for h_idx in range(len(archived) - 2, -1, -1):
            if _pairs_describe_same_turn(archived[h_idx], archived[h_idx + 1], query, answer):
                skipped.add(index)
                skipped.add(index + 1)
                break
    return [m for i, m in enumerate(live) if i not in skipped]


def _live_position_key(msg: dict[str, Any]) -> str | None:
    identity = msg.get("runId") or msg.get("logicalId") or msg.get("streamId")
    if not identity:
        return None
    return f"{identity}\x00{msg.get('role')}"


def _order_conversation_turns(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    runs: dict[str, dict[str, Any]] = {}
    legacy: dict[str, Any] | None = None
    for message in messages:
        if message.get("runId") and not message.get("pendingWebui"):
            turn = runs.get(message["runId"])
            if turn is None:
                turn = {"messages": [], "anchor": None}
                runs[message["runId"]] = turn
                turns.append(turn)
            legacy = None
        elif (
            message.get("role") == "assistant"
            and not message.get("runId")
            and message.get("source") not in ("system", "runtime_error_notice")
            and legacy is not None
            and (
                message.get("source") == "history"
                or (message.get("streamId") is not None and legacy["messages"][0].get("streamId") == message.get("streamId"))
            )
        ):
            turn = legacy
        else:
            turn = {"messages": [], "anchor": None}
            turns.append(turn)
            legacy = (
                turn
                if (message.get("role") == "user" and not message.get("runId") and not message.get("pendingWebui"))
                else None
            )
        turn["messages"].append(message)
        ts = message.get("timestamp")
        if (
            message.get("role") == "user"
            and not message.get("pendingWebui")
            and isinstance(ts, (int, float))
            and math.isfinite(ts)
        ):
            turn["anchor"] = ts if turn["anchor"] is None else min(turn["anchor"], ts)

    for turn in turns:
        if turn["anchor"] is not None:
            continue
        for message in turn["messages"]:
            started = message.get("startedAt")
            if (
                message.get("role") == "assistant"
                and isinstance(started, (int, float))
                and math.isfinite(started)
                and message.get("source") not in ("system", "runtime_error_notice")
            ):
                turn["anchor"] = started if turn["anchor"] is None else min(turn["anchor"], started)

    dated = sorted((t for t in turns if t["anchor"] is not None), key=lambda t: t["anchor"])
    d_idx = 0
    ordered: list[dict[str, Any]] = []
    for turn in turns:
        if turn["anchor"] is None:
            selected = turn
        else:
            selected = dated[d_idx]
            d_idx += 1
        msgs = selected["messages"]
        if any(m.get("role") == "user" for m in msgs):
            ordered.extend(m for m in msgs if m.get("role") == "user")
            ordered.extend(m for m in msgs if m.get("role") != "user")
        else:
            ordered.extend(msgs)
    return ordered


def _merge_live(base: list[dict[str, Any]], live: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = list(base)
    adopted: set[int] = set()
    for i in range(len(live) - 1):
        query = live[i]
        answer = live[i + 1]
        if (
            query.get("role") != "user"
            or answer.get("role") != "assistant"
            or not answer.get("streaming")
            or not query.get("streamId")
            or query.get("streamId") != answer.get("streamId")
            or query.get("timestamp") is None
        ):
            continue
        for j in range(len(out) - 2, -1, -1):
            aq, aa = out[j], out[j + 1]
            if (
                aq.get("source") != "history"
                or aa.get("source") != "history"
                or aq.get("role") != "user"
                or aa.get("role") != "assistant"
                or aq.get("runId")
                or query.get("runId")
                or aq.get("logicalId")
                or query.get("logicalId")
                or aq.get("content") != query.get("content")
                or aq.get("timestamp") is None
                or not _timestamps_overlap(aq, query)
            ):
                continue
            out[j] = {**aq, **query}
            out[j + 1] = {**aa, **answer}
            adopted.add(id(query))
            adopted.add(id(answer))
            break

    positions: dict[str, int] = {}
    for idx, m in enumerate(out):
        key = _live_position_key(m)
        if key:
            positions[key] = idx
    for msg in _remove_archived_snapshot_overlap(base, live):
        if id(msg) in adopted:
            continue
        key = _live_position_key(msg)
        if key and key in positions:
            idx = positions[key]
            old = out[idx]
            if old.get("outcome"):
                continue
            old_c = old.get("content", "")
            msg_c = msg.get("content", "")
            if old_c.startswith(msg_c) and len(old_c) > len(msg_c):
                continue
            if old.get("role") == "assistant" and old.get("runId") and old.get("runId") == msg.get("runId"):
                out[idx] = _merge_run_reply(old, msg)
            else:
                merged = {**old, **msg}
                if old.get("role") == "user" and old.get("runId") and old.get("runId") == msg.get("runId"):
                    ts_candidates = [t for t in (old.get("timestamp"), msg.get("timestamp")) if t is not None]
                    merged["timestamp"] = min(ts_candidates) if ts_candidates else None
                out[idx] = merged
            continue
        out.append(msg)
        if key:
            positions[key] = len(out) - 1
    return _order_conversation_turns(out)


def _ensure_retry_start_notice(prev: list[dict[str, Any]], evt: dict[str, Any]) -> list[dict[str, Any]]:
    if evt.get("type") not in ("next", "done"):
        return prev
    if evt.get("source") not in ("chat_error_retry", "auto_continue"):
        return prev
    if any(
        _belongs_to_run(m, evt.get("run_id"))
        and any(p.get("streamId") == evt.get("stream_id") and p.get("done") for p in (m.get("segments") or []))
        for m in prev
    ):
        return prev
    attempt = evt.get("retry_attempt") or 0
    retry_key = evt.get("logical_id") or evt.get("retry_of") or evt.get("stream_id") or ""
    reason = "截断续接" if evt.get("retry_reason") == "truncated" else "网络重试"
    max_str = f"/{evt['retry_max']}" if evt.get("retry_max") else ""
    note = f"_系统{reason}（{attempt or '?'}{max_str}）。_"
    return _upsert_retry_notice(prev, retry_key, note, None, evt.get("stream_id"), evt.get("run_id"))


def _apply_event(prev: list[dict[str, Any]], evt: dict[str, Any]) -> list[dict[str, Any]]:
    etype = evt.get("type")
    if etype == "session_runtime":
        if evt.get("status") == "running" and evt.get("run_id"):
            return [
                {**m, "streaming": True, "finishedAt": None}
                if (m.get("role") == "assistant" and m.get("runId") == evt["run_id"] and not m.get("outcome") and not m.get("stopped"))
                else m
                for m in prev
            ]
        if evt.get("status") != "idle" or not evt.get("completed_run_id") or not evt.get("outcome"):
            return prev
        now = _now_ms()
        return [
            {
                **m,
                "streaming": False,
                "recoveryNotice": None,
                "recoveryOffset": None,
                "recoveryStreamId": None,
                "outcome": evt["outcome"],
                "stopped": evt["outcome"] == "cancelled",
                "finishedAt": m["finishedAt"] if m.get("finishedAt") is not None else now,
            }
            if (m.get("role") == "assistant" and m.get("runId") == evt["completed_run_id"])
            else m
            for m in prev
        ]
    if etype in ("next", "done") and (evt.get("run_id") or evt.get("logical_id")):
        if _is_hidden_source(evt.get("source")):
            return prev
        return _update_logical_reply(prev, evt, _now_ms())
    now = _now_ms()
    if etype == "next":
        if _is_hidden_source(evt.get("source")):
            return prev
        return _update_logical_reply(_ensure_retry_start_notice(prev, evt), evt, now)
    if etype == "done":
        if _is_hidden_source(evt.get("source")):
            return prev
        nxt = _ensure_retry_start_notice(prev, evt)
        if evt.get("source") != "system":
            return _update_logical_reply(nxt, evt, now)
        sid = evt.get("stream_id")
        idx = next((i for i, m in enumerate(nxt) if m.get("role") in ("assistant", "system") and m.get("streamId") == sid), -1)
        if idx < 0:
            return [*nxt, {"role": "system", "content": evt.get("content", ""), "streamId": sid, "source": "system", "streaming": False, "timestamp": now, "startedAt": now, "finishedAt": now}]
        updated = list(nxt)
        updated[idx] = {**updated[idx], "content": evt.get("content", ""), "streaming": False, "timestamp": now, "finishedAt": now}
        return updated
    return prev


def _settle_snapshot(msgs: list[dict[str, Any]], event: dict[str, Any]) -> list[dict[str, Any]]:
    runtime = event.get("runtime") if isinstance(event.get("runtime"), dict) else {}
    state = {**event, **runtime}
    completed_run_id = runtime.get("completed_run_id") if "completed_run_id" in runtime else event.get("completed_run_id")
    outcome = runtime.get("outcome") if "outcome" in runtime else event.get("outcome")
    settled = _apply_event(
        msgs,
        {
            "type": "session_runtime",
            "session_id": event.get("session_id") or "",
            "status": state.get("status") or "",
            "run_id": state.get("run_id") or "",
            "stream_id": state.get("stream_id"),
            "completed_run_id": completed_run_id,
            "outcome": outcome,
        },
    )
    active_msg = event.get("active_message")
    streams = event.get("streams") or []
    if (
        runtime.get("status") != "idle"
        or (isinstance(active_msg, dict) and not active_msg.get("done"))
        or any(not s.get("done") for s in streams if isinstance(s, dict))
    ):
        return settled
    now = _now_ms()
    return [
        {
            **m,
            "streaming": False,
            "finishedAt": m["finishedAt"] if m.get("finishedAt") is not None else now,
            "recoveryNotice": None,
            "recoveryOffset": None,
            "recoveryStreamId": None,
        }
        if (m.get("role") == "assistant" and m.get("streaming"))
        else m
        for m in settled
    ]


def merge_session_snapshot(base: list[dict[str, Any]], event: dict[str, Any]) -> list[dict[str, Any]]:
    base = [
        _settle_snapshot([m], event)[0] if m.get("source") == "history" else m
        for m in base
    ]
    active = event.get("active_message")
    raw_streams = event.get("streams")
    if isinstance(active, dict) and active.get("query") and active.get("ts") is not None:
        existing_list = raw_streams if isinstance(raw_streams, list) else []
        existing = next((s for s in existing_list if isinstance(s, dict) and s.get("stream_id") == active.get("stream_id")), None)
        t_segs = active.get("turn_segs")
        if t_segs is None and existing is not None and active.get("content") == existing.get("content"):
            t_segs = existing.get("turn_segs")
        merged_stream = {
            **(existing or {}),
            "run_id": active.get("run_id") or event.get("run_id") or None,
            "logical_id": active.get("logical_id") or (existing.get("logical_id") if existing else None),
            "retry_of": active.get("retry_of") or (existing.get("retry_of") if existing else None),
            "retry_attempt": active.get("retry_attempt") if active.get("retry_attempt") is not None else (existing.get("retry_attempt") if existing else None),
            "retry_max": active.get("retry_max") if active.get("retry_max") is not None else (existing.get("retry_max") if existing else None),
            "retry_reason": active.get("retry_reason") or (existing.get("retry_reason") if existing else None),
            "stream_id": active.get("stream_id"),
            "source": active.get("source") if active.get("source") is not None else ((existing.get("source") if existing else None) or "webui"),
            "query": active.get("query"),
            "started_at": active.get("ts"),
            "finished_at": existing.get("finished_at", 0) if existing else 0,
            "content": active.get("content", ""),
            "turn_segs": t_segs,
            "done": bool(active.get("done")),
        }
        streams = [s for s in existing_list if not isinstance(s, dict) or s.get("stream_id") != active.get("stream_id")]
        streams.append(merged_stream)
        return _order_conversation_turns(_settle_snapshot(_merge_live(base, _apply_snapshot(streams)), event))

    msgs = _merge_live(base, _apply_snapshot(raw_streams)) if isinstance(raw_streams, list) else base
    if isinstance(active, dict):
        msgs = _apply_event(
            msgs,
            {
                "type": "done" if active.get("done") else "next",
                "stream_id": active.get("stream_id"),
                "content": active.get("content", ""),
                "turn_segs": active.get("turn_segs"),
                "run_id": active.get("run_id"),
                "logical_id": active.get("logical_id"),
                "source": active.get("source"),
                "retry_of": active.get("retry_of"),
            },
        )
    return _order_conversation_turns(_settle_snapshot(msgs, event))


# ---------------------------------------------------------------------------
# 5. Remote presentation & progress (messagePresentation.ts)
# ---------------------------------------------------------------------------

_META_KEYS = (
    "id",
    "role",
    "ordinal",
    "timestamp",
    "session_id",
    "run_id",
    "logical_id",
    "stream_id",
    "archive_generation",
    "outcome",
    "attachments",
    "artifacts",
    "streaming",
)
_RUNTIME_KEYS = ("status", "run_id", "stream_id", "completed_run_id", "outcome", "error")


def _prose(text: str) -> str:
    parts: list[str] = []
    for node in scan_transcript(text):
        if node["kind"] in ("text", "code"):
            parts.append(node["raw"])
        elif node["kind"] == "tool" and node["complete"] and _tool_short_name(node.get("name")).lower() == "ask_user":
            question = extract_ask_user_payload(node["raw"])
            if question:
                parts.append("\n\n" + render_ask_user_payload(question) + "\n\n")
    return "".join(parts).strip()


def remote_message_presentation(source: dict[str, Any]) -> dict[str, Any]:
    raw_content = source.get("content")
    content = "" if raw_content is None else str(raw_content)
    meta: dict[str, Any] = {"compact": True}
    for key in _META_KEYS:
        if key in source and source[key] is not None:
            meta[key] = source[key]
        elif key in source and key in ("outcome", "timestamp"):
            # JS `source[key] !== undefined` preserves explicit null values!
            meta[key] = None
    if source.get("role") != "assistant":
        return {**meta, "content": content}
    segs = source.get("turn_segs") if source.get("turn_segs") is not None else source.get("turn_segments")
    parsed = parse_assistant_transcript(content, bool(source.get("streaming")), segs)
    return {
        **meta,
        "content": _prose(content),
        "progress": {
            "turns": [
                {
                    "turn": turn["turn"],
                    "summary": turn["summary"],
                    "content": _prose(turn["content"]),
                }
                for turn in parsed["turns"]
            ],
            "turn_count": len(parsed["turns"]),
            "final_body": _prose(parsed["finalBody"]),
            "question": parsed["finalAskUser"],
        },
    }


def remote_message_page(data: dict[str, Any]) -> dict[str, Any]:
    items = data.get("items") or []
    return {
        **data,
        "presentation_version": 1,
        "items": [remote_message_presentation(item) for item in items],
    }


def remote_progress(frame: dict[str, Any]) -> dict[str, Any]:
    runtime = frame.get("runtime") or frame
    sid = frame.get("session_id")
    streams = frame.get("streams") or []
    active_message = frame.get("active_message")
    if (
        not sid
        or (isinstance(runtime, dict) and "session_id" in runtime and runtime["session_id"] != sid)
        or any(isinstance(row, dict) and "session_id" in row and row["session_id"] != sid for row in streams)
        or (isinstance(active_message, dict) and "session_id" in active_message and active_message["session_id"] != sid)
    ):
        raise ValueError("Snapshot session mismatch")
    messages = merge_session_snapshot([], frame)
    items: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        item_source: dict[str, Any] = {
            "id": f"{sid}:{message['role']}:{message.get('runId') or message.get('logicalId') or message.get('streamId') or index}",
            "session_id": sid,
            "role": message["role"],
            "content": message.get("content", ""),
        }
        for src_key, dst_key in (
            ("runId", "run_id"),
            ("logicalId", "logical_id"),
            ("streamId", "stream_id"),
            ("timestamp", "timestamp"),
            ("streaming", "streaming"),
            ("turnSegments", "turn_segs"),
            ("outcome", "outcome"),
        ):
            if message.get(src_key) is not None:
                item_source[dst_key] = message[src_key]
        items.append(remote_message_presentation(item_source))
    state: dict[str, Any] = {"session_id": sid}
    if isinstance(runtime, dict):
        for key in _RUNTIME_KEYS:
            if key in runtime:
                state[key] = runtime[key]
    result: dict[str, Any] = {
        "type": "progress",
        "session_id": sid,
        "runtime": state,
        "items": items,
        "presentation_version": 1,
    }
    if "epoch" in frame:
        result["epoch"] = frame["epoch"]
    return result
