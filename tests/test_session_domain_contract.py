"""The session domain is app-owned state with exactly one owner.

Why this file exists: `routes/sessions.py` used to hold the metadata store, the
run coordinator, the scheduled-chat service and the system channels as module
globals, and sibling routes reached in through function-local imports of that
module (``from .sessions import _get_coordinator``). That made a route module
the de-facto owner of process-wide state: two owners appeared whenever another
route built its own copy, and every test had to monkeypatch route globals.

The domain now lives on ``app.state.session_lifecycle``: built once by the
composition root (`server.main.create_app`), resolved by routes through
``Depends``. These tests pin that contract instead of rediscovering it.
"""
from __future__ import annotations

import ast
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
ROUTES = sorted((ROOT / "server" / "routes").glob("*.py"))

# Objects whose construction belongs to the composition root alone.
_SINGLETONS = (
    "SessionCoordinator",
    "SessionRuntimeFactory",
    "ScheduledChatService",
    "SystemChannels",
)

# Module attributes that were the old anti-pattern. `_session_coordinator` and
# friends do not match: the name must start with the bare field.
_DOMAIN_GLOBAL = re.compile(
    r"^_(?:store|coordinator|coordinator_stopping|scheduled_chats|system_channels)\b",
    re.M,
)


def _constructed_names(path: Path):
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Call):
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name:
                yield node.lineno, name


def test_routes_never_construct_session_domain_singletons() -> None:
    offenders = [
        f"{path.relative_to(ROOT)}:{line}: {name}("
        for path in ROUTES
        for line, name in _constructed_names(path)
        if name in _SINGLETONS
    ]
    assert offenders == []


def test_routes_do_not_hold_session_domain_globals() -> None:
    offenders = [
        f"{path.relative_to(ROOT)}:{line_no}"
        for path in ROUTES
        for line_no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if _DOMAIN_GLOBAL.match(line)
    ]
    assert offenders == []


def test_composition_root_binds_the_session_domain(tmp_path, monkeypatch) -> None:
    from server import _paths
    from server.main import create_app
    from server.services.session_lifecycle import SessionLifecycle
    from server.services.session_metadata import SessionMetadataStore

    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    app = create_app()
    domain = app.state.session_lifecycle

    assert isinstance(domain, SessionLifecycle)
    assert isinstance(domain.store, SessionMetadataStore)


def test_domain_is_per_app_not_a_module_singleton(tmp_path, monkeypatch) -> None:
    from server import _paths
    from server.main import create_app

    monkeypatch.setattr(_paths, "GA_ROOT", tmp_path)
    first = create_app()
    second = create_app()

    assert first.state.session_lifecycle is not second.state.session_lifecycle


def test_an_unbound_app_fails_loudly_instead_of_minting_a_domain() -> None:
    """No lazy fallback: a second owner must be a test error, not a real store.

    A default domain would point at the user's real data directory, which is
    exactly the drift this refactor removed.
    """
    from fastapi import FastAPI

    from server.services.session_lifecycle import session_lifecycle_of

    with pytest.raises(RuntimeError, match="session domain is not bound"):
        session_lifecycle_of(FastAPI())


def test_domain_builds_each_producer_once(tmp_path, monkeypatch) -> None:
    """One domain = one coordinator/scheduler/channel set, built on demand."""
    from server.services import session_lifecycle as lifecycle_module
    from server.services.session_lifecycle import SessionLifecycle
    from server.services.session_metadata import SessionMetadataStore

    built: list[str] = []

    class Stub:
        def __init__(self, *_args, **_kwargs) -> None:
            built.append(type(self).__name__)

    class StubCoordinator(Stub):
        pass

    class StubScheduler(Stub):
        pass

    monkeypatch.setattr(lifecycle_module, "SessionCoordinator", StubCoordinator)
    monkeypatch.setattr(lifecycle_module, "ScheduledChatService", StubScheduler)
    domain = SessionLifecycle(store=SessionMetadataStore(tmp_path))

    assert domain.coordinator() is domain.coordinator()
    assert domain.scheduled_chats() is domain.scheduled_chats()
    assert domain.system_channels() is domain.system_channels()
    assert built == ["StubCoordinator", "StubScheduler"]

    # attach_coordinator rebinds the one slot rather than adding a second.
    marker = object()
    domain.attach_coordinator(marker)
    assert domain.peek_coordinator() is marker
