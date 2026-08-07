"""Regression tests for durable one-shot scheduled chat submissions."""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from server.services.scheduled_chat_service import ScheduledChatService


class MutableClock:
    def __init__(self, value: float = 1_000.0) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class ScheduledChatServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.path = Path(self.temp_dir.name) / "scheduled_chats.json"
        self.clock = MutableClock()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def service(self, submit=lambda task: None) -> ScheduledChatService:
        return ScheduledChatService(
            submit,
            path=self.path,
            clock=self.clock,
            retry_seconds=60,
            poll_seconds=0.01,
        )

    def test_create_persists_and_lists_only_own_pending_tasks_in_time_order(self):
        service = self.service()
        later = service.create(session_id="alpha", text="later", images=["a.png"], scheduled_for=1_200)
        earlier = service.create(session_id="alpha", text="earlier", images=[], scheduled_for=1_100)
        service.create(session_id="beta", text="other", images=[], scheduled_for=1_050)

        self.assertEqual([row["id"] for row in service.list("alpha")], [earlier["id"], later["id"]])
        reloaded = self.service()
        self.assertEqual([row["text"] for row in reloaded.list("alpha")], ["earlier", "later"])
        self.assertEqual(reloaded.list("alpha")[1]["images"], ["a.png"])

    def test_create_rejects_present_or_past_time(self):
        service = self.service()
        with self.assertRaises(ValueError):
            service.create(session_id="alpha", text="now", images=[], scheduled_for=self.clock.value)

    def test_cancel_is_session_scoped_and_hides_task_from_pending_list(self):
        service = self.service()
        task = service.create(session_id="alpha", text="cancel me", images=[], scheduled_for=1_100)

        with self.assertRaises(KeyError):
            service.cancel("beta", task["id"])
        cancelled = service.cancel("alpha", task["id"])

        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["cancelled_at"], self.clock.value)
        self.assertEqual(service.list("alpha"), [])
        self.assertEqual(service.list("alpha", include_finished=True)[0]["status"], "cancelled")
        with self.assertRaises(ValueError):
            service.cancel("alpha", task["id"])

    def test_due_task_dispatches_once_and_persists_sent_state(self):
        submitted = []
        service = self.service(submitted.append)
        task = service.create(session_id="alpha", text="send", images=["x"], scheduled_for=1_010)
        self.clock.value = 1_010

        self.assertEqual(service.run_due_once(), 1)
        self.assertEqual(service.run_due_once(), 0)
        self.assertEqual([row.id for row in submitted], [task["id"]])
        sent = self.service().list("alpha", include_finished=True)[0]
        self.assertEqual(sent["status"], "sent")
        self.assertEqual(sent["sent_at"], self.clock.value)

    def test_failed_dispatch_returns_to_pending_and_retries_after_delay(self):
        attempts = []

        def submit(task):
            attempts.append(task.id)
            if len(attempts) == 1:
                raise RuntimeError("temporarily unavailable")

        service = self.service(submit)
        task = service.create(session_id="alpha", text="retry", images=[], scheduled_for=1_010)
        self.clock.value = 1_010

        self.assertEqual(service.run_due_once(), 0)
        failed = service.list("alpha")[0]
        self.assertEqual(failed["status"], "pending")
        self.assertEqual(failed["retry_at"], 1_070)
        self.assertIn("temporarily unavailable", failed["last_error"])

        self.clock.value = 1_069
        self.assertEqual(service.run_due_once(), 0)
        self.clock.value = 1_070
        self.assertEqual(service.run_due_once(), 1)
        self.assertEqual(attempts, [task["id"], task["id"]])

    def test_list_route_uses_service_list_contract(self):
        from server.routes import sessions

        service = mock.Mock()
        service.list.return_value = [{"id": "task-1"}]
        with (
            mock.patch.object(sessions, "_session"),
            mock.patch.object(sessions, "_get_scheduled_chats", return_value=service),
        ):
            response = asyncio.run(sessions.list_scheduled_chats("alpha"))

        service.list.assert_called_once_with("alpha")
        self.assertEqual(response, {"total": 1, "items": [{"id": "task-1"}]})

    def test_reload_recovers_interrupted_dispatching_task(self):
        self.path.write_text(json.dumps([{
            "id": "interrupted",
            "session_id": "alpha",
            "text": "recover",
            "images": [],
            "scheduled_for": 900,
            "created_at": 800,
            "status": "dispatching",
            "sent_at": None,
            "cancelled_at": None,
            "last_error": None,
            "retry_at": None,
        }]), "utf-8")

        service = self.service()
        recovered = service.list("alpha")[0]

        self.assertEqual(recovered["status"], "pending")
        self.assertEqual(recovered["retry_at"], 1_060)
        self.assertEqual(recovered["last_error"], "服务重启后重新调度")


if __name__ == "__main__":
    unittest.main()
