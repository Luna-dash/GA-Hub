"""Tests for ``AgentService.rewind_turns``.

We don't run the real ``__init__`` (which imports the GA agent and binds
hooks). Instead we build a minimal stub instance via ``object.__new__``
and feed the smallest set of attributes the method touches:
  * ``agent.is_running`` flag (must be False)
  * ``agent.llmclient.backend.history`` (the list it cuts)
  * ``agent.history`` (TUI-parity log; appended on success)
  * ``_snapshots`` ordered dict (sid → snapshot, snapshot.done flag)
  * ``_lock``

This isolates the rewind algorithm from GA bootstrap costs.
"""
from __future__ import annotations

import sys
import threading
import types
import unittest
from collections import OrderedDict
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

# Make ``import server`` work when running tests from repo root.
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed.

    Mirrors the helper in ``test_paths_python.py`` so we don't pull in
    the real GA package just to read the class definition.
    """
    from server import _paths  # local import; needs sys.path bootstrap above

    fake_ga = types.SimpleNamespace()
    fake_ga.web_scan = lambda **_kw: {"status": "in-process"}
    fake_ga.web_execute_js = lambda *_a, **_kw: {"status": "in-process"}
    fake_ga.subprocess = types.SimpleNamespace(Popen=lambda *_a, **_kw: None)

    fake_agentmain = types.ModuleType("agentmain")
    fake_agentmain.GeneraticAgent = type("GeneraticAgent", (), {})

    fake_continue = types.ModuleType("frontends.continue_cmd")
    fake_continue.install = lambda *_a, **_kw: None
    fake_continue.reset_conversation = lambda *_a, **_kw: None

    # agent_service now delegates session bootstrap to the GA-owned bridge.
    fake_session_bridge = types.ModuleType("frontends.gahub.bridge.session")
    fake_session_bridge.install_agent_class = lambda *_a, **_kw: None
    fake_session_bridge.release_current = lambda *_a, **_kw: None
    fake_session_bridge.reset_conversation = lambda *_a, **_kw: None

    # rewind_adapter also pulls the durable-rewind bridge at module scope.
    fake_rewind_bridge = types.ModuleType("frontends.gahub.bridge.rewind")
    fake_rewind_bridge.bind_store = lambda *_a, **_kw: None
    fake_rewind_bridge.sync_store = lambda *_a, **_kw: 0

    def _apply_durable(agent, store, turn_count, **_kw):
        """Mirror the real bridge's orchestration so stubbed integration tests
        still exercise rewind_adapter through the same code path."""
        import importlib as _il

        turn_nodes = store.linear_path()
        if turn_count > len(turn_nodes):
            raise RuntimeError("rewind exceeds recorded history")
        backend_history = agent.llmclient.backend.history
        old_len = len(backend_history)
        first_removed_node = turn_nodes[-turn_count]
        old_head = getattr(store, "head", None)
        log_path = str(getattr(agent, "log_path", "") or "")

        native = _il.import_module("frontends.continue_cmd")
        worldline = _il.import_module("frontends.worldline")
        result = worldline.restore_plan(
            store, first_removed_node, mode="conv", to="before", log_path=log_path
        )
        store.save()
        restored_history = result["history"]

        archived_history = native.parse_native_log(log_path, allow_empty=True)
        if archived_history != restored_history:
            target = result.get("target")
            rewritten = bool(worldline.rewrite_projection(target, restored_history))
            archived_history = (
                native.parse_native_log(log_path, allow_empty=True) if rewritten else None
            )
            if archived_history != restored_history:
                if old_head is not None:
                    store.rewind_head(old_head)
                    store.save()
                raise RuntimeError(
                    "GA native archive rewrite could not be verified; rewind was not applied"
                )

        backend_history[:] = restored_history
        agent.history = list(result.get("hist_info") or [])
        handler = getattr(agent, "handler", None)
        if handler is not None:
            handler.history_info = list(agent.history)
            handler.working["key_info"] = result.get("key_info") or ""
        return {
            "kept": len(turn_nodes) - turn_count,
            "history_lines": len(restored_history),
            "removed_history_entries": max(0, old_len - len(restored_history)),
        }

    fake_rewind_bridge.apply_durable = _apply_durable

    fake_bridge = types.ModuleType("frontends.gahub.bridge")
    fake_bridge.session = fake_session_bridge
    fake_bridge.rewind = fake_rewind_bridge
    fake_gahub = types.ModuleType("frontends.gahub")
    fake_gahub.bridge = fake_bridge
    fake_frontends = types.ModuleType("frontends")
    fake_frontends.gahub = fake_gahub

    modules = {
        "ga": fake_ga,
        "agentmain": fake_agentmain,
        "frontends": fake_frontends,
        "frontends.gahub": fake_gahub,
        "frontends.gahub.bridge": fake_bridge,
        "frontends.gahub.bridge.session": fake_session_bridge,
        "frontends.gahub.bridge.rewind": fake_rewind_bridge,
        "frontends.continue_cmd": fake_continue,
    }
    with TemporaryDirectory() as td:
        with mock.patch.object(_paths, "GA_ROOT", Path(td)), \
             mock.patch.object(_paths, "discover_user_python", return_value="/tmp/py"), \
             mock.patch.dict(sys.modules, modules):
            # The stub-bound modules must not leak into later test files:
            # save the genuine entries and put them back once built.
            # rewind_adapter is ALSO evicted so its module-level
            # ``ga_rewind`` binding re-resolves to the stubbed bridge.
            saved_svc = sys.modules.get("server.services.agent_service")
            saved_adapter = sys.modules.get("server.services.rewind_adapter")
            sys.modules.pop("server.services.agent_service", None)
            sys.modules.pop("server.services.rewind_adapter", None)
            try:
                import importlib
                return importlib.import_module("server.services.agent_service")
            finally:
                if saved_svc is not None:
                    sys.modules["server.services.agent_service"] = saved_svc
                if saved_adapter is not None:
                    sys.modules["server.services.rewind_adapter"] = saved_adapter
                else:
                    sys.modules.pop("server.services.agent_service", None)


def _make_user_msg(text: str) -> dict:
    """A 'real' user turn — content list with a text block (TUI parity)."""
    return {"role": "user", "content": [{"type": "text", "text": text}]}


def _make_tool_result(tool_use_id: str = "tu_1") -> dict:
    """Tool-result user message — must be skipped by rewind cut detection."""
    return {
        "role": "user",
        "content": [{"type": "tool_result", "tool_use_id": tool_use_id, "content": "ok"}],
    }


def _make_assistant(text: str) -> dict:
    return {"role": "assistant", "content": [{"type": "text", "text": text}]}


class RewindTurnsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    def _make_svc(self, history: list[dict], snapshots: list[tuple[str, bool]]):
        """Build a minimal AgentService stub.

        ``snapshots`` is a list of ``(sid, done)`` pairs in insertion order.
        """
        svc = self.svc_mod.AgentService.for_tests()
        svc._snapshots = OrderedDict()
        for sid, done in snapshots:
            snap = types.SimpleNamespace(done=done)
            svc._snapshots[sid] = snap

        backend = types.SimpleNamespace(history=list(history))
        llmclient = types.SimpleNamespace(backend=backend)
        svc.agent = types.SimpleNamespace(
            is_running=False,
            llmclient=llmclient,
            history=[],  # GA working-memory log
        )
        return svc

    # ── session-path guards (the only rewind path since the legacy
    #    global-agent in-memory branch was removed, 2026-09-05) ───────

    def test_session_rewind_refuses_while_running(self):
        svc = self._make_svc(
            [_make_user_msg("u1"), _make_assistant("a1")],
            [("s1", True)],
        )
        svc.session_id = "session-A"
        svc.agent.is_running = True
        with self.assertRaises(RuntimeError) as cm:
            svc.rewind_turns(n=1)
        self.assertIn("running", str(cm.exception).lower())

    def test_global_runtime_rewind_is_refused(self):
        svc = self._make_svc(
            [_make_user_msg("u1"), _make_assistant("a1")],
            [("s1", True)],
        )
        with self.assertRaises(RuntimeError) as cm:
            svc.rewind_turns(n=1)
        self.assertIn("session-scoped", str(cm.exception))

    def test_session_rewind_rewrites_archive_and_working_memory(self):
        history = [
            _make_user_msg("u1"), _make_assistant("a1"),
            _make_user_msg("u2"), _make_assistant("a2"),
            _make_user_msg("u3"), _make_assistant("a3"),
        ]
        svc = self._make_svc(history, [("live-3", True)])
        svc.session_id = "session-A"
        svc._rewind_lock = threading.RLock()
        svc.agent.log_path = "/tmp/model_responses_session-A.txt"
        svc.agent.handler = types.SimpleNamespace(
            history_info=["old-info"],
            working={"key_info": "old-key"},
        )

        class FakeStore:
            def __init__(self):
                self.reconciled = None
                self.saved = 0

            def linear_path(self):
                return ["turn-1", "turn-2", "turn-3"]

            def first_user_message(self, node_id):
                return {"text": node_id}

            def _msg_user_text(self, message):
                return message["text"]

            def reconcile(self, history_rows):
                self.reconciled = history_rows

            def save(self):
                self.saved += 1

        store = FakeStore()
        svc._rewind_store = store
        native_history = [{"native": True}]
        archive_state = {"history": native_history}
        restore_calls: list[dict] = []

        fake_continue = types.ModuleType("frontends.continue_cmd")
        fake_continue.parse_native_log = (
            lambda path, allow_empty: archive_state["history"]
        )
        fake_worldline = types.ModuleType("frontends.worldline")

        def restore_plan(fake_store, node_id, **kwargs):
            restore_calls.append({
                "store": fake_store,
                "node_id": node_id,
                **kwargs,
            })
            archive_state["history"] = history[:2]
            return {
                "history": history[:2],
                "hist_info": ["restored-info"],
                "key_info": "restored-key",
            }

        fake_worldline.restore_plan = restore_plan
        fake_worldline.rewrite_projection = mock.MagicMock(return_value=True)
        modules = {
            "frontends": types.ModuleType("frontends"),
            "frontends.continue_cmd": fake_continue,
            "frontends.worldline": fake_worldline,
        }
        with mock.patch.dict(sys.modules, modules), \
             mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            result = svc.rewind_turns(n=2)

        # sync_store is orchestrated separately by the session path, not by
        # rewind_adapter.apply_durable — so reconcile is NOT invoked here.
        self.assertIsNone(store.reconciled)
        self.assertEqual(store.saved, 1)
        self.assertEqual(restore_calls, [{
            "store": store,
            "node_id": "turn-2",
            "mode": "conv",
            "to": "before",
            "log_path": "/tmp/model_responses_session-A.txt",
        }])
        self.assertEqual(svc.agent.llmclient.backend.history, history[:2])
        self.assertEqual(svc.agent.history, ["restored-info"])
        self.assertEqual(svc.agent.handler.history_info, ["restored-info"])
        self.assertEqual(svc.agent.handler.working["key_info"], "restored-key")
        self.assertEqual(result["kept"], 1)
        self.assertEqual(result["removed_sids"], ["live-3"])
        topic, payload = fake_bus.publish.call_args[0]
        self.assertEqual(topic, "chat:rewound")
        self.assertEqual(payload["session_id"], "session-A")
        fake_worldline.rewrite_projection.assert_not_called()

    def test_session_rewind_fails_if_archive_rewrite_cannot_be_verified(self):
        history = [_make_user_msg("u1"), _make_assistant("a1")]
        svc = self._make_svc(history, [("live-1", True)])
        svc.session_id = "session-A"
        svc._rewind_lock = threading.RLock()
        svc.agent.log_path = "/tmp/model_responses_session-A.txt"

        class FakeStore:
            head = "turn-1"

            def __init__(self):
                self.restored_heads = []

            def linear_path(self):
                return ["turn-1"]

            def first_user_message(self, node_id):
                return {"text": node_id}

            def _msg_user_text(self, message):
                return message["text"]

            def reconcile(self, _history_rows):
                return None

            def save(self):
                return None

            def rewind_head(self, node_id):
                self.restored_heads.append(node_id)

        store = FakeStore()
        svc._rewind_store = store
        fake_continue = types.ModuleType("frontends.continue_cmd")
        fake_continue.parse_native_log = lambda _path, allow_empty: list(history)
        fake_worldline = types.ModuleType("frontends.worldline")
        fake_worldline.restore_plan = lambda *_args, **_kwargs: {
            "history": [],
            "hist_info": None,
            "key_info": None,
            "target": "origin",
        }
        fake_worldline.rewrite_projection = mock.MagicMock(return_value=False)
        modules = {
            "frontends": types.ModuleType("frontends"),
            "frontends.continue_cmd": fake_continue,
            "frontends.worldline": fake_worldline,
        }

        with mock.patch.dict(sys.modules, modules), \
             mock.patch.object(self.svc_mod, "bus", mock.MagicMock()) as fake_bus:
            with self.assertRaisesRegex(RuntimeError, "could not be verified"):
                svc.rewind_turns(n=1)

        self.assertEqual(svc.agent.llmclient.backend.history, history)
        self.assertEqual(list(svc._snapshots), ["live-1"])
        self.assertEqual(store.restored_heads, ["turn-1"])
        # New bridge contract: rewrite_projection(target, history) — target is
        # the value returned in restore_plan's result, history is the restored
        # native log rows (empty here because restore_plan returned []).
        fake_worldline.rewrite_projection.assert_called_once_with("origin", [])
        fake_bus.publish.assert_not_called()


class RewindAdapterSharedPlanningTests(unittest.TestCase):
    """Direct tests for the shared planner/finalizer extracted from the two
    rewind commit strategies (selection semantics must stay identical while
    the commits stay distinct)."""

    def _adapter(self) -> tuple:
        from server.services.rewind_adapter import RewindAdapter

        adapter = object.__new__(RewindAdapter)
        adapter.agent = types.SimpleNamespace(is_running=False)
        adapter.session_id = "session-1"
        adapter.snapshots = types.SimpleNamespace()
        adapter.lock = threading.RLock()
        adapter._checkpoint_lock = threading.RLock()
        adapter.store = None
        bus = mock.MagicMock()
        adapter._bus = bus
        return adapter, bus

    @staticmethod
    def _done_items(*sids: str) -> list[tuple]:
        return [(sid, types.SimpleNamespace(done=True)) for sid in sids]

    def test_resolve_turn_count_by_sid_counts_trailing_turns(self):
        adapter, _ = self._adapter()
        done = self._done_items("s1", "s2", "s3")
        self.assertEqual(
            adapter._resolve_turn_count(sid="s2", n=None, done_items=done, scope="done turns"),
            2,
        )

    def test_resolve_turn_count_rejects_unknown_sid_low_n_and_missing_request(self):
        adapter, _ = self._adapter()
        done = self._done_items("s1")
        with self.assertRaisesRegex(ValueError, "not found among done turns"):
            adapter._resolve_turn_count(sid="gone", n=None, done_items=done, scope="done turns")
        with self.assertRaisesRegex(ValueError, "at least 1"):
            adapter._resolve_turn_count(sid=None, n=0, done_items=done, scope="done turns")
        with self.assertRaisesRegex(ValueError, "either sid or n"):
            adapter._resolve_turn_count(sid=None, n=None, done_items=done, scope="done turns")

    def test_finalize_publishes_the_shared_success_event_shape(self):
        adapter, bus = self._adapter()
        result = adapter._finalize_rewind(
            turn_count=2,
            removed_sids=["s2", "s3"],
            result={
                "kept": 1,
                "history_lines": 4,
                "removed_history_entries": 6,
            },
            label="session rewind",
        )
        self.assertEqual(
            result,
            {
                "removed_sids": ["s2", "s3"],
                "kept": 1,
                "history_lines": 4,
                "removed_history_entries": 6,
            },
        )
        bus.publish.assert_called_once_with(
            "chat:rewound",
            {
                "removed_sids": ["s2", "s3"],
                "kept": 1,
                "history_lines": 4,
                "session_id": "session-1",
            },
        )


class RewindWithRealProjectionTests(unittest.TestCase):
    """Regression: the rewind flow must work against the real
    ``ChatStreamProjection`` store, not only plain dicts.

    ``ChatStreamProjection.pop(stream_id)`` takes no default argument — a
    ``pop(sid, None)`` call raised ``TypeError`` in production, killing the
    rewind endpoint *after* the worldline rewrite but *before* the
    ``chat:rewound`` event.
    """

    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    def _make_svc(self, history: list[dict], snapshots: list[tuple[str, bool]]):
        from server.services.chat_stream_projection import ChatSnapshot, ChatStreamProjection

        svc = self.svc_mod.AgentService.for_tests()
        svc._snapshots = ChatStreamProjection()
        for sid, done in snapshots:
            svc._snapshots.add(
                ChatSnapshot(stream_id=sid, source="user", query=f"q-{sid}", started_at=0.0, done=done)
            )

        backend = types.SimpleNamespace(history=list(history))
        svc.agent = types.SimpleNamespace(
            is_running=False,
            llmclient=types.SimpleNamespace(backend=backend),
            history=[],
            log_path="/tmp/model_responses_session-real.txt",
            handler=types.SimpleNamespace(history_info=[], working={}),
        )
        svc._rewind_lock = threading.RLock()
        return svc

    def test_rewind_by_n_drops_last_turn_against_real_projection(self):
        history = [
            _make_user_msg("u1"), _make_assistant("a1"),
            _make_user_msg("u2"), _make_assistant("a2"),
        ]
        svc = self._make_svc(history, [("s1", True), ("s2", True)])
        svc.session_id = "session-real"

        class FakeStore:
            head = "turn-2"

            def __init__(self):
                self.reconciled = None
                self.saved = 0

            def linear_path(self):
                return ["turn-1", "turn-2"]

            def first_user_message(self, node_id):
                return {"text": node_id}

            def _msg_user_text(self, message):
                return message["text"]

            def reconcile(self, rows):
                self.reconciled = rows

            def save(self):
                self.saved += 1

            def rewind_head(self, node_id):
                pass

        store = FakeStore()
        svc._rewind_store = store
        planned = history[:2]
        fake_continue = types.ModuleType("frontends.continue_cmd")
        fake_continue.parse_native_log = lambda _path, allow_empty: list(planned)
        fake_worldline = types.ModuleType("frontends.worldline")
        fake_worldline.restore_plan = lambda *_args, **_kwargs: {
            "history": list(planned), "hist_info": None, "key_info": None,
            "target": "turn-1",
        }
        fake_worldline.rewrite_projection = mock.MagicMock()
        modules = {
            "frontends": types.ModuleType("frontends"),
            "frontends.continue_cmd": fake_continue,
            "frontends.worldline": fake_worldline,
        }
        with mock.patch.dict(sys.modules, modules),              mock.patch.object(self.svc_mod, "bus", mock.MagicMock()):
            result = svc.rewind_turns(n=1)

        self.assertEqual(result["removed_sids"], ["s2"])
        self.assertEqual(result["kept"], 1)
        self.assertIsNone(svc._snapshots.get("s2"))
        self.assertIsNotNone(svc._snapshots.get("s1"))
        self.assertEqual(svc.agent.llmclient.backend.history, planned)
        fake_worldline.rewrite_projection.assert_not_called()

    def test_drop_snapshots_tolerates_missing_ids_on_real_projection(self):
        from server.services.chat_stream_projection import ChatStreamProjection

        adapter = object.__new__(self.svc_mod.RewindAdapter)
        adapter.snapshots = ChatStreamProjection()

        adapter._drop_snapshots(["ghost"])  # must not raise

        self.assertEqual(adapter.snapshots.items(), [])


class RealNativeArchiveSmoke(unittest.TestCase):
    """End-to-end smoke against the REAL GA archive machinery (no stubs).

    The durable-rewind bridge must round-trip a genuine
    ``model_responses_*.txt`` log: render a two-turn archive, reconcile the
    worldline, rewind one turn, then re-parse the rewritten projection with
    the real ``continue_cmd.parse_native_log`` and confirm it matches the
    restored tree. This guards the GA-owned native format contract that the
    stubbed tests above cannot cover.
    """

    def _history(self) -> list[dict]:
        return [
            _make_user_msg("first question"),
            _make_assistant("first answer"),
            _make_user_msg("second question"),
            _make_assistant("second answer"),
        ]

    def test_real_archive_round_trip_through_bridge(self):
        import os
        import importlib

        # Stubbed tests above leave a bare ``frontends`` namespace placeholder in
        # ``sys.modules`` (a plain ModuleType without ``__path__``).  Ensure the
        # REAL package is importable here, then restore the stub afterwards.
        ga_frontends = os.path.join(
            os.environ.get("GA_ROOT", r"D:\study\GA"), "frontends"
        )
        placeholder = sys.modules.get("frontends")
        real_pkg = types.ModuleType("frontends")
        real_pkg.__path__ = [ga_frontends]
        sys.modules["frontends"] = real_pkg
        try:
            continue_cmd = importlib.import_module("frontends.continue_cmd")
            worldline = importlib.import_module("frontends.worldline")
            bridge = importlib.import_module("frontends.gahub.bridge.rewind")
        finally:
            # Re-point to the placeholder so downstream stubbed tests behave.
            if placeholder is not None:
                sys.modules["frontends"] = placeholder

        with TemporaryDirectory() as td:
            log_path = os.path.join(td, "model_responses_smoke.txt")
            history = self._history()
            with open(log_path, "w", encoding="utf-8") as fh:
                fh.write(worldline.render_native_history(history))

            store = worldline.RewindStore.for_log(
                os.path.normpath(td), log_path, os.path.normpath(td)
            )
            backend_history: list[dict] = []
            agent = types.SimpleNamespace(
                log_path=log_path,
                llmclient=types.SimpleNamespace(
                    backend=types.SimpleNamespace(history=backend_history)
                ),
                handler=types.SimpleNamespace(history_info=[], working={}),
                history=[],
            )
            lock = threading.RLock()

            # Reconcile the real archive into the worldline, then cut one turn.
            bridge.sync_store(agent, store=store, checkpoint_lock=lock)
            self.assertEqual(
                continue_cmd.parse_native_log(log_path, allow_empty=True), history
            )
            result = bridge.apply_durable(
                agent, store=store, turn_count=1, checkpoint_lock=lock
            )

            self.assertEqual(result["kept"], 1)
            self.assertEqual(result["history_lines"], 2)
            # Live runtime history was truncated to the first turn.
            self.assertEqual(backend_history, history[:2])
            # The on-disk projection was rewritten and re-parses identically.
            self.assertEqual(
                continue_cmd.parse_native_log(log_path, allow_empty=True),
                history[:2],
            )


if __name__ == "__main__":
    unittest.main()
