"""config.json read-modify-write sequences must not lose fields.

Two unlocked RMW writers used to be able to clobber each other with their
own stale full-file snapshot (llm preference vs chat retry vs GA root).
`_paths.update_config` serializes them under one process-wide lock.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

import pytest

from server import _paths


def test_concurrent_config_writers_do_not_lose_fields(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(_paths, "CONFIG_FILE", tmp_path / "config.json")
    _paths.reset_config_cache()

    def set_a(cfg: dict) -> None:
        cfg["field_a"] = "A"

    def set_b(cfg: dict) -> None:
        cfg["field_b"] = "B"

    barrier = threading.Barrier(2)

    def worker(fn) -> None:
        barrier.wait()
        for _ in range(50):
            _paths.update_config(fn)

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(worker, fn) for fn in (set_a, set_b)]
        for future in futures:
            future.result(timeout=10)

    cfg = _paths.load_config()
    assert cfg["field_a"] == "A"
    assert cfg["field_b"] == "B"


def test_update_config_persists_and_returns_merged_dict(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(_paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(_paths, "CONFIG_FILE", tmp_path / "config.json")
    _paths.reset_config_cache()

    def mutate(cfg: dict) -> None:
        cfg["ga_root"] = str(tmp_path)

    merged = _paths.update_config(mutate)

    assert merged["ga_root"] == str(tmp_path)
    assert _paths.load_config()["ga_root"] == str(tmp_path)


@pytest.mark.parametrize("winerror", [5, 32, 33])
def test_config_save_recovers_from_transient_windows_replace_refusal(tmp_path, monkeypatch, winerror):
    monkeypatch.setattr(_paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(_paths, "CONFIG_FILE", tmp_path / "config.json")
    _paths.save_config({"value": "old"})
    assert _paths.load_config() == {"value": "old"}
    refusal = PermissionError("temporarily locked")
    refusal.winerror = winerror
    original_replace = Path.replace
    attempts = 0

    def replace(path, target):
        nonlocal attempts
        attempts += 1
        if attempts <= 2:
            assert _paths.load_config() == {"value": "old"}
            raise refusal
        return original_replace(path, target)

    with mock.patch.object(Path, "replace", replace), mock.patch.object(_paths.time, "sleep"):
        _paths.save_config({"value": "new"})
    assert _paths.load_config() == {"value": "new"}
    assert attempts == 3


@pytest.mark.parametrize("winerror, attempts", [(5, 6), (None, 1)])
def test_config_save_preserves_previous_file_and_surfaces_permanent_refusal(tmp_path, monkeypatch, winerror, attempts):
    monkeypatch.setattr(_paths, "ADMIN_DATA", tmp_path)
    monkeypatch.setattr(_paths, "CONFIG_FILE", tmp_path / "config.json")
    _paths.save_config({"value": "old"})
    refusal = PermissionError("permission denied")
    if winerror is not None:
        refusal.winerror = winerror
    with mock.patch.object(Path, "replace", side_effect=refusal) as replace, mock.patch.object(_paths.time, "sleep"):
        with pytest.raises(PermissionError):
            _paths.save_config({"value": "new"})
    assert replace.call_count == attempts
    assert _paths.load_config() == {"value": "old"}
