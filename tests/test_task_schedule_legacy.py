"""Schedules written before SMTP removal remain usable."""
from __future__ import annotations

import json
from types import SimpleNamespace

from server.services.task_scheduler import TaskScheduler


def test_legacy_email_fields_do_not_hide_or_break_schedule(tmp_path, monkeypatch):
    schedules_file = tmp_path / "tasks_schedules.json"
    legacy = {
        "id": "task-legacy",
        "name": "Archive reports",
        "type": "cron",
        "cron": "0 8 * * *",
        "prompt": "Archive yesterday’s reports",
        "notify_email": True,
        "email_to": "user@example.com",
        "email_subject": "Archive result",
    }
    schedules_file.write_text(json.dumps({"schedules": [legacy]}), encoding="utf-8")
    monkeypatch.setattr(TaskScheduler, "_sched_file", lambda self: str(schedules_file))

    scheduler = TaskScheduler(SimpleNamespace(), scheduler_runtime=SimpleNamespace())

    [schedule] = scheduler.list()
    assert schedule["id"] == legacy["id"]
    assert schedule["name"] == legacy["name"]
    assert schedule["cron"] == legacy["cron"]
    assert schedule["prompt"] == legacy["prompt"]
    assert schedule["enabled"] is True
    assert {"notify_email", "email_to", "email_subject"}.isdisjoint(schedule)
    assert json.loads(schedules_file.read_text(encoding="utf-8"))["schedules"] == [legacy]
