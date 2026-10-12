"""History list metrics: human dialogues are not native model turns."""
from pathlib import Path
from unittest import mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routes import conversations
from server.services import archive_messages


def prompt(text: str) -> str:
    import json
    return '=== Prompt ===\n' + json.dumps({'role': 'user', 'content': [{'type': 'text', 'text': text}]}) + '\n'


def response() -> str:
    return "=== Response ===\n[{'type': 'text', 'text': 'answer'}]\n"


def test_counts_include_tools_and_retries_only_in_model_turns(tmp_path: Path):
    archive = tmp_path / 'history.txt'
    archive.write_text(
        prompt('question one') + response()
        + '=== Prompt ===\n{"type":"tool_result","content":"question fake"}\n' + response()
        + prompt('[ERROR] Incomplete response. Regenerate and tooluse.') + response()
        + prompt('question two') + response(), encoding='utf-8',
    )
    assert archive_messages.read_archive_counts(archive) == (2, 4)
    # Unchanged archives reuse the index; don't decode/project every list refresh.
    with mock.patch.object(archive_messages, '_extract_ui_messages_from_text', side_effect=AssertionError('cache miss')):
        assert archive_messages.read_archive_counts(archive) == (2, 4)
    # Pending input is a human dialogue but not a completed model turn.
    with archive.open('a', encoding='utf-8') as out:
        out.write(prompt('pending question'))
    assert archive_messages.read_archive_counts(archive) == (3, 4)
    with archive.open('a', encoding='utf-8') as out:
        out.write(response())
    assert archive_messages.read_archive_counts(archive) == (3, 5)


def test_empty_and_missing_archive_counts(tmp_path: Path):
    archive = tmp_path / 'empty.txt'
    archive.touch()
    assert archive_messages.read_archive_counts(archive) == (0, 0)
    with pytest.raises(archive_messages.HistoryUnavailableError):
        archive_messages.read_archive_counts(tmp_path / 'missing.txt')


def test_list_counts_only_requested_page_and_uses_real_archive(tmp_path: Path, monkeypatch):
    paths = [tmp_path / f'{i}.txt' for i in range(3)]
    for path in paths:
        path.write_text(prompt('hello') + response() + prompt('next') + response(), encoding='utf-8')
    monkeypatch.setattr(conversations, 'list_archive_sessions', lambda: [
        (str(path), 0, '', 99) for path in paths
    ])
    monkeypatch.setattr(conversations, '_bound_session_id', lambda _: None)
    monkeypatch.setattr(conversations._metadata, 'title_for_archive', lambda _: 'Title')
    monkeypatch.setattr(conversations, '_conversation_source', lambda _: 'local')
    app = FastAPI()
    app.include_router(conversations.router)
    with mock.patch.object(conversations, 'read_archive_counts', wraps=archive_messages.read_archive_counts) as counts:
        result = TestClient(app).get('/api/conversations?offset=1&limit=1')
    assert result.status_code == 200
    counts.assert_called_once_with(str(paths[1]))
    row = result.json()['items'][0]
    assert (row['dialogue_count'], row['turn_count']) == (2, 2)
    assert row['message_count'] == 99  # compatibility only; never used as human count


def test_list_missing_archive_counts_are_unknown(monkeypatch):
    monkeypatch.setattr(conversations, 'list_archive_sessions', lambda: [('missing.txt', 0, '', 1)])
    monkeypatch.setattr(conversations, '_bound_session_id', lambda _: None)
    monkeypatch.setattr(conversations._metadata, 'title_for_archive', lambda _: 'Title')
    monkeypatch.setattr(conversations, '_conversation_source', lambda _: 'local')
    app = FastAPI()
    app.include_router(conversations.router)
    result = TestClient(app).get('/api/conversations')
    assert result.status_code == 200
    row = result.json()['items'][0]
    assert row['dialogue_count'] is None and row['turn_count'] is None
