from __future__ import annotations

import asyncio
import zipfile
from contextlib import contextmanager

import pytest
from fastapi import HTTPException

from server.routes import conversations


class _Info:
    def __init__(self, size: int):
        self.file_size = size


class _Entry:
    def __init__(self, chunks: list[bytes]):
        self._chunks = iter(chunks)
        self.closed = False
        self.read_sizes: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.closed = True

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        return next(self._chunks, b"")


class _Archive:
    def __init__(self, declared_size: int, entry: _Entry):
        self.info = _Info(declared_size)
        self.entry = entry
        self.opened = False

    def getinfo(self, name: str):
        if name != "entry.txt":
            raise KeyError(name)
        return self.info

    def open(self, name: str):
        self.opened = True
        return self.entry


def _call(fake: _Archive, monkeypatch):
    @contextmanager
    def fake_zip_file(_path):
        yield fake

    monkeypatch.setattr(conversations.zipfile, "ZipFile", fake_zip_file)
    monkeypatch.setattr(conversations.os.path, "isfile", lambda _path: True)
    monkeypatch.setattr(conversations, "_ZIP_ENTRY_MAX_SIZE", 8)
    monkeypatch.setattr(conversations, "_ZIP_READ_CHUNK_SIZE", 4)
    return asyncio.run(conversations.read_zip_entry("archive.zip", "entry.txt"))


def test_read_zip_entry_reads_small_entry_in_bounded_chunks(monkeypatch):
    entry = _Entry([b"abcd", b"ef", b""])
    response = _call(_Archive(6, entry), monkeypatch)

    assert response.body == b"abcdef"
    assert entry.read_sizes == [4, 4, 4]
    assert entry.closed


def test_read_zip_entry_rejects_declared_oversize_before_open(monkeypatch):
    archive = _Archive(9, _Entry([]))

    with pytest.raises(HTTPException) as exc:
        _call(archive, monkeypatch)

    assert exc.value.status_code == 413
    assert not archive.opened


def test_read_zip_entry_stops_when_stream_exceeds_declared_size(monkeypatch):
    entry = _Entry([b"abcd", b"efgh", b"i"])

    with pytest.raises(HTTPException) as exc:
        _call(_Archive(0, entry), monkeypatch)

    assert exc.value.status_code == 413
    assert entry.read_sizes == [4, 4, 4]
    assert entry.closed


def test_read_zip_entry_missing_entry_is_404(tmp_path, monkeypatch):
    archive = tmp_path / "archive.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("other.txt", "other")
    monkeypatch.setattr(conversations, "_archive_dir", lambda: str(tmp_path))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(conversations.read_zip_entry("archive.zip", "missing.txt"))

    assert exc.value.status_code == 404


def test_read_zip_entry_corrupt_zip_is_500(tmp_path, monkeypatch):
    (tmp_path / "archive.zip").write_bytes(b"not a zip")
    monkeypatch.setattr(conversations, "_archive_dir", lambda: str(tmp_path))

    with pytest.raises(HTTPException) as exc:
        asyncio.run(conversations.read_zip_entry("archive.zip", "entry.txt"))

    assert exc.value.status_code == 500
