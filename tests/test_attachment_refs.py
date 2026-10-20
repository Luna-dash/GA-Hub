"""Lightweight Hub-only attachment validation and scheduled retry contracts."""
from unittest.mock import patch

import pytest

from server.services.attachment_refs import validate_attachments
from server.services.scheduled_chat_service import ScheduledChatService


def test_reference_preflight_never_reads_contents(tmp_path):
    path = tmp_path / "large.bin"
    path.write_bytes(b"payload")
    with patch("pathlib.Path.read_bytes", side_effect=AssertionError("must not read")), patch("pathlib.Path.read_text", side_effect=AssertionError("must not read")):
        validate_attachments([{"path": str(path), "name": path.name}])


@pytest.mark.parametrize("kind", ["missing", "relative", "directory"])
def test_bad_reference_is_actionable(tmp_path, kind):
    path = {"missing": str(tmp_path / "missing"), "relative": "relative.txt", "directory": str(tmp_path)}[kind]
    with pytest.raises(ValueError, match="重新定位或移除"):
        validate_attachments([{"path": path, "name": "visible-name"}])


def test_unreadable_reference_is_rejected(tmp_path):
    path = tmp_path / "private.txt"
    path.touch()
    with patch("pathlib.Path.open", side_effect=PermissionError("denied")):
        with pytest.raises(ValueError, match="private.txt"):
            validate_attachments([{"path": str(path)}])


def test_schedule_revalidates_and_recovers_after_file_restored(tmp_path):
    now = [1000.0]
    submitted = []
    store = tmp_path / "schedule.json"
    file = tmp_path / "document.txt"
    file.write_text("content")
    ref = {"path": str(file), "name": file.name, "source": "local_ref"}
    service = ScheduledChatService(submitted.append, path=store, clock=lambda: now[0], retry_seconds=60)
    task = service.create(session_id="s", text="path", images=[], attachments=[ref], scheduled_for=1010)
    service = ScheduledChatService(submitted.append, path=store, clock=lambda: now[0], retry_seconds=60)
    assert service.list("s")[0]["attachments"] == [ref]
    file.unlink()
    now[0] = 1010
    assert service.run_due_once() == 0
    assert submitted == []
    pending = service.list("s")[0]
    assert pending["status"] == "pending"
    assert "document.txt" in pending["last_error"]
    file.write_text("restored")
    now[0] = 1071
    assert service.run_due_once() == 1
    assert submitted[0].id == task["id"]
