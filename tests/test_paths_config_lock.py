"""config.json read-modify-write sequences must not lose fields.

Two unlocked RMW writers used to be able to clobber each other with their
own stale full-file snapshot (llm preference vs chat retry vs GA root).
`_paths.update_config` serializes them under one process-wide lock.
"""
from __future__ import annotations

import threading

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

    threads = [threading.Thread(target=worker, args=(set_a,)),
               threading.Thread(target=worker, args=(set_b,))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

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
