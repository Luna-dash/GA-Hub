"""Shared pytest configuration for the GA-Hub backend tests.

Living here pins the repo root on sys.path before collection, so a bare
``pytest`` (not ``python -m pytest``) resolves the ``server`` package the
same way from any working directory.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


@pytest.fixture
def session_domain(tmp_path):
    """A throwaway session domain (store + coordinator + producers).

    The composition root owns this object in production (server.main binds it
    to ``app.state.session_lifecycle``). Tests that mount a route module on a
    bare app bind this one instead, which is also why they no longer patch
    route module globals.
    """
    from server.services.session_lifecycle import SessionLifecycle
    from server.services.session_metadata import SessionMetadataStore

    return SessionLifecycle(store=SessionMetadataStore(tmp_path))


@pytest.fixture
def bind_session_domain(session_domain):
    """Bind :func:`session_domain` to a test app and hand the domain back."""

    def _bind(app):
        app.state.session_lifecycle = session_domain
        return session_domain

    return _bind

