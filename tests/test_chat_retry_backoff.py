"""Tests for the recoverable chat-error retry backoff.

Covers ``server.services.chat_retry`` (patterns / delay math / config
normalization) and the backoff wiring in
``AgentService._maybe_retry_recoverable_error`` plus its two helpers,
using the same GA-stubbed isolated module loader as
``test_rewind_turns.py`` so no real GA bootstrap happens.
"""
from __future__ import annotations

import sys
import threading
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest import mock

_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed."""
    from server import _paths

    fake_ga = types.SimpleNamespace()
    fake_ga.web_scan = lambda **_kw: {"status": "in-process"}
    fake_ga.web_execute_js = lambda *_a, **_kw: {"status": "in-process"}
    fake_ga.subprocess = types.SimpleNamespace(Popen=lambda *_a, **_kw: None)

    fake_agentmain = types.ModuleType("agentmain")
    fake_agentmain.GeneraticAgent = type("GeneraticAgent", (), {})

    fake_continue = types.ModuleType("frontends.continue_cmd")
    fake_continue.install = lambda *_a, **_kw: None
    fake_continue.reset_conversation = lambda *_a, **_kw: None

    modules = {
        "ga": fake_ga,
        "agentmain": fake_agentmain,
        "frontends": types.ModuleType("frontends"),
        "frontends.continue_cmd": fake_continue,
    }
    with TemporaryDirectory() as td:
        with mock.patch.object(_paths, "GA_ROOT", Path(td)), \
             mock.patch.object(_paths, "discover_user_python", return_value="/tmp/py"), \
             mock.patch.dict(sys.modules, modules):
            sys.modules.pop("server.services.agent_service", None)
            import importlib
            return importlib.import_module("server.services.agent_service")


def _make_svc(mod):
    svc = object.__new__(mod.AgentService)
    svc._lock = threading.Lock()
    svc._streams = {}
    svc._fanout_stop_event = threading.Event()
    return svc


def _make_handle(**overrides):
    fields = dict(
        stream_id="st-1",
        logical_id="lg-1",
        session_id=None,
        run_id=None,
        auto_continue_count=0,
        error_retry_count=0,
        finished=True,
    )
    fields.update(overrides)
    return SimpleNamespace(**fields)


def _make_snap(**overrides):
    fields = dict(source="user", aborted=False)
    fields.update(overrides)
    return SimpleNamespace(**fields)


_HTTP_503_TAIL = "partial answer...\n!!!Error: HTTP 503 Service Unavailable"
_HTTP_401_TAIL = "partial answer...\n!!!Error: HTTP 401 Unauthorized"


class ClassifyRecoverableErrorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.services import chat_retry as cr
        cls.cr = cr

    def _code(self, text):
        m = self.cr.classify_recoverable_error(text)
        return None if m is None else m.code

    def test_http_whitelisted_statuses_match(self):
        self.assertEqual(self._code(_HTTP_503_TAIL), "http_retryable")
        self.assertEqual(
            self._code("x\n!!!Error: HTTP 429 Too Many Requests"),
            "http_retryable",
        )
        self.assertEqual(
            self._code("x\n!!!Error: HTTP 520 Web Server Returned an Unknown Error"),
            "http_retryable",
        )

    def test_http_nonretryable_status_ignored(self):
        self.assertIsNone(self._code(_HTTP_401_TAIL))
        self.assertIsNone(self._code("x\n!!!Error: HTTP 404 Not Found"))
        self.assertIsNone(self._code("x\n!!!Error: HTTP 422 Unprocessable Entity"))

    def test_rate_limit_matches_any_phrasing(self):
        self.assertEqual(
            self._code("x\n!!!Error: rate limit exceeded, slow down"),
            "rate_limit",
        )
        self.assertEqual(
            self._code("x\n!!!Error: RateLimitError: 429 too many requests"),
            "rate_limit",
        )

    def test_exception_family_patterns(self):
        self.assertEqual(
            self._code("x\n!!!Error: requests.exceptions.ReadTimeout: timed out"),
            "timeout",
        )
        self.assertEqual(
            self._code("x\n!!!Error: requests.exceptions.ConnectTimeout(...)"),
            "timeout",
        )
        self.assertEqual(
            self._code("x\n!!!Error: ConnectionError: remote end closed"),
            "connection_error",
        )
        self.assertEqual(
            self._code("x\n!!!Error: requests.exceptions.ChunkedEncodingError(...)"),
            "connection_error",
        )
        self.assertEqual(
            self._code("x\n!!!Error: json.JSONDecodeError: Expecting value"),
            "json_decode_error",
        )
        self.assertEqual(
            self._code("x\n!!!Error: SSLError: handshake failed"),
            "ssl_error",
        )
        self.assertEqual(
            self._code("x\n!!!Error: SSE stream ended before done"),
            "sse_error",
        )

    def test_stale_midtext_error_ignored_tail_anchor(self):
        # Patterns anchor at the very end (\Z): an error followed by more
        # normal output must not trigger a retry.
        filler = "still working...\n" * 40
        self.assertIsNone(self._code("!!!Error: HTTP 503 busy\n" + filler))
        # Same error at the tail does match.
        self.assertEqual(self._code(filler + "!!!Error: HTTP 503 busy"), "http_retryable")


class ComputeBackoffDelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.services import chat_retry as cr
        cls.cr = cr

    def _cfg(self, **kw):
        return self.cr.ChatRetryConfig(**{"backoff_base_seconds": 2.0, "backoff_factor": 2.0, "backoff_max_seconds": 60.0, **kw})

    def test_exponential_growth_and_cap(self):
        cfg = self._cfg()
        self.assertAlmostEqual(self.cr.compute_backoff_delay(0, cfg), 2.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(1, cfg), 4.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(3, cfg), 16.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(30, cfg), 60.0)  # capped

    def test_zero_base_means_no_wait(self):
        self.assertAlmostEqual(self.cr.compute_backoff_delay(0, self._cfg(backoff_base_seconds=0.0)), 0.0)


class NormalizeConfigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from server.services import chat_retry as cr
        cls.cr = cr

    def test_defaults_when_missing(self):
        c = self.cr.normalize_chat_retry_config(None)
        self.assertEqual(c.backoff_base_seconds, self.cr.DEFAULT_BACKOFF_BASE_SECONDS)
        self.assertEqual(c.backoff_factor, self.cr.DEFAULT_BACKOFF_FACTOR)
        self.assertEqual(c.backoff_max_seconds, self.cr.DEFAULT_BACKOFF_MAX_SECONDS)
        self.assertTrue(c.enabled)
        self.assertEqual(c.max_attempts, self.cr.DEFAULT_MAX_ATTEMPTS)

    def test_clamping_and_legacy_payload(self):
        c = self.cr.normalize_chat_retry_config({
            "enabled": True,
            "max_attempts": 99,          # clamped to MAX_CONFIG_ATTEMPTS
            "backoff_base_seconds": 9999,  # clamped to 600
            "backoff_factor": 0.5,       # floored to 1.0
            "backoff_max_seconds": 0.1,  # raised to >= base
            "legacy_key": "ignored",
        })
        self.assertEqual(c.max_attempts, self.cr.MAX_CONFIG_ATTEMPTS)
        self.assertEqual(c.backoff_base_seconds, self.cr.MAX_CONFIG_BACKOFF_SECONDS)
        self.assertEqual(c.backoff_factor, 1.0)
        self.assertGreaterEqual(c.backoff_max_seconds, c.backoff_base_seconds)

    def test_garbage_values_fall_back_to_defaults(self):
        c = self.cr.normalize_chat_retry_config({
            "enabled": "not-a-bool",
            "max_attempts": "many",
            "backoff_base_seconds": "soon",
            "backoff_factor": float("inf"),
            "backoff_max_seconds": None,
        })
        self.assertEqual(c.max_attempts, self.cr.DEFAULT_MAX_ATTEMPTS)
        self.assertEqual(c.backoff_base_seconds, self.cr.DEFAULT_BACKOFF_BASE_SECONDS)
        self.assertEqual(c.backoff_factor, self.cr.DEFAULT_BACKOFF_FACTOR)
        self.assertEqual(c.backoff_max_seconds, self.cr.DEFAULT_BACKOFF_MAX_SECONDS)


class MaybeRetryBackoffTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_agent_service_module()

    def _run(self, *, cfg=None, handle=None, snap=None, content=_HTTP_503_TAIL, streams=None):
        from server.services.chat_retry import ChatRetryConfig
        if cfg is None:
            cfg = ChatRetryConfig(enabled=True, max_attempts=2,
                                  backoff_base_seconds=0.01, backoff_factor=2.0,
                                  backoff_max_seconds=60.0)
        svc = _make_svc(self.mod)
        if streams:
            svc._streams = streams
        svc._load_chat_retry_config = lambda: cfg
        h = handle or _make_handle()
        snp = snap or _make_snap()
        with mock.patch.object(self.mod, "bus") as fake_bus, \
             mock.patch.object(svc, "submit") as fake_submit:
            rv = svc._maybe_retry_recoverable_error(h, snp, content)
        return rv, fake_bus, fake_submit, svc, h, snp

    def test_retry_scheduled_then_submitted_with_backoff_event(self):
        rv, bus, submit, _svc, h, _snap = self._run()
        self.assertTrue(rv)
        submit.assert_called_once()
        kwargs = submit.call_args.kwargs
        self.assertEqual(kwargs["source"], "chat_error_retry")
        self.assertEqual(kwargs["error_retry_count"], 1)
        self.assertEqual(kwargs["retry_of"], "st-1")
        published = [c.args[0] for c in bus.publish.call_args_list]
        self.assertIn("chat:retry_scheduled", published)
        self.assertIn("chat:retry", published)
        sched = next(c.args[1] for c in bus.publish.call_args_list if c.args[0] == "chat:retry_scheduled")
        self.assertGreater(sched["delay_seconds"], 0.0)
        self.assertEqual(sched["attempt"], 1)

    def test_abort_during_backoff_cancels_resubmit(self):
        snap = _make_snap(aborted=True)
        rv, _bus, submit, _svc, _h, _snap2 = self._run(snap=snap)
        self.assertFalse(rv)
        submit.assert_not_called()

    def test_shutdown_flag_cancels_via_wait_helper(self):
        svc = _make_svc(self.mod)
        svc._fanout_stop_event.set()
        self.assertFalse(svc._wait_for_error_retry_slot(_make_handle(), _make_snap(), 5.0))

    def test_exhausted_publishes_without_resubmit(self):
        h = _make_handle(error_retry_count=2)
        rv, bus, submit, _svc, _h, _snap = self._run(handle=h)
        self.assertTrue(rv)
        submit.assert_not_called()
        published = [c.args[0] for c in bus.publish.call_args_list]
        self.assertIn("chat:retry_exhausted", published)
        self.assertNotIn("chat:retry", published)

    def test_newer_live_stream_blocks_retry_after_wait(self):
        other = SimpleNamespace(stream_id="st-2", session_id=None, finished=False)
        rv, bus, submit, _svc, _h, _snap = self._run(streams={"st-2": other})
        self.assertFalse(rv)
        submit.assert_not_called()
        published = [c.args[0] for c in bus.publish.call_args_list]
        self.assertIn("chat:retry_scheduled", published)
        self.assertNotIn("chat:retry", published)

    def test_disabled_config_short_circuits(self):
        from server.services.chat_retry import ChatRetryConfig
        rv, _bus, submit, _svc, _h, _snap = self._run(cfg=ChatRetryConfig(enabled=False))
        self.assertFalse(rv)
        submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
