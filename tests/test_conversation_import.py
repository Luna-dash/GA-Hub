"""Import a GA archive as a new session: copy, sanitise, bind, roll back.

The source archive is IM (feishu/wechat) shaped: GA prepends ``FILE_HINT`` to
every prompt it hands the agent, so the archived user turn carries the header
and the working-memory injections echo it back as ``[USER]: <hint>  <原话>``.
An imported copy must not carry that plumbing into a hub session — and must
never write a byte back into the source.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.error_mapping import install_error_handlers
from server.routes import conversations
from server.services import archive_import
from server.services.archive_import import (
    ArchiveNotImportableError,
    copy_archive_for_import,
    prepare_import_text,
    strip_file_hints,
    trim_incomplete_tail,
)
from server.services.archive_messages import _FILE_HINT
from server.services.session_metadata import SessionMetadataStore
from server.services.session_runtime_factory import RuntimeRestoreError

_PROMPT_BLOCK_RE = re.compile(
    r"^=== Prompt ===[^\n]*\n(.*?)(?=^=== (?:Prompt|Response) ===|\Z)",
    re.DOTALL | re.MULTILINE,
)
_RESPONSE_BLOCK_RE = re.compile(
    r"^=== Response ===[^\n]*\n(.*?)(?=^=== (?:Prompt|Response) ===|\Z)",
    re.DOTALL | re.MULTILINE,
)


def _hinted(text: str) -> str:
    """Prompt text exactly as an IM frontend archives it."""
    return f"{_FILE_HINT}\n\n{text}"


def _prompt(blocks: list[dict], stamp: str = "09:00:01") -> str:
    payload = {"role": "user", "content": blocks}
    return (
        f"=== Prompt === 2026-09-15 {stamp}\n"
        f"{json.dumps(payload, ensure_ascii=False)}\n"
    )


def _response(text: str, stamp: str = "09:00:02") -> str:
    return f"=== Response === 2026-09-15 {stamp}\n{[{'type': 'text', 'text': text}]!r}\n"


def _working_memory(question: str, turn: int = 3) -> str:
    """GA's anchor prompt, echoing the earlier prompt verbatim like the archive."""
    return (
        "\n### [WORKING MEMORY]\n<history>\n[USER]: "
        f"{_FILE_HINT}  {question}\n</history>\nCurrent turn: {turn}\n"
    )


def _question_turn(text: str, stamp: str = "09:00:01") -> str:
    return _prompt([{"type": "text", "text": text}], stamp) + _response(
        "回答", stamp
    )


def _tool_turn(stamp: str = "09:00:03") -> str:
    """One auto-continuation: tool_result + working memory, both hint-bearing."""
    return _prompt(
        [
            {"type": "tool_result", "tool_use_id": "call_1",
             "content": '{"stdout": "ok", "exit_code": 0}'},
            {"type": "text", "text": _working_memory("第一个问题")},
        ],
        stamp,
    ) + _response("第二个回答", stamp)


def _im_archive() -> str:
    return _question_turn(_hinted("第一个问题")) + _tool_turn()


def _prompt_messages(text: str | Path) -> list[dict]:
    return [json.loads(body) for body in _PROMPT_BLOCK_RE.findall(_read(text))]


def _response_bodies(text: str | Path) -> list[str]:
    return _RESPONSE_BLOCK_RE.findall(_read(text))


def _read(text: str | Path) -> str:
    return text.read_text(encoding="utf-8") if isinstance(text, Path) else text


def _text_blocks(message: dict) -> list[str]:
    return [b["text"] for b in message["content"] if b["type"] == "text"]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _app() -> FastAPI:
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(conversations.router)
    return app


class _Coordinator:
    """Stand-in for the shared coordinator; records cold starts."""

    def __init__(self, error: Exception | None = None) -> None:
        self.ensured: list[str] = []
        self.error = error

    def ensure_runtime(self, session_id: str):
        self.ensured.append(session_id)
        if self.error is not None:
            raise self.error
        return object()


# ── FILE_HINT cleaning ────────────────────────────────────────────
def test_strip_file_hints_cleans_prompts_and_leaves_responses_alone() -> None:
    archive = _im_archive()

    cleaned = strip_file_hints(archive)

    assert _FILE_HINT not in cleaned
    # The IM header is gone from the user's own question, the question is not.
    assert _text_blocks(_prompt_messages(cleaned)[0]) == ["第一个问题"]
    # The working-memory echo collapses to the question it quoted, turn state
    # and markers survive.
    memory = _text_blocks(_prompt_messages(cleaned)[1])[0]
    assert "[USER]: 第一个问题\n</history>" in memory
    assert memory.startswith("\n### [WORKING MEMORY]")
    # Tool output is real content, not plumbing — byte-for-byte identical.
    assert _prompt_messages(cleaned)[1]["content"][0] == {
        "type": "tool_result", "tool_use_id": "call_1",
        "content": '{"stdout": "ok", "exit_code": 0}',
    }
    assert _response_bodies(cleaned) == _response_bodies(archive)


def test_strip_file_hints_is_idempotent() -> None:
    archive = _im_archive()

    once = strip_file_hints(archive)

    assert strip_file_hints(once) == once
    assert prepare_import_text(once) == once


def test_strip_file_hints_keeps_plain_and_midbody_markers() -> None:
    archive = (
        _question_turn("普通问题没有前缀")
        + _question_turn("请展示 [FILE:report.md] 里的内容", "09:01:01")
    )

    assert strip_file_hints(archive) == archive


def test_strip_file_hints_cleans_marker_blocks_behind_system_tips() -> None:
    """Real archives prefix the anchor prompt with a [SYSTEM TIPS] line."""
    prompt = _prompt([{"type": "text", "text": (
        "\n[SYSTEM TIPS] 正在读取记忆或SOP文件。\n\n"
        + _working_memory("第一个问题").lstrip("\n")
    )}])

    cleaned = strip_file_hints(prompt)

    assert _FILE_HINT not in cleaned
    block = _text_blocks(_prompt_messages(cleaned)[0])[0]
    assert block.startswith("\n[SYSTEM TIPS]")
    assert "[USER]: 第一个问题\n</history>" in block


# ── incomplete tail ───────────────────────────────────────────────
def test_trim_incomplete_tail_drops_a_dangling_prompt() -> None:
    complete = _question_turn(_hinted("第一个问题")) + _tool_turn()
    archive = complete + _prompt([{"type": "text", "text": _hinted("没等到回答")}])

    trimmed = trim_incomplete_tail(archive)

    assert trimmed == complete
    assert trim_incomplete_tail(complete) == complete


def test_trim_incomplete_tail_drops_an_orphan_response() -> None:
    complete = _question_turn(_hinted("第一个问题"))
    archive = complete + _response("没有对应提问的回答")

    assert trim_incomplete_tail(archive) == complete


def test_trim_incomplete_tail_keeps_text_without_native_headers() -> None:
    assert trim_incomplete_tail("<summary>摘要</summary>") == "<summary>摘要</summary>"


def test_prepare_import_text_refuses_an_archive_without_a_complete_turn() -> None:
    with pytest.raises(ArchiveNotImportableError):
        prepare_import_text(_prompt([{"type": "text", "text": _hinted("孤零零")}]))

    # Non-native text is GA's summary-restore domain, not a refusal here.
    assert prepare_import_text("<summary>只有摘要</summary>") == "<summary>只有摘要</summary>"


def test_prepare_import_text_trims_then_strips() -> None:
    complete = _question_turn(_hinted("第一个问题"))
    archive = complete + _prompt([{"type": "text", "text": _hinted("没等到回答")}])

    assert prepare_import_text(archive) == strip_file_hints(complete)


# ── copy service ──────────────────────────────────────────────────
def test_copy_archive_for_import_writes_a_clean_copy(tmp_path: Path) -> None:
    source = tmp_path / "model_responses_111111.txt"
    source.write_text(_im_archive(), encoding="utf-8")
    before = _sha256(source)
    target = tmp_path / "model_responses_999999.txt"

    path, imported_lines = copy_archive_for_import(
        source, new_log_path=lambda: str(target)
    )

    assert path == target
    copy = target.read_text(encoding="utf-8")
    assert _FILE_HINT not in copy
    assert _response_bodies(copy) == _response_bodies(source)
    assert _text_blocks(_prompt_messages(copy)[0]) == ["第一个问题"]
    assert imported_lines == 2  # one user bubble + the folded assistant bubble
    # The staging file is renamed into place, never left behind.
    assert sorted(p.name for p in tmp_path.glob("*.importing")) == []
    # Source untouched, byte for byte.
    assert _sha256(source) == before


def test_copy_archive_for_import_preserves_crlf_line_endings(tmp_path: Path) -> None:
    """GA writes archives in text mode, so Windows sources arrive with CRLF."""
    from frontends.continue_cmd import _pairs

    source = tmp_path / "model_responses_111111.txt"
    source.write_bytes(_im_archive().replace("\n", "\r\n").encode("utf-8"))
    target = tmp_path / "model_responses_999999.txt"

    path, imported_lines = copy_archive_for_import(
        source, new_log_path=lambda: str(target)
    )

    data = path.read_bytes()
    assert b"\r\r\n" not in data
    assert _FILE_HINT not in data.decode("utf-8")
    assert imported_lines == 2
    # The re-serialised prompt body still ends its own line, so the Response
    # header below it is a header and not part of the JSON body.
    assert len(_pairs(data.decode("utf-8"))) == 2


def test_copy_archive_for_import_mints_again_on_a_taken_logid(tmp_path: Path) -> None:
    source = tmp_path / "model_responses_111111.txt"
    source.write_text(_question_turn(_hinted("第一个问题")), encoding="utf-8")
    taken = tmp_path / "model_responses_999999.txt"
    taken.write_text("someone else's session", encoding="utf-8")
    free = tmp_path / "model_responses_999998.txt"
    candidates = iter([taken, free])

    path, _lines = copy_archive_for_import(
        source, new_log_path=lambda: str(next(candidates))
    )

    assert path == free
    assert taken.read_text(encoding="utf-8") == "someone else's session"


# ── POST /api/conversations/{cid}/import ──────────────────────────
def _setup_import(tmp_path: Path, monkeypatch, archive: str, *, coordinator=None):
    store = SessionMetadataStore(tmp_path / "sessions")
    source = tmp_path / "model_responses_111111.txt"
    source.write_text(archive, encoding="utf-8")
    target = tmp_path / "model_responses_999999.txt"
    coordinator = coordinator or _Coordinator()

    monkeypatch.setattr(conversations, "_metadata", store)
    monkeypatch.setattr(archive_import, "ga_new_log_path", lambda: str(target))
    monkeypatch.setattr(conversations, "_session_coordinator", lambda: coordinator)
    monkeypatch.setattr(
        conversations,
        "archive_session_by_id",
        lambda cid: (str(source), 2.0, "preview", 2),
    )
    return store, source, target, coordinator


def test_import_creates_a_session_bound_to_a_clean_copy(tmp_path, monkeypatch) -> None:
    store, source, target, coordinator = _setup_import(tmp_path, monkeypatch, _im_archive())
    before = _sha256(source)

    with TestClient(_app()) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["title"] == "第一个问题"
    assert body["imported_lines"] == 2

    row = store.get(body["session_id"])
    assert row["archive_path"] == str(target.resolve())
    assert row["kind"] == "user"
    assert store.find_by_archive(target)["id"] == body["session_id"]
    # Cold start went through the normal factory path (no override).
    assert coordinator.ensured == [body["session_id"]]

    copy = target.read_text(encoding="utf-8")
    assert _FILE_HINT not in copy
    assert _response_bodies(copy) == _response_bodies(source)
    assert _sha256(source) == before


def test_import_prefers_the_archive_title_over_the_preview(tmp_path, monkeypatch) -> None:
    store, source, target, _coordinator = _setup_import(
        tmp_path, monkeypatch, _im_archive()
    )
    monkeypatch.setattr(conversations._metadata, "title_for_archive", lambda path: "手工命名")

    with TestClient(_app()) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert store.get(response.json()["session_id"])["title"] == "手工命名"


def test_import_refuses_an_archive_that_already_belongs_to_a_session(
    tmp_path, monkeypatch
) -> None:
    store, source, target, _coordinator = _setup_import(
        tmp_path, monkeypatch, _im_archive()
    )
    owner = store.create(title="已有会话")
    store.bind_archive(owner["id"], source)
    monkeypatch.setattr(
        conversations,
        "copy_archive_for_import",
        lambda *a, **k: pytest.fail("a bound archive must not be copied"),
    )

    with TestClient(_app()) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["code"] == "archive_already_bound"
    assert detail["session_id"] == owner["id"]
    assert not target.exists()
    assert [row["id"] for row in store.list()] == [owner["id"]]


def test_import_reports_unknown_conversations(tmp_path, monkeypatch) -> None:
    _setup_import(tmp_path, monkeypatch, _im_archive())
    monkeypatch.setattr(conversations, "archive_session_by_id", lambda cid: None)

    with TestClient(_app()) as client:
        response = client.post("/api/conversations/model_responses_missing.txt/import")

    assert response.status_code == 404
    assert response.json()["detail"] == "conversation not found"


def test_import_rolls_back_the_session_and_copy_when_the_copy_fails(
    tmp_path, monkeypatch
) -> None:
    store, source, target, _coordinator = _setup_import(
        tmp_path, monkeypatch, _im_archive()
    )
    before = _sha256(source)
    monkeypatch.setattr(
        conversations,
        "copy_archive_for_import",
        lambda *a, **k: (_ for _ in ()).throw(OSError("disk on fire")),
    )

    with TestClient(_app(), raise_server_exceptions=False) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert response.status_code == 500
    assert store.list() == []
    assert not target.exists()
    assert _sha256(source) == before


def test_import_rolls_back_when_the_cold_start_fails(tmp_path, monkeypatch) -> None:
    coordinator = _Coordinator(error=RuntimeRestoreError("archive unreadable"))
    store, source, target, _coordinator = _setup_import(
        tmp_path, monkeypatch, _im_archive(), coordinator=coordinator
    )
    before = _sha256(source)

    with TestClient(_app(), raise_server_exceptions=False) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "restore_failed"
    assert store.list() == []
    assert not target.exists()
    assert sorted(p.name for p in tmp_path.glob("*.importing")) == []
    assert _sha256(source) == before


def test_import_refuses_an_archive_with_no_complete_turn(tmp_path, monkeypatch) -> None:
    store, source, target, _coordinator = _setup_import(
        tmp_path,
        monkeypatch,
        _prompt([{"type": "text", "text": _hinted("没等到回答")}]),
    )
    before = _sha256(source)

    with TestClient(_app()) as client:
        response = client.post(f"/api/conversations/{source.name}/import")

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "archive_not_importable"
    assert store.list() == []
    assert not target.exists()
    assert _sha256(source) == before


# ── bound_session_id on listing / detail ──────────────────────────
def test_listing_and_detail_report_the_bound_session(tmp_path, monkeypatch) -> None:
    store = SessionMetadataStore(tmp_path / "sessions")
    bound = tmp_path / "model_responses_bound.txt"
    free = tmp_path / "model_responses_free.txt"
    archive = _question_turn(_hinted("第一个问题"))
    bound.write_text(archive, encoding="utf-8")
    free.write_text(archive, encoding="utf-8")
    owner = store.create(title="已绑定")
    store.bind_archive(owner["id"], bound)

    monkeypatch.setattr(conversations, "_metadata", store)
    monkeypatch.setattr(conversations, "list_archive_sessions", lambda: [
        (str(bound), 2.0, "已绑定的预览", 2),
        (str(free), 1.0, "空闲的预览", 2),
    ])
    monkeypatch.setattr(
        conversations, "archive_session_by_id",
        lambda cid: (str(bound), 2.0, "已绑定的预览", 2),
    )
    monkeypatch.setattr(conversations, "_ga_extract", lambda path: [])

    with TestClient(_app()) as client:
        listing = client.get("/api/conversations").json()
        detail = client.get(f"/api/conversations/{bound.name}").json()

    assert [item["bound_session_id"] for item in listing["items"]] == [owner["id"], None]
    assert [item["id"] for item in listing["items"]] == [bound.name, free.name]
    assert detail["bound_session_id"] == owner["id"]
