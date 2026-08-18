"""Tests for ``server.services.event_bus``.

Covers:
  * ``_json_safe`` recursion across the value taxonomy that publishers
    actually pass in (Path / dataclass / pydantic-ish / datetime).
  * Prefix filtering on subscribers.
  * Bounded-queue drop policy when a slow subscriber falls behind.
  * History replay on subscribe.
"""
from __future__ import annotations

import asyncio
import dataclasses
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.services.event_bus import EventBus, _json_safe  # noqa: E402


class JsonSafeTests(unittest.TestCase):
    def test_primitives_pass_through(self):
        for v in [None, True, 1, 1.5, "x"]:
            self.assertEqual(_json_safe(v), v)

    def test_path_becomes_string(self):
        p = Path("/tmp/x")
        self.assertEqual(_json_safe(p), str(p))

    def test_bytes_decoded_replace(self):
        self.assertEqual(_json_safe(b"hello"), "hello")
        # Invalid UTF-8 still returns a string (replacement chars), not a crash.
        self.assertIsInstance(_json_safe(b"\xff\xfe"), str)

    def test_nested_mapping_and_sequence(self):
        p = Path("/x")
        out = _json_safe({"a": [1, p, {"b": (2, 3)}], "s": {1, 2}})
        self.assertEqual(out["a"][0], 1)
        # Path → str(p) — exact form is platform-dependent ('/x' vs '\\x'),
        # so we just confirm the conversion happened.
        self.assertEqual(out["a"][1], str(p))
        self.assertEqual(out["a"][2]["b"], [2, 3])
        # set order is unspecified, just check membership
        self.assertEqual(sorted(out["s"]), [1, 2])

    def test_dataclass_serialized_as_dict(self):
        @dataclasses.dataclass
        class P:
            x: int
            y: str
        self.assertEqual(_json_safe(P(1, "a")), {"x": 1, "y": "a"})

    def test_object_with_model_dump_uses_it(self):
        class M:
            def model_dump(self):
                return {"k": "v"}
        self.assertEqual(_json_safe(M()), {"k": "v"})

    def test_object_with_isoformat(self):
        class T:
            def isoformat(self):
                return "2026-01-01T00:00:00"
        self.assertEqual(_json_safe(T()), "2026-01-01T00:00:00")

    def test_unknown_object_falls_back_to_repr(self):
        out = _json_safe(object())
        self.assertIsInstance(out, str)


class EventBusBehaviorTests(unittest.TestCase):
    """End-to-end: drive a real EventBus inside a fresh asyncio loop."""

    def _run(self, coro):
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    def test_detach_ignores_stale_owner_and_prevents_closed_loop_publish(self):
        bus = EventBus()
        first = asyncio.new_event_loop()
        second = asyncio.new_event_loop()
        try:
            bus.attach_loop(first)
            bus.attach_loop(second)

            self.assertFalse(bus.detach_loop(first))
            self.assertIs(bus._loop, second)
            self.assertTrue(bus.detach_loop(second))
            second.close()

            # Late producers still append history after shutdown, without
            # trying to schedule onto the closed application loop.
            bus.publish("chat:late", {"ok": True})
            self.assertEqual(bus.history("chat:")[-1].topic, "chat:late")
        finally:
            if not first.is_closed():
                first.close()
            if not second.is_closed():
                second.close()

    def test_publish_routes_by_prefix(self):
        async def scenario():
            bus = EventBus()
            bus.attach_loop(asyncio.get_running_loop())
            received_chat: list[str] = []
            received_all: list[str] = []

            async def consume(prefix, sink):
                async for evt in bus.subscribe(prefix):
                    sink.append(evt.topic)
                    if len(sink) >= 2:
                        return

            t_chat = asyncio.create_task(consume("chat:", received_chat))
            t_all = asyncio.create_task(consume("", received_all))
            # Yield once so subscribers register before publishes.
            await asyncio.sleep(0)

            bus.publish("chat:hello", {"x": 1})
            bus.publish("wechat:msg", {"x": 2})
            bus.publish("chat:bye", {"x": 3})

            await asyncio.wait_for(asyncio.gather(t_chat, t_all), timeout=2.0)
            return received_chat, received_all

        chat, all_ = self._run(scenario())
        self.assertEqual(chat, ["chat:hello", "chat:bye"])
        # all_ saw the first two publishes (we stop after 2)
        self.assertEqual(all_[:2], ["chat:hello", "wechat:msg"])

    def test_history_replay(self):
        async def scenario():
            bus = EventBus(history=10)
            bus.attach_loop(asyncio.get_running_loop())
            # Publish before any subscriber exists.
            bus.publish("chat:a", {})
            bus.publish("chat:b", {})
            bus.publish("wechat:c", {})
            bus.publish("wechat:d", {})

            seen: list[str] = []

            async def consume():
                async for evt in bus.subscribe("chat:", replay=2):
                    seen.append(evt.topic)
                    if len(seen) >= 2:
                        return

            await asyncio.wait_for(consume(), timeout=2.0)
            return seen

        self.assertEqual(self._run(scenario()), ["chat:a", "chat:b"])

    def test_multiple_prefixes_filter_replay(self):
        async def scenario():
            bus = EventBus(history=10)
            bus.attach_loop(asyncio.get_running_loop())
            bus.publish("agent:status", {"phase": "old"})
            bus.publish("chat:next", {"content": "old"})
            bus.publish("wechat:message_in", {"text": "old"})

            seen: list[str] = []

            async def consume():
                async for evt in bus.subscribe(
                    ("agent:", "wechat:"),
                    replay=10,
                ):
                    seen.append(evt.topic)
                    if len(seen) >= 2:
                        return

            await asyncio.wait_for(consume(), timeout=2.0)
            return seen

        self.assertEqual(
            self._run(scenario()),
            [
                "agent:status", "wechat:message_in",
            ],
        )

    def test_multiple_prefixes_filter_before_bounded_queue(self):
        async def scenario():
            bus = EventBus(queue_size=2)
            bus.attach_loop(asyncio.get_running_loop())
            subscription = await bus.subscribe_after(("agent:", "wechat:"))
            try:
                bus.publish("agent:status", {})
                bus.publish("wechat:message_in", {})
                for i in range(5):
                    bus.publish("chat:next", {"i": i})
                await asyncio.sleep(0)

                queued = [
                    subscription.queue.get_nowait().topic,
                    subscription.queue.get_nowait().topic,
                ]
                return queued, subscription.live_resync_reason
            finally:
                await subscription.close()

        queued, resync_reason = self._run(scenario())
        self.assertEqual(queued, ["agent:status", "wechat:message_in"])
        self.assertIsNone(resync_reason)

    def test_empty_prefix_in_union_preserves_match_all_semantics(self):
        bus = EventBus(history=10)
        bus.publish("agent:status", {})
        bus.publish("chat:next", {})

        self.assertEqual(
            [event.topic for event in bus.history(("", "agent:"))],
            ["agent:status", "chat:next"],
        )

    def test_subscribe_after_replays_multiple_prefixes(self):
        async def scenario():
            bus = EventBus(history=10)
            bus.attach_loop(asyncio.get_running_loop())
            bus.publish("agent:status", {})
            cursor = bus._next_event_id - 1
            bus.publish("chat:next", {})
            bus.publish("session:runtime", {})
            bus.publish("wechat:message_in", {})

            subscription = await bus.subscribe_after(
                ("session:", "wechat:"),
                after_event_id=cursor,
                epoch=bus.epoch,
            )
            try:
                return [event.topic for event in subscription.replay]
            finally:
                await subscription.close()

        self.assertEqual(
            self._run(scenario()),
            ["session:runtime", "wechat:message_in"],
        )

    def test_subscribe_after_initial_replay_is_filtered_and_bounded(self):
        async def scenario():
            bus = EventBus(history=10)
            bus.publish("agent:first", {})
            bus.publish("chat:next", {})
            bus.publish("agent:second", {})

            subscription = await bus.subscribe_after("agent:", replay=1)
            try:
                return subscription.boundary_id, [
                    event.topic for event in subscription.replay
                ]
            finally:
                await subscription.close()

        boundary_id, replay = self._run(scenario())
        self.assertEqual(boundary_id, 3)
        self.assertEqual(replay, ["agent:second"])

    def test_filtered_cursor_ignores_evicted_unmatched_topics(self):
        async def scenario():
            bus = EventBus(history=2)
            bus.publish("agent:status", {})
            cursor = bus._next_event_id - 1
            for i in range(4):
                bus.publish("chat:next", {"i": i})

            subscription = await bus.subscribe_after(
                "agent:", after_event_id=cursor, epoch=bus.epoch,
            )
            try:
                return subscription.resync_reason, subscription.replay
            finally:
                await subscription.close()

        resync_reason, replay = self._run(scenario())
        self.assertIsNone(resync_reason)
        self.assertEqual(replay, [])

    def test_filtered_cursor_resyncs_when_matching_event_was_evicted(self):
        async def scenario():
            bus = EventBus(history=2)
            bus.publish("agent:status", {})
            bus.publish("chat:next", {})
            bus.publish("chat:done", {})

            subscription = await bus.subscribe_after(
                "agent:", after_event_id=0, epoch=bus.epoch,
            )
            try:
                return subscription.resync_reason
            finally:
                await subscription.close()

        self.assertEqual(
            self._run(scenario()),
            "history_window_exceeded",
        )

    def test_history_method_filters_and_limits(self):
        bus = EventBus(history=10)
        # No loop attached → publishes still record history (just don't fan out).
        for i in range(5):
            bus.publish("chat:x", {"i": i})
        bus.publish("wechat:y", {})

        chat_hist = bus.history("chat:")
        self.assertEqual(len(chat_hist), 5)
        self.assertTrue(all(e.topic == "chat:x" for e in chat_hist))

        last2 = bus.history("chat:", limit=2)
        self.assertEqual([e.payload["i"] for e in last2], [3, 4])

    def test_slow_subscriber_drops_oldest_not_blocks_producer(self):
        """A subscriber that never reads must not stall the producer.

        We use ``queue_size=2``, push 5 events, then drain. The bus's
        drop-oldest policy means the consumer ends up with the *latest*
        events (best-effort liveness), not blocked on the first.
        """
        async def scenario():
            bus = EventBus(queue_size=2)
            bus.attach_loop(asyncio.get_running_loop())

            results: list[str] = []
            sub_ready = asyncio.Event()

            async def slow():
                gen = bus.subscribe("chat:")
                # Register the subscriber, then sleep to let backlog form.
                aiter = gen.__aiter__()
                sub_ready.set()
                # Let publishes happen.
                await asyncio.sleep(0.05)
                # Now drain whatever survived the drop policy.
                while True:
                    try:
                        evt = await asyncio.wait_for(aiter.__anext__(), timeout=0.1)
                    except (asyncio.TimeoutError, StopAsyncIteration):
                        break
                    results.append(evt.topic)

            task = asyncio.create_task(slow())
            await sub_ready.wait()

            # Producer fires faster than the consumer is reading.
            for i in range(5):
                bus.publish(f"chat:{i}", {})

            await asyncio.wait_for(task, timeout=2.0)
            return results

        results = self._run(scenario())
        # Producer never blocked (the test would hang on backpressure).
        # Consumer got at most queue_size events, all from the chat: prefix.
        self.assertLessEqual(len(results), 2)
        for topic in results:
            self.assertTrue(topic.startswith("chat:"))

    def test_resumable_subscriber_overflow_requires_resync(self):
        async def scenario():
            bus = EventBus(queue_size=2)
            bus.attach_loop(asyncio.get_running_loop())
            subscription = await bus.subscribe_after("chat:")

            for i in range(3):
                bus.publish("chat:next", {"i": i})
            # Let the thread-safe dispatch callbacks fill the bounded queue.
            await asyncio.sleep(0)

            live = subscription.live().__aiter__()
            with self.assertRaises(StopAsyncIteration):
                await asyncio.wait_for(live.__anext__(), timeout=1.0)
            self.assertEqual(subscription.live_resync_reason, "subscriber_overflow")
            self.assertIn(subscription.queue, bus._resumable_subs)

            await subscription.close()
            self.assertNotIn(subscription.queue, bus._resumable_subs)
            self.assertFalse(any(q is subscription.queue for _, q in bus._subs))

        self._run(scenario())


if __name__ == "__main__":
    unittest.main()
