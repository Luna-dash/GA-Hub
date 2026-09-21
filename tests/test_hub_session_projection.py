"""Tests for the phone-session hub projection (plan §7).

Two layers:

* unit — fold shape, stat-guarded cache, reconciler attach/detach scope
  filters, hook error mapping, module lifecycle: fakes only;
* contract — GA's real ``frontends/hub.py`` loaded under a private module
  name drives the hooks through ``HubClient._build`` / ``_on_cmd``, proving
  the fold output speaks the official protocol (loader pattern: conductor-hub
  chain tests).

A GA checkout is required (the projection cannot exist without the GA-side
archive reader); the whole module skips when GA_ROOT is absent.
"""
from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import server._paths as _paths  # noqa: E402


def _resolve_ga_root() -> Path | None:
    for candidate in (os.environ.get("GA_ROOT"), getattr(_paths, "GA_ROOT", None)):
        if candidate:
            root = Path(candidate)
            if (root / "frontends" / "hub.py").exists():
                return root
    return None


GA_ROOT = _resolve_ga_root()
if GA_ROOT is None:
    pytest.skip(
        "GA checkout not found (set GA_ROOT); projection tests skipped",
        allow_module_level=True,
    )

from server.services import hub_session_projection as proj  # noqa: E402
from server.services.session_coordinator import (  # noqa: E402
    AgentBusyError,
    SessionControlBusyError,
    SessionNotActiveError,
)
from server.services.session_runtime_status import STATUS_IDLE  # noqa: E402


# ── helpers ──────────────────────────────────────────────────────


def _archive(tmp_path: Path, name: str = "a.jsonl", content: str = "x1") -> Path:
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return path


def _items(*pairs: tuple[str, str]) -> list[dict[str, str]]:
    return [{"role": role, "content": content} for role, content in pairs]


class _FakeStore:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def list(self) -> list[dict]:
        return [dict(row) for row in self.rows]


class _FakeClient:
    """HubClient stand-in: records construction kwargs and stop calls."""

    instances: list["_FakeClient"] = []

    def __init__(self, name: str, **kwargs) -> None:
        self.name = name
        self.kwargs = kwargs
        self.started = False
        self.stop_calls = 0
        _FakeClient.instances.append(self)

    def start(self) -> None:
        self.started = True

    def is_alive(self) -> bool:
        return self.started

    def stop(self, timeout: float = 3.0) -> bool:
        self.stop_calls += 1
        self.started = False
        return True


def _noop_reader(archive_path, *, limit=None, **kwargs):
    return {"items": []}


# ── fold shape (same as the approved Phase-0 smoke) ─────────────


def test_fold_matches_phase0_shape():
    tasks = proj.fold_items(_items(
        ("assistant", "lead"),
        ("user", "q1"),
        ("assistant", "a1"),
        ("assistant", "a2"),
        ("user", "q2"),
    ))
    assert tasks == [
        {"input": "", "outputs": ["lead"]},
        {"input": "q1", "outputs": ["a1", "a2"]},
        {"input": "q2", "outputs": []},
    ]


def test_fold_handles_empty_sources():
    assert proj.fold_items([]) == []
    assert proj.fold_items(None) == []
    assert proj.fold_items(_items(("user", "only"))) == [{"input": "only", "outputs": []}]


# ── read path: stat-guarded cache ────────────────────────────────


def test_get_outputs_caches_until_stat_changes(monkeypatch, tmp_path):
    path = _archive(tmp_path)
    calls = {"n": 0}

    def reader(archive_path, *, limit=None, **kwargs):
        calls["n"] += 1
        return {"items": _items(("user", f"q{calls['n']}"), ("assistant", f"a{calls['n']}"))}

    monkeypatch.setattr(proj, "read_archive_messages", reader)
    peer = proj._ProjectedSession("sid-1", str(path))

    first = peer.get_outputs()
    assert calls["n"] == 1
    assert first[-1]["input"] == "q1"
    assert peer.get_outputs() is first  # stat unchanged -> cached object
    assert calls["n"] == 1

    path.write_text("x2-longer", encoding="utf-8")
    second = peer.get_outputs()
    assert calls["n"] == 2
    assert second[-1]["input"] == "q2"


def test_get_outputs_serves_last_window_on_failure(monkeypatch, tmp_path):
    path = _archive(tmp_path)
    monkeypatch.setattr(
        proj, "read_archive_messages", lambda *a, **k: {"items": _items(("user", "q1"))}
    )
    peer = proj._ProjectedSession("sid-1", str(path))
    first = peer.get_outputs()

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(proj, "read_archive_messages", broken)
    path.write_text("x2", encoding="utf-8")
    assert peer.get_outputs() == first  # failure -> last known window

    path.unlink()
    assert peer.get_outputs() == first  # missing file -> last known window


# ── reconciler: scope filters, attach/detach ─────────────────────


def test_reconcile_attaches_filters_and_detaches(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    a = _archive(tmp_path, "a.jsonl")
    b = _archive(tmp_path, "b.jsonl")
    rows = [
        {"id": "aaaaaaaa-0001", "kind": "user", "archive_path": str(a)},
        {"id": "bbbbbbbb-0002", "kind": None, "archive_path": str(b)},
        {"id": "system-scheduled_tasks", "kind": "system", "archive_path": str(b)},
        {"id": "archive-deadbeef", "kind": "user", "archive_path": str(b)},
        {"id": "cccccccc-0003", "kind": "user", "archive_path": None},
        {"id": "dddddddd-0004", "kind": "user", "archive_path": str(tmp_path / "gone.jsonl")},
    ]
    svc = proj.HubSessionProjectionService(store=_FakeStore(rows), client_factory=_FakeClient)

    svc._reconcile()
    assert sorted(c.name for c in _FakeClient.instances) == ["gh-aaaaaaaa", "gh-bbbbbbbb"]
    assert all(c.started for c in _FakeClient.instances)
    assert set(svc._peers) == {"aaaaaaaa-0001", "bbbbbbbb-0002"}
    wired = _FakeClient.instances[0].kwargs
    assert set(wired) == {"put_task", "get_outputs", "abort", "state", "fixed"}
    assert wired["fixed"] is True

    rows.pop(1)  # bbbb disappears from the store
    rows.append({"id": "eeeeeeee-0005", "kind": "user", "archive_path": str(a)})
    svc._reconcile()

    names = [c.name for c in _FakeClient.instances]
    assert names.count("gh-aaaaaaaa") == 1  # still alive -> no re-attach
    assert names.count("gh-eeeeeeee") == 1
    assert next(c for c in _FakeClient.instances if c.name == "gh-bbbbbbbb").stop_calls == 1
    assert set(svc._peers) == {"aaaaaaaa-0001", "eeeeeeee-0005"}


def test_reconcile_reattaches_dead_client(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    rows = [{"id": "aaaaaaaa-0001", "kind": "user", "archive_path": str(_archive(tmp_path))}]
    svc = proj.HubSessionProjectionService(store=_FakeStore(rows), client_factory=_FakeClient)
    svc._reconcile()
    first = svc._peers["aaaaaaaa-0001"].client
    first.started = False  # one-shot client died at runtime

    svc._reconcile()
    second = svc._peers["aaaaaaaa-0001"].client
    assert second is not first
    assert second.started is True
    assert first.stop_calls == 1


def test_reconcile_cap_keeps_newest_rows(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    monkeypatch.setenv("GAHUB_HUB_PROJECTION_MAX", "2")
    rows = [
        {"id": f"sid{i:02d}-aaaa", "kind": "user", "archive_path": str(_archive(tmp_path, f"{i}.jsonl"))}
        for i in range(3)
    ]
    svc = proj.HubSessionProjectionService(store=_FakeStore(rows), client_factory=_FakeClient)
    svc._reconcile()
    assert [c.name for c in _FakeClient.instances] == ["gh-sid00-aa", "gh-sid01-aa"]


def test_reconcile_system_skipped_and_opt_in(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    system_row = {
        "id": "system-scheduled_tasks",
        "kind": "system",
        "archive_path": str(_archive(tmp_path, "s.jsonl")),
    }
    svc = proj.HubSessionProjectionService(store=_FakeStore([system_row]), client_factory=_FakeClient)
    svc._reconcile()
    assert _FakeClient.instances == []

    monkeypatch.setenv("GAHUB_HUB_PROJECTION_INCLUDE_SYSTEM", "1")
    svc._reconcile()
    assert [c.name for c in _FakeClient.instances] == ["gh-system-s"]


def test_reconcile_applies_name_suffix(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    monkeypatch.setenv("GAHUB_HUB_PROJECTION_SUFFIX", "-dev")
    rows = [{"id": "aaaaaaaa-0001", "kind": "user", "archive_path": str(_archive(tmp_path))}]
    svc = proj.HubSessionProjectionService(store=_FakeStore(rows), client_factory=_FakeClient)
    svc._reconcile()
    assert [c.name for c in _FakeClient.instances] == ["gh-aaaaaaaa-dev"]


def test_reconcile_wires_topic_lookup_into_state(monkeypatch, tmp_path):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    a = _archive(tmp_path, "a.jsonl")

    class Store(_FakeStore):
        def title_for_archive(self, archive_path):
            return "ui调整"

    rows = [{"id": "aaaaaaaa-0001", "kind": "user", "archive_path": str(a)}]
    svc = proj.HubSessionProjectionService(store=Store(rows), client_factory=_FakeClient)
    svc._reconcile()

    wired = _FakeClient.instances[0].kwargs
    assert wired["state"]() == {"run": False, "title": "ui调整"}


# ── hook bodies ──────────────────────────────────────────────────


def _peer(get_coordinator=None, peek_coordinator=None):
    return proj._ProjectedSession(
        "sid-1",
        "unused.jsonl",
        get_coordinator=get_coordinator,
        peek_coordinator=peek_coordinator,
    )


def test_put_task_submits_with_hub_source():
    got = []

    class Coord:
        def submit(self, text, **kwargs):
            got.append((text, kwargs))

    assert _peer(get_coordinator=lambda: Coord()).put_task("继续") == {"ok": 1}
    assert got == [("继续", {"session_id": "sid-1", "source": "hub"})]


def test_put_task_error_mapping():
    def raising(exc):
        class Coord:
            def submit(self, text, **kwargs):
                raise exc

        return lambda: Coord()

    busy = _peer(get_coordinator=raising(AgentBusyError("sid-1", "run-1"))).put_task("x")
    assert busy["code"] == "busy" and busy["error"]

    control = _peer(get_coordinator=raising(SessionControlBusyError("sid-1", "submit"))).put_task("x")
    assert control["code"] == "busy"

    down = _peer(get_coordinator=raising(RuntimeError("nope"))).put_task("x")
    assert down["code"] == "nosupport"

    assert _peer().put_task("x")["code"] == "nosupport"  # accessors absent
    assert _peer().put_task("   ") == {"ok": 1}  # blank text is a no-op


def test_put_task_replies_ok_when_admission_is_slow(monkeypatch):
    monkeypatch.setattr(proj, "SUBMIT_JOIN_TIMEOUT", 0.05)
    release = threading.Event()

    class Coord:
        def submit(self, text, **kwargs):
            release.wait(2.0)

    try:
        started = time.monotonic()
        assert _peer(get_coordinator=lambda: Coord()).put_task("slow-boot") == {"ok": 1}
        assert time.monotonic() - started < 1.0  # killed by SUBMIT_JOIN_TIMEOUT, not the 2s wait
    finally:
        release.set()


def test_abort_is_idempotent_and_safe():
    class Coord:
        def __init__(self):
            self.aborted = []

        def abort_if_current(self, **kwargs):
            self.aborted.append(kwargs)

    coord = Coord()
    assert _peer(get_coordinator=lambda: coord).abort() == {"ok": 1}
    assert coord.aborted == [{"session_id": "sid-1"}]

    class NotActive:
        def abort_if_current(self, **kwargs):
            raise SessionNotActiveError("quiet")

    assert _peer(get_coordinator=lambda: NotActive()).abort() == {"ok": 1}

    class Broken:
        def abort_if_current(self, **kwargs):
            raise RuntimeError("down")

    assert _peer(get_coordinator=lambda: Broken()).abort()["code"] == "nosupport"
    assert _peer().abort()["code"] == "nosupport"


def test_state_probe_uses_peek_only():
    assert _peer().state() == {"run": False}
    assert _peer(peek_coordinator=lambda: None).state() == {"run": False}

    class Coord:
        def __init__(self, status):
            self._status = status

        def runtime_state(self, session_id):
            return SimpleNamespace(status=self._status)

    idle = Coord(STATUS_IDLE)
    assert _peer(peek_coordinator=lambda: idle).state() == {"run": False}
    running = Coord("running")
    assert _peer(peek_coordinator=lambda: running).state() == {"run": True}

    def gone():
        raise RuntimeError("stopped")

    assert _peer(peek_coordinator=gone).state() == {"run": False}


def test_state_rides_store_topic_over_official_title():
    titled = proj._ProjectedSession(
        "sid-1", "unused.jsonl", topic_for_archive=lambda path: "ui调整"
    )
    assert titled.state() == {"run": False, "title": "ui调整"}

    blank = proj._ProjectedSession(
        "sid-1", "unused.jsonl", topic_for_archive=lambda path: "   "
    )
    assert blank.state() == {"run": False}  # unset topic keeps the official fallback


def test_state_topic_lookup_never_raises():
    def broken(path):
        raise RuntimeError("store unreadable")

    peer = proj._ProjectedSession("sid-1", "unused.jsonl", topic_for_archive=broken)
    assert peer.state() == {"run": False}


# ── module lifecycle ─────────────────────────────────────────────


def test_module_start_stop_is_idempotent(monkeypatch):
    _FakeClient.instances = []
    monkeypatch.setattr(proj, "SessionMetadataStore", lambda: _FakeStore([]))
    monkeypatch.setattr(proj, "_resolve_hub_client", lambda: _FakeClient)
    try:
        assert proj.start_hub_session_projection() is True
        assert proj.start_hub_session_projection() is True
        assert proj._service is not None
        assert proj.stop_hub_session_projection() is True
        assert proj._service is None
        assert proj.stop_hub_session_projection() is True
    finally:
        proj.stop_hub_session_projection()


def test_module_start_fails_without_hub_client(monkeypatch):
    monkeypatch.setattr(proj, "_resolve_hub_client", lambda: None)
    try:
        assert proj.start_hub_session_projection() is False
        assert proj._service is None
    finally:
        proj.stop_hub_session_projection()


# ── contract: GA's real hub module drives the hooks ─────────────


def _load_real_hub_module():
    spec = importlib.util.spec_from_file_location(
        "_gahub_real_hub_projection", GA_ROOT / "frontends" / "hub.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_real_hub_build_speaks_our_fold(monkeypatch, tmp_path):
    hub = _load_real_hub_module()
    path = _archive(tmp_path)
    monkeypatch.setattr(proj, "read_archive_messages", lambda *a, **k: {"items": _items(
        ("user", "第一问"),
        ("assistant", "第一答"),
        ("user", "第二个问题是什么"),
    )})
    peer = proj._ProjectedSession("sid-abcd1234", str(path))
    client = hub.HubClient(
        "gh-test",
        put_task=peer.put_task,
        get_outputs=peer.get_outputs,
        abort=peer.abort,
        state=peer.state,
        fixed=True,
    )

    row = client._build({"detail": 1})
    assert row["title"] == "第二个问题是什么"
    assert row["nt"] == 2
    assert row["run"] is False
    assert row["tasks"][0]["input"] == "第一问"
    assert row["tasks"][0]["steps"][0]["title"] == "第一答"
    assert row["tasks"][0]["steps"][0]["n"] == 3

    same = client._build({"sig": row["sig"]})
    assert same.get("same") == 1
    assert same["run"] is False


def test_real_hub_build_prefers_topic_over_last_input(monkeypatch, tmp_path):
    hub = _load_real_hub_module()
    path = _archive(tmp_path)
    monkeypatch.setattr(proj, "read_archive_messages", lambda *a, **k: {"items": _items(
        ("user", "第一问"),
        ("assistant", "第一答"),
    )})
    peer = proj._ProjectedSession(
        "sid-abcd1234", str(path), topic_for_archive=lambda p: "ui调整"
    )
    client = hub.HubClient(
        "gh-test",
        put_task=peer.put_task,
        get_outputs=peer.get_outputs,
        abort=peer.abort,
        state=peer.state,
        fixed=True,
    )

    row = client._build({"detail": 1})
    assert row["title"] == "ui调整"  # state() spread wins over the derived title
    assert row["run"] is False

    same = client._build({"sig": row["sig"]})
    assert same.get("same") == 1
    assert same["title"] == "ui调整"  # delta replies carry the topic too


def test_real_hub_roundtrip_put_and_abort(monkeypatch, tmp_path):
    hub = _load_real_hub_module()
    monkeypatch.setattr(proj, "read_archive_messages", _noop_reader)
    calls = []

    class Coord:
        def submit(self, text, **kwargs):
            calls.append(("submit", text, kwargs))

        def abort_if_current(self, **kwargs):
            calls.append(("abort", kwargs))

    coord = Coord()
    peer = proj._ProjectedSession(
        "sid-deadbeef",
        str(tmp_path / "u.jsonl"),
        get_coordinator=lambda: coord,
        peek_coordinator=lambda: None,
    )
    sent = []

    class FakeWS:
        async def send(self, payload):
            sent.append(payload)

    client = hub.HubClient(
        "gh-test",
        put_task=peer.put_task,
        get_outputs=peer.get_outputs,
        abort=peer.abort,
        state=peer.state,
        fixed=True,
    )
    asyncio.run(client._on_cmd(FakeWS(), {"op": "put_task", "text": "继续跑", "id": 7}))
    asyncio.run(client._on_cmd(FakeWS(), {"op": "abort", "id": 8}))

    assert calls[0] == ("submit", "继续跑", {"session_id": "sid-deadbeef", "source": "hub"})
    assert calls[1] == ("abort", {"session_id": "sid-deadbeef"})
    first = json.loads(sent[0])
    assert first == {"op": "r", "id": 7, "name": "gh-test", "data": {"ok": 1}}
    assert json.loads(sent[1])["data"] == {"ok": 1}
