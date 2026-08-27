"""Token usage persistence and natural-week aggregation tests."""
from __future__ import annotations

import unittest
from datetime import datetime
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


class TokenPersistenceTests(unittest.TestCase):


    def test_week_rows_are_derived_from_days_and_match_daily_totals(self) -> None:
        day_one = {**ZERO, "requests": 1, "input": 100, "output": 20, "total": 120}
        day_two = {**ZERO, "requests": 2, "input": 40, "output": 10, "total": 50}
        next_week = {**ZERO, "requests": 1, "input": 10, "output": 5, "total": 15}
        data = {
            "days": {
                "2026-07-06": day_one,
                "2026-07-07": day_two,
                "2026-07-13": next_week,
            },
            # A stale legacy cache must not disagree with the daily ledger.
            "weeks": {"2026-07-06": {**ZERO, "input": 999, "total": 999}},
            "all_time": {**ZERO, "input": 150, "output": 35, "total": 185},
            "sessions": {},
        }

        response = tokens._weekly_response(
            data, int(datetime(2026, 7, 13, 12, 0).timestamp())
        )

        self.assertEqual(
            [(row["week_start"], row["total"]) for row in response["weeks"]],
            [("2026-07-06", 170), ("2026-07-13", 15)],
        )
        for key in tokens._TOTAL_KEYS:
            self.assertEqual(
                sum(row[key] for row in response["weeks"]),
                sum(row[key] for row in response["days"]),
            )
        self.assertEqual(response["current_week"]["total"], 15)

    def test_session_rows_use_titles_filter_orphans_and_sort_by_total(self) -> None:
        def entry(total: int, updated_at: int) -> dict:
            return {
                "totals": {**ZERO, "input": total, "total": total},
                "updated_at": updated_at,
            }

        data = {
            "sessions": {
                "session-light": entry(100, 999),
                "session-heavy": entry(500, 1),
                "session-medium": entry(300, 500),
                "session-orphan": entry(10_000, 1000),
            }
        }
        metadata = mock.Mock()
        metadata.list.return_value = [
            {"id": "session-light", "title": "轻量讨论"},
            {"id": "session-heavy", "title": "架构优化方案"},
            {"id": "session-medium", "title": "历史会话性能"},
        ]

        with mock.patch.object(tokens, "_SESSION_METADATA", metadata):
            rows = tokens._session_rows(data)

        self.assertEqual(
            [(row["thread"], row["title"], row["total"]) for row in rows],
            [
                ("session-heavy", "架构优化方案", 500),
                ("session-medium", "历史会话性能", 300),
                ("session-light", "轻量讨论", 100),
            ],
        )

    def test_native_ledger_keeps_parallel_chat_sessions_separate(self) -> None:
        timestamp = int(datetime(2026, 7, 6, 9, 0).timestamp())
        ledger = [
            {"k": "GA-chat-a", "t": timestamp, "i": 10, "o": 2, "cc": 3, "cr": 4},
            {"k": "GA-chat-b", "t": timestamp + 1, "i": 20, "o": 5, "cc": 0, "cr": 7},
            {"k": "GA-chat-a", "t": timestamp + 2, "i": 1, "o": 1, "cc": 0, "cr": 0},
        ]
        metadata = mock.Mock()
        metadata.list.return_value = [
            {"id": "chat-a", "title": "并行会话 A"},
            {"id": "chat-b", "title": "并行会话 B"},
        ]

        with mock.patch.object(tokens.cost_tracker, "read_ledger", return_value=ledger), \
             mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
             mock.patch.object(tokens.time, "time", return_value=timestamp + 3):
            result = tokens.token_stats()

        by_id = {row["thread"]: row for row in result["threads"]}
        self.assertEqual(by_id["chat-a"]["total"], 21)
        self.assertEqual(by_id["chat-b"]["total"], 32)
        self.assertEqual(result["all_time"]["total"], 53)
        self.assertEqual(result["days"][0]["total"], 53)

    def test_native_ledger_exposes_conductor_workers_without_session_metadata(self) -> None:
        timestamp = int(datetime(2026, 7, 6, 9, 0).timestamp())
        ledger = [
            {"k": "GA-conductor", "t": timestamp, "i": 10, "o": 2},
            {"k": "GA-conductor-subagent-a1", "t": timestamp + 1, "i": 20, "o": 5},
            {"k": "GA-orphan-chat", "t": timestamp + 2, "i": 100, "o": 10},
        ]
        metadata = mock.Mock()
        metadata.list.return_value = []

        with mock.patch.object(tokens.cost_tracker, "read_ledger", return_value=ledger), \
             mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
             mock.patch.object(tokens.time, "time", return_value=timestamp + 3):
            result = tokens.token_stats()

        rows = {row["thread"]: row for row in result["threads"]}
        self.assertEqual(rows["conductor"]["title"], "Conductor")
        self.assertEqual(rows["conductor"]["total"], 12)
        self.assertEqual(rows["conductor-subagent-a1"]["title"], "Conductor Subagent a1")
        self.assertEqual(rows["conductor-subagent-a1"]["total"], 25)
        self.assertNotIn("orphan-chat", rows)
        self.assertEqual(result["all_time"]["total"], 147)


if __name__ == "__main__":
    unittest.main()
