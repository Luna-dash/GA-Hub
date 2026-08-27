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
        error_retry_origin="",
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
_UPSTREAM_FAIL_TAIL = "partial answer...\n!!!Error: Upstream request failed"
_HTTP_403_RATELIMIT_BODY_TAIL = (
    'partial answer...\n!!!Error: HTTP 403: {"error":{"message":"rate limited"}}'
)
_HTTP_501_KEYWORD_BODY_TAIL = (
    'partial answer...\n!!!Error: HTTP 501 Not Implemented: {"error":"rate limited"}'
)


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
            self._code("x\n!!!Error: HTTP 520 Web Server Returned an Unknown Error"),
            "http_retryable",
        )

    def test_http_nonretryable_status_ignored(self):
        self.assertIsNone(self._code(_HTTP_401_TAIL))
        self.assertIsNone(self._code("x\n!!!Error: HTTP 404 Not Found"))
        self.assertIsNone(self._code("x\n!!!Error: HTTP 422 Unprocessable Entity"))

    def test_bare_upstream_failure_matches(self):
        self.assertEqual(self._code(_UPSTREAM_FAIL_TAIL), "upstream_failure")
        self.assertEqual(self._code("x\n!!!Error: upstream failure"), "upstream_failure")
        self.assertEqual(
            self._code("x\n!!!Error: Upstream request fault at gateway"),
            "upstream_failure",
        )

    def test_status_bearing_tail_not_rescued_by_body_keywords(self):
        # Status codes are decisive: a non-whitelisted status stays fatal even
        # when its body happens to mention "rate limit" / "retry later".
        self.assertIsNone(self._code(_HTTP_403_RATELIMIT_BODY_TAIL))
        self.assertIsNone(self._code(_HTTP_501_KEYWORD_BODY_TAIL))

    def test_whitelisted_status_with_keyword_body_still_retries(self):
        self.assertEqual(self._code(_HTTP_503_TAIL), "http_retryable")

    def test_rate_limit_family_without_status_prefix_intact(self):
        # Regression guard for the lookahead: free-text rate limits that do
        # NOT open with ``HTTP <code>`` must still classify as before.
        self.assertEqual(
            self._code("x\n!!!Error: RateLimitError: 429 too many requests"),
            "rate_limit",
        )

    def test_rate_limit_matches_any_phrasing(self):
        self.assertEqual(
            self._code("x\n!!!Error: rate limit exceeded, slow down"),
            "rate_limit",
        )
        self.assertEqual(
            self._code("x\n!!!Error: RateLimitError: 429 too many requests"),
            "rate_limit",
        )

    def test_http_429_folds_into_rate_limit_family(self):
        # 429 is semantically a rate-limit signal, not a generic HTTP blip;
        # it must classify into the rate_limit family (deep backoff scale).
        m = self.cr.classify_recoverable_error("x\n!!!Error: HTTP 429 Too Many Requests")
        self.assertIsNotNone(m)
        self.assertEqual(m.code, "rate_limit")
        self.assertAlmostEqual(m.delay_scale, 8.0)

    def test_family_delay_scales(self):
        cases = {
            _HTTP_503_TAIL: 2.0,  # http_retryable
            "x\n!!!Error: requests.exceptions.ReadTimeout: timed out": 1.5,
            "x\n!!!Error: ConnectionError: remote end closed": 2.5,
            "x\n!!!Error: json.JSONDecodeError: Expecting value": 1.0,
            "x\n!!!Error: SSLError: handshake failed": 4.0,
            "x\n!!!Error: SSE stream ended before done": 4.0,
        }
        for text, scale in cases.items():
            m = self.cr.classify_recoverable_error(text)
            self.assertIsNotNone(m, text)
            self.assertAlmostEqual(m.delay_scale, scale, msg=text)

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

    def test_delay_scale_multiplies_before_cap(self):
        cfg = self._cfg()
        self.assertAlmostEqual(self.cr.compute_backoff_delay(0, cfg, 8.0), 16.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(1, cfg, 2.0), 8.0)
        # A deep scale lifts the raw exponential past the cap -> still clamped.
        self.assertAlmostEqual(self.cr.compute_backoff_delay(3, cfg, 8.0), 60.0)

    def test_scheduled_curve_uses_own_base_and_cap(self):
        cfg = self._cfg()  # interactive curve: 2s base / 60s cap
        self.assertAlmostEqual(self.cr.compute_backoff_delay(3, cfg), 16.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(30, cfg), 60.0)
        # Scheduled sources ramp from their own 5s base toward a 10 min cap.
        self.assertAlmostEqual(self.cr.compute_backoff_delay(0, cfg, scheduled=True), 5.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(3, cfg, scheduled=True), 40.0)
        self.assertAlmostEqual(self.cr.compute_backoff_delay(30, cfg, scheduled=True), 600.0)
        # Family scales still multiply under the scheduled curve.
        self.assertAlmostEqual(self.cr.compute_backoff_delay(2, cfg, 4.0, scheduled=True), 80.0)
        # A custom low scheduled ceiling is honored independently.
        cfg2 = self.cr.ChatRetryConfig(
            scheduled_backoff_base_seconds=5.0, scheduled_backoff_max_seconds=45.0
        )
        self.assertAlmostEqual(self.cr.compute_backoff_delay(30, cfg2, scheduled=True), 45.0)

    def test_jitter_stays_within_band_and_respects_cap(self):
        cfg = self._cfg()
        for _ in range(30):
            d = self.cr.compute_backoff_delay(1, cfg, jitter=True)
            self.assertGreaterEqual(d, 2.0 * 2.0 * 0.85 - 1e-9)
            self.assertLessEqual(d, 2.0 * 2.0 * 1.15 + 1e-9)
        # Jitter must not push a capped delay above the cap.
        for _ in range(10):
            d = self.cr.compute_backoff_delay(30, cfg, jitter=True)
            self.assertLessEqual(d, 60.0)


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
        self.assertEqual(
            c.scheduled_backoff_base_seconds, self.cr.DEFAULT_SCHEDULED_BACKOFF_BASE_SECONDS
        )
        self.assertEqual(
            c.scheduled_backoff_max_seconds, self.cr.DEFAULT_SCHEDULED_BACKOFF_MAX_SECONDS
        )
        self.assertTrue(c.enabled)
        self.assertEqual(c.max_attempts, self.cr.DEFAULT_MAX_ATTEMPTS)
        self.assertEqual(c.scheduled_max_attempts, self.cr.DEFAULT_SCHEDULED_MAX_ATTEMPTS)

    def test_clamping_and_legacy_payload(self):
        c = self.cr.normalize_chat_retry_config({
            "enabled": True,
            "max_attempts": 99,          # clamped to MAX_CONFIG_ATTEMPTS
            "scheduled_max_attempts": 99,  # clamped to MAX_SCHEDULED_CONFIG_ATTEMPTS
            "backoff_base_seconds": 9999,  # clamped to 600
            "scheduled_backoff_base_seconds": 9999,  # clamped to 600
            "scheduled_backoff_max_seconds": -5,  # floored to 0, then >= base
            "backoff_factor": 0.5,       # floored to 1.0
            "backoff_max_seconds": 0.1,  # raised to >= base
            "legacy_key": "ignored",
        })
        self.assertEqual(c.max_attempts, self.cr.MAX_CONFIG_ATTEMPTS)
        self.assertEqual(c.scheduled_max_attempts, self.cr.MAX_SCHEDULED_CONFIG_ATTEMPTS)
        self.assertEqual(c.backoff_base_seconds, self.cr.MAX_CONFIG_BACKOFF_SECONDS)
        self.assertEqual(c.backoff_factor, 1.0)
        self.assertGreaterEqual(c.backoff_max_seconds, c.backoff_base_seconds)
        self.assertEqual(c.scheduled_backoff_base_seconds, self.cr.MAX_CONFIG_BACKOFF_SECONDS)
        self.assertEqual(c.scheduled_backoff_max_seconds, self.cr.MAX_CONFIG_BACKOFF_SECONDS)

    def test_garbage_values_fall_back_to_defaults(self):
        c = self.cr.normalize_chat_retry_config({
            "enabled": "not-a-bool",
            "max_attempts": "many",
            "scheduled_max_attempts": "lots",
            "backoff_base_seconds": "soon",
            "scheduled_backoff_base_seconds": "later",
            "scheduled_backoff_max_seconds": None,
            "backoff_factor": float("inf"),
            "backoff_max_seconds": None,
        })
        self.assertEqual(c.max_attempts, self.cr.DEFAULT_MAX_ATTEMPTS)
        self.assertEqual(c.scheduled_max_attempts, self.cr.DEFAULT_SCHEDULED_MAX_ATTEMPTS)
        self.assertEqual(c.backoff_base_seconds, self.cr.DEFAULT_BACKOFF_BASE_SECONDS)
        self.assertEqual(c.backoff_factor, self.cr.DEFAULT_BACKOFF_FACTOR)
        self.assertEqual(c.backoff_max_seconds, self.cr.DEFAULT_BACKOFF_MAX_SECONDS)
        self.assertEqual(
            c.scheduled_backoff_base_seconds, self.cr.DEFAULT_SCHEDULED_BACKOFF_BASE_SECONDS
        )
        self.assertEqual(
            c.scheduled_backoff_max_seconds, self.cr.DEFAULT_SCHEDULED_BACKOFF_MAX_SECONDS
        )


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

    def test_scheduled_source_gets_deeper_budget_and_origin_passthrough(self):
        from server.services.chat_retry import ChatRetryConfig
        cfg = ChatRetryConfig(enabled=True, max_attempts=2, scheduled_max_attempts=6,
                              backoff_base_seconds=0.01, backoff_factor=2.0,
                              backoff_max_seconds=60.0,
                              scheduled_backoff_base_seconds=0.01,
                              scheduled_backoff_max_seconds=60.0)
        # Third attempt of an unattended chain: plain budget (2) is already
        # spent, but the scheduled budget (6) keeps it alive.
        h = _make_handle(error_retry_count=2, error_retry_origin="scheduled_task")
        snap = _make_snap(source="scheduled_task")
        rv, bus, submit, _svc, _h, _snp = self._run(cfg=cfg, handle=h, snap=snap)
        self.assertTrue(rv)
        submit.assert_called_once()
        kwargs = submit.call_args.kwargs
        self.assertEqual(kwargs["error_retry_count"], 3)
        self.assertEqual(kwargs["error_retry_origin"], "scheduled_task")
        self.assertEqual(kwargs["retry_max"], 6)
        sched = next(c.args[1] for c in bus.publish.call_args_list if c.args[0] == "chat:retry_scheduled")
        self.assertEqual(sched["max_attempts"], 6)

    def test_retry_chain_keeps_original_trigger_identity_via_origin(self):
        from server.services.chat_retry import ChatRetryConfig
        cfg = ChatRetryConfig(enabled=True, max_attempts=2, scheduled_max_attempts=6,
                              backoff_base_seconds=0.01, backoff_factor=2.0,
                              backoff_max_seconds=60.0,
                              scheduled_backoff_base_seconds=0.01,
                              scheduled_backoff_max_seconds=60.0)
        # Fifth attempt of a scheduled chain: the surface source has become
        # "chat_error_retry", but the recorded origin preserves the deeper
        # budget across resubmits.
        h = _make_handle(error_retry_count=5, error_retry_origin="scheduled")
        snap = _make_snap(source="chat_error_retry")
        rv, _bus, submit, _svc, _h, _snp = self._run(cfg=cfg, handle=h, snap=snap)
        self.assertTrue(rv)
        submit.assert_called_once()
        self.assertEqual(submit.call_args.kwargs["error_retry_origin"], "scheduled")

    def test_interactive_chain_exhausts_at_plain_budget_even_after_resubmit(self):
        # An interactive origin must not inherit the scheduled budget just
        # because its surface source is now "chat_error_retry".
        h = _make_handle(error_retry_count=2, error_retry_origin="")
        snap = _make_snap(source="chat_error_retry")
        rv, bus, submit, _svc, _h, _snp = self._run(handle=h, snap=snap)
        self.assertTrue(rv)
        submit.assert_not_called()
        self.assertIn("chat:retry_exhausted", [c.args[0] for c in bus.publish.call_args_list])

    def test_scheduled_chain_exhausts_at_deep_budget_boundary(self):
        from server.services.chat_retry import ChatRetryConfig
        cfg = ChatRetryConfig(enabled=True, max_attempts=2, scheduled_max_attempts=6,
                              backoff_base_seconds=0.01, backoff_factor=2.0,
                              backoff_max_seconds=60.0,
                              scheduled_backoff_base_seconds=0.01,
                              scheduled_backoff_max_seconds=60.0)
        h = _make_handle(error_retry_count=6, error_retry_origin="scheduled")
        snap = _make_snap(source="chat_error_retry")
        rv, bus, submit, _svc, _h, _snp = self._run(cfg=cfg, handle=h, snap=snap)
        self.assertTrue(rv)
        submit.assert_not_called()
        published = [c.args[0] for c in bus.publish.call_args_list]
        self.assertIn("chat:retry_exhausted", published)
        self.assertNotIn("chat:retry", published)

    def test_disabled_config_short_circuits(self):
        from server.services.chat_retry import ChatRetryConfig
        rv, _bus, submit, _svc, _h, _snap = self._run(cfg=ChatRetryConfig(enabled=False))
        self.assertFalse(rv)
        submit.assert_not_called()


if __name__ == "__main__":
    unittest.main()
