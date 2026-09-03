"""load_config() mtime cache: fresh semantics without per-call disk reads."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from server import _paths


@pytest.fixture()
def config_file(tmp_path: Path, monkeypatch) -> Path:
    path = tmp_path / "config.json"
    monkeypatch.setattr(_paths, "CONFIG_FILE", path)
    _paths.reset_config_cache()
    yield path
    _paths.reset_config_cache()


def test_missing_file_returns_empty_dict(config_file: Path) -> None:
    assert _paths.load_config() == {}


def test_rewrite_is_visible_immediately(config_file: Path) -> None:
    config_file.write_text(json.dumps({"ga_root": "D:/one"}), encoding="utf-8")
    assert _paths.load_config()["ga_root"] == "D:/one"

    # Windows file timestamps share a ~15ms system-time tick: two rapid writes
    # can carry the same mtime. Explicit utime models the clock moving.
    config_file.write_text(json.dumps({"ga_root": "D:/two"}), encoding="utf-8")
    st = config_file.stat()
    import os

    os.utime(config_file, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    assert _paths.load_config()["ga_root"] == "D:/two"


def test_returned_dict_is_a_copy(config_file: Path) -> None:
    config_file.write_text(json.dumps({"ga_root": "D:/one"}), encoding="utf-8")
    first = _paths.load_config()
    first["ga_root"] = "mutated"

    assert _paths.load_config()["ga_root"] == "D:/one"


def test_unreadable_file_degrades_to_empty(config_file: Path) -> None:
    config_file.write_text("{not json", encoding="utf-8")

    assert _paths.load_config() == {}


def test_save_config_updates_the_cached_view(config_file: Path) -> None:
    _paths.save_config({"ga_root": "D:/one", "preferred_llm_no": 2})

    assert _paths.load_config()["preferred_llm_no"] == 2
