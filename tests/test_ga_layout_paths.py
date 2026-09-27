"""The GA on-disk layout funnel in ``server/_paths.py``.

These helpers are the single named place for "paths inside the GA checkout Hub
resolves by convention". GA publishes no layout guarantee, so the point of the
funnel is a small, reviewable blast radius — and that every such path is
relative to the configured root (never absolute, never escaping with ``..``).
"""
from __future__ import annotations

from pathlib import Path

import pytest

from server import _paths


def test_helpers_resolve_under_the_configured_root(monkeypatch):
    monkeypatch.setattr(_paths, "GA_ROOT", Path("D:/ga"))
    assert _paths.ga_mykey_path() == Path("D:/ga/mykey.py")
    assert _paths.ga_mykey_sync_script() == Path("D:/ga/assets/mykey_sync.py")
    assert _paths.ga_fsapp_path() == Path("D:/ga/frontends/fsapp.py")
    assert _paths.ga_keychain_path() == Path("D:/ga/memory/keychain.py")
    assert _paths.ga_l4_sessions_dir() == Path("D:/ga/memory/L4_raw_sessions")
    assert _paths.ga_archives_dir() == Path("D:/ga/temp/model_responses")
    assert _paths.memory_dir() == Path("D:/ga/memory")
    assert _paths.conductor_deliverables_dir() == Path("D:/ga/temp")


def test_an_explicit_root_overrides_the_configured_one(monkeypatch):
    monkeypatch.setattr(_paths, "GA_ROOT", Path("D:/ga"))
    assert _paths.ga_keychain_path(Path("E:/other")) == Path(
        "E:/other/memory/keychain.py"
    )
    assert _paths.ga_l4_sessions_dir(Path("E:/other")) == Path(
        "E:/other/memory/L4_raw_sessions"
    )
    assert _paths.ga_layout_path("temp", root=Path("E:/other")) == Path("E:/other/temp")


def test_a_missing_root_raises_rather_than_building_a_relative_path(monkeypatch):
    monkeypatch.setattr(_paths, "GA_ROOT", None)
    for helper in (
        _paths.ga_mykey_path,
        _paths.ga_mykey_sync_script,
        _paths.ga_fsapp_path,
        _paths.ga_keychain_path,
        _paths.ga_l4_sessions_dir,
        _paths.ga_archives_dir,
        _paths.memory_dir,
    ):
        with pytest.raises(RuntimeError):
            helper()


def test_conductor_deliverables_falls_back_without_a_checkout(monkeypatch):
    monkeypatch.setattr(_paths, "GA_ROOT", None)
    assert _paths.conductor_deliverables_dir() == _paths.ADMIN_DATA / "deliverables"


def test_layout_constants_are_relative_posix_paths():
    """A stray absolute path or ``..`` here would silently escape the checkout."""
    constants = {
        name: value
        for name, value in vars(_paths).items()
        if name.startswith("GA_") and name.endswith(("_FILE", "_DIR"))
    }
    assert constants, "layout constants vanished — update this test"
    for name, value in constants.items():
        assert isinstance(value, str), name
        assert not value.startswith(("/", "\\")), name
        assert ":" not in value, f"{name} looks like an absolute Windows path"
        assert ".." not in Path(value).parts, f"{name} escapes the GA checkout"
