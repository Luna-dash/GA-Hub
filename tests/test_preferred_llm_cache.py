"""Cache regression for ``AgentService`` user-preferred-LLM handling.

A. 聊天流畅度优化：submit 热路径每次调用 ``_restore_preferred_llm``，
   原实现每次都 ``_paths.load_config()`` 读盘。改为实例内存缓存后，
   首次加载即填缓存，后续 submit 与 switch 共享缓存，磁盘读次数不再随
   submit 次数线性增长。

真值源唯一性：``preferred_llm_no`` 的写入入口仅 ``switch_llm``（经
``_save_preferred_llm``）；``_restore_preferred_llm`` 与 ``_select_llm_for_task``
只读不改持久值。因此缓存可在 save 时同步刷新而保持语义等价。
"""
from __future__ import annotations

import sys
import types
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

# Make ``import server`` work when running tests from repo root.
_REPO = Path(__file__).resolve().parent.parent
if str(_REPO) not in sys.path:
    sys.path.insert(0, str(_REPO))


def _load_agent_service_module():
    """Import ``server.services.agent_service`` with GA imports stubbed.

    Mirrors the helper used across the agent_service unit tests so the real
    GA package is never pulled in just to read the class definition.
    """
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


class _StubAgent:
    """Minimal agent surface exercised by preferred-LLM restore/save."""

    def __init__(self, llm_no: int = 1, n_clients: int = 3) -> None:
        self.llm_no = llm_no
        self.llmclients = list(range(n_clients))
        self.next_llm_calls: list[int] = []

    def next_llm(self, n: int) -> None:
        self.next_llm_calls.append(n)
        self.llm_no = n

    def get_llm_name(self, n: int) -> str:
        return f"llm-{n}"

    def load_llm_sessions(self) -> None:
        pass


def _make_service(svc_mod, agent: _StubAgent):
    """Build an AgentService instance without running ``__init__``."""
    service = object.__new__(svc_mod.AgentService)
    service.agent = agent
    service._manage_global_preference = True
    service._llm_preferences = svc_mod.LlmPreferenceStore()
    return service


class PreferredLlmCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.svc_mod = _load_agent_service_module()

    # ── restore: repeated calls hit disk at most once ────────────
    def test_restore_caches_load_config(self):
        agent = _StubAgent(llm_no=2, n_clients=3)
        service = _make_service(self.svc_mod, agent)

        with mock.patch.object(
            self.svc_mod._paths, "load_config",
            return_value={"preferred_llm_key": "gamma_oai_config"},
        ) as lc:
            mock.patch.object(
                self.svc_mod.LlmRegistry, "resolve", return_value=2
            ).start()
            self.addCleanup(mock.patch.stopall)
            service._restore_preferred_llm()
            service._restore_preferred_llm()
            service._restore_preferred_llm()

        # After the first load the cached preferred value is reused; subsequent
        # restores must not re-read disk.
        self.assertLessEqual(
            lc.call_count, 1,
            f"load_config should be called at most once, got {lc.call_count}",
        )

    def test_restore_no_preference_caches_negative(self):
        # When config has no preferred_llm_no, repeated restores must still
        # read disk at most once (cache the "unset" outcome).
        agent = _StubAgent(llm_no=1, n_clients=3)
        service = _make_service(self.svc_mod, agent)

        with mock.patch.object(
            self.svc_mod._paths, "load_config", return_value={},
        ) as lc:
            service._restore_preferred_llm()
            service._restore_preferred_llm()

        self.assertLessEqual(
            lc.call_count, 1,
            f"load_config should be called at most once, got {lc.call_count}",
        )

    def test_restore_migrates_legacy_index_to_stable_key(self):
        agent = _StubAgent(llm_no=0, n_clients=3)
        service = _make_service(self.svc_mod, agent)
        saved = []

        with mock.patch.object(
            self.svc_mod._paths,
            "load_config",
            return_value={"preferred_llm_no": 2},
        ) as lc, mock.patch.object(
            self.svc_mod._paths, "save_config", side_effect=saved.append
        ):
            self.svc_mod.LlmRegistry.reload_and_snapshot = mock.MagicMock(
                return_value=[("alpha_oai_config", 0), ("beta_oai_config", 1), ("gamma_oai_config", 2)]
            )
            mock.patch.object(self.svc_mod.LlmRegistry, "resolve", return_value=2).start()
            self.addCleanup(mock.patch.stopall)
            service._restore_preferred_llm()
            service._restore_preferred_llm()

        self.assertEqual(saved, [{
            "preferred_llm_no": 2,
            "preferred_llm_key": "gamma_oai_config",
        }])
        self.assertEqual(agent.llm_no, 2)
        self.assertEqual(agent.next_llm_calls, [2])
        self.assertLessEqual(lc.call_count, 2)

    # ── save caches the new value ────────────────────────────────
    def test_switch_updates_key_cache_and_avoids_subsequent_restore_load(self):
        agent = _StubAgent(llm_no=1, n_clients=3)
        agent.get_llm_name = lambda: "LLM-3"  # restore logs the name
        service = _make_service(self.svc_mod, agent)

        with mock.patch.object(self.svc_mod._paths, "save_config") as sc, \
             mock.patch.object(self.svc_mod._paths, "load_config") as lc:
            mock.patch.object(
                self.svc_mod.LlmRegistry,
                "switch_by_index",
                return_value=(3, "gamma_oai_config"),
            ).start()
            self.addCleanup(mock.patch.stopall)
            service.switch_llm(3)
            self.assertLessEqual(
                lc.call_count, 1,
                f"save should load_config at most once, got {lc.call_count}",
            )

        sc.assert_called_once()

        # After save populated the cache, a restore must NOT touch load_config
        # at all — this is the whole point of the cache (submit hot-path).
        with mock.patch.object(self.svc_mod._paths, "load_config") as lc2:
            mock.patch.object(
                self.svc_mod.LlmRegistry, "resolve", return_value=3
            ).start()
            self.addCleanup(mock.patch.stopall)
            service._restore_preferred_llm()
        self.assertEqual(
            lc2.call_count, 0,
            "restore after save must reuse the cache, not read disk",
        )


    # ── behavioural equivalence ──────────────────────────────────
    def test_restore_applies_next_llm_when_current_diverges(self):
        # Cache is populated once; a later restore after a transient select
        # (which changes llm_no) must re-apply the cached preferred value.
        agent = _StubAgent(llm_no=2, n_clients=3)
        service = _make_service(self.svc_mod, agent)

        with mock.patch.object(
            self.svc_mod._paths, "load_config",
            return_value={"preferred_llm_key": "gamma_oai_config"},
        ) as lc:
            mock.patch.object(
                self.svc_mod.LlmRegistry, "resolve", return_value=2
            ).start()
            self.addCleanup(mock.patch.stopall)
            service._restore_preferred_llm()
        # transient selection drifts llm_no away from preferred
        agent.llm_no = 1
        # second restore — must re-apply preferred=2 WITHOUT re-reading disk
        with mock.patch.object(self.svc_mod._paths, "load_config") as lc2:
            service._restore_preferred_llm()
        self.assertEqual(lc2.call_count, 0)
        self.assertEqual(agent.llm_no, 2)
        self.assertIn(2, agent.next_llm_calls)


if __name__ == "__main__":
    unittest.main()
