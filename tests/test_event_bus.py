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
        return asyncio.new_event_loop().run_until_complete(coro)

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

            seen: list[str] = []

            async def consume():
                async for evt in bus.subscribe("chat:", replay=10):
                    seen.append(evt.topic)
                    if len(seen) >= 2:
                        return

            await asyncio.wait_for(consume(), timeout=2.0)
            return seen

        self.assertEqual(self._run(scenario()), ["chat:a", "chat:b"])

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


if __name__ == "__main__":
    unittest.main()
