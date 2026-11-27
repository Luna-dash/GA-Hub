"""Token usage persistence and natural-week aggregation tests."""
from __future__ import annotations

from contextlib import closing
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from server import _paths
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

    @unittest.skipIf(_paths.GA_ROOT is None, "requires configured GA_ROOT")
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

        with tempfile.TemporaryDirectory() as tmpdir, \
             mock.patch.object(tokens._paths, "ADMIN_DATA", Path(tmpdir)), \
             mock.patch.object(tokens.usage_bridge, "read_usage_ledger", return_value=ledger), \
             mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
             mock.patch.object(tokens.time, "time", return_value=timestamp + 3):
            result = tokens.token_stats()

        by_id = {row["thread"]: row for row in result["threads"]}
        self.assertEqual(by_id["chat-a"]["total"], 21)
        self.assertEqual(by_id["chat-b"]["total"], 32)
        self.assertEqual(result["all_time"]["total"], 53)
        self.assertEqual(result["days"][0]["total"], 53)

    @unittest.skipIf(_paths.GA_ROOT is None, "requires configured GA_ROOT")
    def test_native_ledger_exposes_conductor_workers_without_session_metadata(self) -> None:
        timestamp = int(datetime(2026, 7, 6, 9, 0).timestamp())
        ledger = [
            {"k": "GA-conductor", "t": timestamp, "i": 10, "o": 2},
            {"k": "GA-conductor-subagent-a1", "t": timestamp + 1, "i": 20, "o": 5},
            {"k": "GA-orphan-chat", "t": timestamp + 2, "i": 100, "o": 10},
        ]
        metadata = mock.Mock()
        metadata.list.return_value = []

        with tempfile.TemporaryDirectory() as tmpdir, \
             mock.patch.object(tokens._paths, "ADMIN_DATA", Path(tmpdir)), \
             mock.patch.object(tokens.usage_bridge, "read_usage_ledger", return_value=ledger), \
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


    def test_ledger_row_shape_maps_to_call_count(self) -> None:
        # 流式调用写严格两行：输入侧行（_record_usage）+ 仅输出行（[Output]
        # 打印）；非流式调用输入输出同写一行。带输入侧 token 的行即一次调用。
        streaming_input_row = {"t": 1, "k": "GA-s", "i": 100, "o": 0, "cc": 0, "cr": 50}
        streaming_output_row = {"t": 2, "k": "GA-s", "i": 0, "o": 640, "cc": 0, "cr": 0}
        nonstream_row = {"t": 3, "k": "GA-s", "i": 80, "o": 300, "cc": 10, "cr": 0}
        fully_cached_row = {"t": 4, "k": "GA-s", "i": 0, "o": 0, "cc": 0, "cr": 900}
        empty_row = {"t": 5, "k": "GA-s", "i": 0, "o": 0, "cc": 0, "cr": 0}
        legacy_aggregate_row = {"t": 6, "k": "GA-s", "i": 10_000, "o": 900, "n": "旧聚合", "_migrated": True}

        self.assertEqual(tokens._ledger_totals(streaming_input_row)["requests"], 1)
        self.assertEqual(tokens._ledger_totals(streaming_output_row)["requests"], 0)
        self.assertEqual(tokens._ledger_totals(nonstream_row)["requests"], 1)
        self.assertEqual(tokens._ledger_totals(fully_cached_row)["requests"], 1)
        self.assertEqual(tokens._ledger_totals(empty_row)["requests"], 0)
        # 压缩/迁移行聚合了多次调用，1 是可证明的下界
        self.assertEqual(tokens._ledger_totals(legacy_aggregate_row)["requests"], 1)

    @unittest.skipIf(_paths.GA_ROOT is None, "requires configured GA_ROOT")
    def test_token_stats_sums_requests_across_streaming_row_pairs(self) -> None:
        timestamp = int(datetime(2026, 7, 6, 9, 0).timestamp())
        ledger = [
            # 一次流式调用 = 输入侧行 + 仅输出行
            {"k": "GA-chat-a", "t": timestamp, "i": 10, "o": 0, "cc": 3, "cr": 4},
            {"k": "GA-chat-a", "t": timestamp, "o": 2},
            # 另一次流式调用
            {"k": "GA-chat-a", "t": timestamp + 1, "i": 1, "o": 0, "cc": 0, "cr": 0},
            {"k": "GA-chat-a", "t": timestamp + 1, "o": 1},
            # 非流式调用 = 单行
            {"k": "GA-chat-b", "t": timestamp + 2, "i": 20, "o": 5, "cc": 0, "cr": 7},
        ]
        metadata = mock.Mock()
        metadata.list.return_value = [
            {"id": "chat-a", "title": "并行会话 A"},
            {"id": "chat-b", "title": "并行会话 B"},
        ]

        with tempfile.TemporaryDirectory() as tmpdir, \
             mock.patch.object(tokens._paths, "ADMIN_DATA", Path(tmpdir)), \
             mock.patch.object(tokens.usage_bridge, "read_usage_ledger", return_value=ledger), \
             mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
             mock.patch.object(tokens.time, "time", return_value=timestamp + 3):
            result = tokens.token_stats()

        self.assertEqual(result["all_time"]["requests"], 3)
        self.assertEqual(result["days"][0]["requests"], 3)
        by_id = {row["thread"]: row for row in result["threads"]}
        self.assertEqual(by_id["chat-a"]["requests"], 2)
        self.assertEqual(by_id["chat-b"]["requests"], 1)


    def test_token_stats_merges_ga_and_agy_ledgers(self) -> None:
        timestamp = int(datetime(2026, 7, 6, 9, 0).timestamp())
        agy_dt_1 = datetime(2026, 7, 6, 10, 0, tzinfo=datetime.now().astimezone().tzinfo).astimezone(timezone.utc)
        agy_dt_2 = datetime(2026, 7, 7, 11, 0, tzinfo=datetime.now().astimezone().tzinfo).astimezone(timezone.utc)

        with tempfile.TemporaryDirectory() as tmpdir:
            admin_dir = Path(tmpdir)
            db_path = admin_dir / "anti_sessions.sqlite3"
            with closing(sqlite3.connect(db_path)) as conn:
                conn.executescript("""
                    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '');
                    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
                    CREATE TABLE usage_ledger (
                        run_id TEXT PRIMARY KEY,
                        profile_id TEXT NOT NULL DEFAULT 'default',
                        model TEXT NOT NULL,
                        model_group TEXT NOT NULL,
                        status TEXT NOT NULL,
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                        thinking_tokens INTEGER NOT NULL DEFAULT 0,
                        model_calls INTEGER NOT NULL DEFAULT 0,
                        created_at TEXT NOT NULL
                    );
                """)
                conn.execute("INSERT INTO sessions (id, title) VALUES (?, ?)", ("anti-1", "Agy 代码排查"))
                conn.execute("INSERT INTO runs (id, session_id) VALUES (?, ?)", ("run-1", "anti-1"))
                # input_tokens=1000 includes cache_read=400 & cache_write=100 -> fresh_in=500;
                # output_tokens=200 > thinking_tokens=80 -> output=200 (no double count).
                conn.execute(
                    "INSERT INTO usage_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("run-1", "default", "gemini-3", "gemini", "completed", 1000, 200, 400, 100, 80, 3, agy_dt_1.isoformat()),
                )
                # Deleted/orphaned Agy session run should still contribute to global totals & days,
                # without leaking an orphan thread row.
                conn.execute(
                    "INSERT INTO usage_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("run-deleted", "custom-p1", "claude-4", "claude", "completed", 50, 25, 0, 0, 40, 0, agy_dt_2.isoformat()),
                )
                conn.commit()

            metadata = mock.Mock()
            metadata.list.return_value = [{"id": "ga-1", "title": "GA 主会话"}]
            ga_ledger = [
                {"k": "GA-ga-1", "t": timestamp, "i": 100, "o": 50, "cc": 20, "cr": 30},
            ]
            read_ctx = (
                mock.patch.object(tokens.usage_bridge, "read_usage_ledger", return_value=ga_ledger)
                if tokens.usage_bridge is not None
                else mock.patch.object(tokens, "usage_bridge", None)
            )
            with mock.patch.object(tokens._paths, "ADMIN_DATA", admin_dir), \
                 mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
                 mock.patch.object(tokens.time, "time", return_value=timestamp + 90_000), \
                 read_ctx:
                result = tokens.token_stats()

        self.assertTrue(result["available"])
        agy_expected_total = (500 + 200 + 100 + 400) + (50 + 40)
        ga_expected_total = 200 if tokens.usage_bridge is not None else 0
        self.assertEqual(result["all_time"]["total"], ga_expected_total + agy_expected_total)
        self.assertEqual(result["by_engine"]["anti"]["total"], agy_expected_total)
        self.assertEqual(result["by_engine"]["anti"]["input"], 550)
        self.assertEqual(result["by_engine"]["anti"]["output"], 240)
        self.assertEqual(result["by_engine"]["anti"]["cache_create"], 100)
        self.assertEqual(result["by_engine"]["anti"]["cache_read"], 400)
        self.assertEqual(result["by_engine"]["anti"]["requests"], 4)

        threads = {row["thread"]: row for row in result["threads"]}
        self.assertIn("anti:anti-1", threads)
        self.assertEqual(threads["anti:anti-1"]["title"], "Agy 代码排查")
        self.assertEqual(threads["anti:anti-1"]["engine"], "anti")
        self.assertEqual(threads["anti:anti-1"]["total"], 1200)
        self.assertEqual(len([t for t in threads if t.startswith("anti:")]), 1)

    def test_token_stats_stays_available_with_agy_only_when_ga_bridge_missing(self) -> None:
        now = int(datetime(2026, 7, 8, 12, 0).timestamp())
        agy_dt = datetime(2026, 7, 8, 9, 0, tzinfo=datetime.now().astimezone().tzinfo).astimezone(timezone.utc)
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "anti_sessions.sqlite3"
            with closing(sqlite3.connect(db_path)) as conn:
                conn.executescript("""
                    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '');
                    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL);
                    CREATE TABLE usage_ledger (
                        run_id TEXT PRIMARY KEY,
                        created_at TEXT NOT NULL,
                        input_tokens INTEGER NOT NULL DEFAULT 0,
                        output_tokens INTEGER NOT NULL DEFAULT 0,
                        cache_read_tokens INTEGER NOT NULL DEFAULT 0
                    );
                """)
                conn.execute("INSERT INTO sessions VALUES ('s1', '')")
                conn.execute("INSERT INTO runs VALUES ('r1', 's1')")
                conn.execute("INSERT INTO usage_ledger VALUES ('r1', ?, 120, 30, 20)", (agy_dt.isoformat(),))
                conn.commit()

            metadata = mock.Mock()
            metadata.list.return_value = []
            with mock.patch.object(tokens._paths, "ADMIN_DATA", Path(tmpdir)), \
                 mock.patch.object(tokens, "_SESSION_METADATA", metadata), \
                 mock.patch.object(tokens, "usage_bridge", None), \
                 mock.patch.object(tokens.time, "time", return_value=now):
                result = tokens.token_stats()

        self.assertTrue(result["available"])
        self.assertEqual(result["all_time"]["total"], 150)
        self.assertEqual(result["by_engine"]["ga"]["total"], 0)
        self.assertEqual(result["by_engine"]["anti"]["total"], 150)
        self.assertEqual(result["threads"][0]["title"], "未命名会话")
        self.assertEqual(result["threads"][0]["engine"], "anti")


if __name__ == "__main__":
    unittest.main()
