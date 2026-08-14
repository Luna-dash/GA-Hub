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
            mock.patch.object(tokens, "_STORE", tokens.TokenUsageStore(
                usage_path=self.usage, history_path=self.history
            )),
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
        self.assertEqual(persisted["version"], 3)
        self.assertEqual(persisted["days"]["2026-07-06"]["total"], 165)
        self.assertEqual(persisted["weeks"]["2026-07-06"]["total"], 165)
        self.assertEqual(persisted["all_time"]["total"], 165)

    def test_daily_totals_use_durable_deltas_across_day_boundary(self) -> None:
        monday = int(datetime(2026, 7, 6, 23, 59).timestamp())
        tokens._persist_snapshot(snap(100, monday))
        result = tokens._persist_snapshot(snap(140, monday + 120))

        self.assertEqual(
            [(row["date"], row["total"]) for row in result["days"]],
            [("2026-07-06", 100), ("2026-07-07", 40)],
        )

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

    def test_migrates_historical_snapshots_into_daily_totals_once(self) -> None:
        day_one = int(datetime(2026, 8, 8, 12, 0).timestamp())
        day_two = int(datetime(2026, 8, 9, 12, 0).timestamp())
        history = [
            {"timestamp": day_one, "requests": 2, "input": 100, "output": 10},
            {"timestamp": day_one + 60, "requests": 3, "input": 140, "output": 20},
            {"timestamp": day_two, "requests": 1, "input": 30, "output": 5},
        ]
        tokens._HISTORY_FILE.write_text(json.dumps(history), encoding="utf-8")

        recovered = tokens._history_daily_totals()
        data = {"days": {}}
        tokens._migrate_history_days(data)
        first = json.loads(json.dumps(data))
        tokens._migrate_history_days(data)

        self.assertEqual(recovered["2026-08-08"]["input"], 140)
        self.assertEqual(recovered["2026-08-09"]["input"], 30)
        self.assertEqual(data, first)
        self.assertTrue(data["history_days_migrated"])

    def test_assigns_tracker_delta_to_real_session(self) -> None:
        first = {**ZERO, "requests": 2, "input": 120, "output": 20, "total": 140}
        second = {**ZERO, "requests": 3, "input": 180, "output": 35, "total": 215}
        with mock.patch.object(tokens, "_stats", side_effect=[{"totals": first}, {"totals": second}]):
            tokens.record_session_usage("chat-a")
            tokens.record_session_usage("chat-b")

        stored = json.loads(self.usage.read_text("utf-8"))
        self.assertEqual(stored["sessions"]["chat-a"]["totals"]["input"], 120)
        self.assertEqual(stored["sessions"]["chat-b"]["totals"]["input"], 60)
        rows = {
            row["thread"]: row
            for row in tokens._weekly_response(stored, int(datetime.now().timestamp()))["threads"]
        }
        self.assertEqual(rows["chat-a"]["total"], 140)
        self.assertEqual(rows["chat-b"]["total"], 75)

    def test_sessions_survive_process_restart_with_fresh_tracker(self) -> None:
        old_totals = {**ZERO, "requests": 4, "input": 300, "output": 40, "total": 340}
        self.usage.write_text(json.dumps({
            "version": 3,
            "all_time": old_totals,
            "weeks": {},
            "days": {},
            "sessions": {"chat-old": {"totals": old_totals, "updated_at": 1}},
            "allocation_cursor": {"id": "old-process", "totals": old_totals, "updated_at": 1},
        }), "utf-8")
        fresh_totals = {**ZERO, "requests": 1, "input": 25, "output": 5, "total": 30}

        with mock.patch.object(tokens, "_SESSION_ID", "new-process"), mock.patch.object(
            tokens, "_stats", return_value={"totals": fresh_totals}
        ):
            tokens.record_session_usage("chat-new")

        stored = json.loads(self.usage.read_text("utf-8"))
        self.assertEqual(stored["sessions"]["chat-old"]["totals"], old_totals)
        self.assertEqual(stored["sessions"]["chat-new"]["totals"], fresh_totals)
        self.assertEqual(stored["allocation_cursor"]["id"], "new-process")

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
