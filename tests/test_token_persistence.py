"""Token usage persistence and natural-week aggregation tests."""
from __future__ import annotations

import json
import unittest
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from server.routes import tokens


ZERO = {
    "requests": 0,
    "input": 0,
    "output": 0,
    "cache_create": 0,
    "cache_read": 0,
    "total": 0,
}


def snap(total: int, timestamp: int) -> dict:
    values = {**ZERO, "requests": 1 if total else 0, "input": total, "total": total}
    return {"available": True, "threads": [], "totals": values, "timestamp": timestamp}


class TokenPersistenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.history = Path(self._tmp.name) / "token_history.json"
        self.usage = Path(self._tmp.name) / "token_usage.json"
        self.patches = [
            mock.patch.object(tokens, "_HISTORY_FILE", self.history),
            mock.patch.object(tokens, "_USAGE_FILE", self.usage),
            mock.patch.object(tokens, "_SESSION_ID", "session-a"),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self) -> None:
        for patch in reversed(self.patches):
            patch.stop()
        self._tmp.cleanup()

    def test_current_week_total_survives_process_restart_without_double_counting(self) -> None:
        monday = int(datetime(2026, 7, 6, 9, 0).timestamp())
        first = tokens._persist_snapshot(snap(100, monday))
        second = tokens._persist_snapshot(snap(140, monday + 60))

        self.assertEqual(first["current_week"]["total"], 100)
        self.assertEqual(second["current_week"]["total"], 140)
        self.assertEqual(second["all_time"]["total"], 140)

        with mock.patch.object(tokens, "_SESSION_ID", "session-b"):
            restarted = tokens._persist_snapshot(snap(25, monday + 120))
        self.assertEqual(restarted["current_week"]["total"], 165)
        self.assertEqual(restarted["all_time"]["total"], 165)

        persisted = json.loads(self.usage.read_text("utf-8"))
        self.assertEqual(persisted["version"], 2)
        self.assertEqual(persisted["weeks"]["2026-07-06"]["total"], 165)
        self.assertEqual(persisted["all_time"]["total"], 165)

    def test_legacy_week_data_is_migrated_to_independent_all_time_total(self) -> None:
        monday = int(datetime(2026, 7, 13, 9, 0).timestamp())
        legacy = {
            "version": 1,
            "weeks": {
                "2026-07-06": {**ZERO, "input": 80, "total": 80},
                "2026-07-13": {**ZERO, "input": 20, "total": 20},
            },
            "session": {},
        }
        self.usage.write_text(json.dumps(legacy), "utf-8")

        result = tokens._persist_snapshot(snap(5, monday))

        self.assertEqual(result["all_time"]["total"], 105)
        persisted = json.loads(self.usage.read_text("utf-8"))
        self.assertEqual(persisted["all_time"]["total"], 105)
        self.assertEqual(persisted["weeks"]["2026-07-13"]["total"], 25)

    def test_usage_is_grouped_into_monday_to_sunday_natural_weeks(self) -> None:
        sunday = int(datetime(2026, 7, 12, 23, 59).timestamp())
        monday = int(datetime(2026, 7, 13, 0, 1).timestamp())

        tokens._persist_snapshot(snap(80, sunday))
        result = tokens._persist_snapshot(snap(100, monday))

        self.assertEqual([row["week_start"] for row in result["weeks"]], ["2026-07-06", "2026-07-13"])
        self.assertEqual(result["weeks"][0]["total"], 80)
        self.assertEqual(result["weeks"][1]["total"], 20)
        self.assertEqual(result["current_week"]["week_end"], "2026-07-19")

    def test_background_persistence_is_singleton_and_flushes_on_stop(self) -> None:
        tokens.stop_persistence()
        with mock.patch.object(tokens, "_flush_usage") as flush:
            tokens.start_persistence()
            first_thread = tokens._PERSIST_THREAD
            tokens.start_persistence()
            self.assertIs(tokens._PERSIST_THREAD, first_thread)
            self.assertTrue(first_thread and first_thread.is_alive())
            tokens.stop_persistence()

        self.assertEqual(flush.call_count, 2)
        self.assertIsNone(tokens._PERSIST_THREAD)
        self.assertFalse(first_thread and first_thread.is_alive())


if __name__ == "__main__":
    unittest.main()
