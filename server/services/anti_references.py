"""Authorize selected indexed files and grant only the per-run copy directory."""
from __future__ import annotations

import os
import shutil
from contextlib import closing
from pathlib import Path
from stat import S_ISREG

from .file_transfer import FileTransfer

MAX_EXTERNAL_BYTES = 32 * 1024 * 1024


class ReferenceError(ValueError):
    pass


def staged_path(directory: Path, index: int, source: str) -> Path:
    return directory / f"{index:02d}-{Path(source).name}"


def prepare_references(references: list[tuple[int, str]], workspace: Path,
                       directory: Path) -> tuple[list[Path], list[Path]]:
    if len(references) > 8:
        raise ReferenceError("每条消息最多引用 8 个文件")
    created = False
    paths = []
    remaining = MAX_EXTERNAL_BYTES
    try:
        with closing(FileTransfer().connect()) as db:
            marks = ",".join("?" for _ in references)
            rows = dict(db.execute(f"SELECT id,path FROM manual_files WHERE id IN ({marks})",
                                   [file_id for file_id, _ in references]))
        for index, (file_id, raw) in enumerate(references, 1):
            if rows.get(file_id) != raw:
                raise ReferenceError("所选文件已从文件传输列表变更，请重新选择")
            source = Path(raw)
            if (not source.is_absolute() or raw.startswith(("//", chr(92) * 2))
                    or any(char in raw for char in (chr(0), chr(10), chr(13)))):
                raise ReferenceError("只能引用本地文件")
            if source.resolve(strict=True) != source or not S_ISREG(source.stat().st_mode):
                raise ReferenceError("所选文件已变更或不再是普通文件，请重新选择")
            if source.is_relative_to(workspace):
                paths.append(source)
                continue
            if not created:
                directory.parent.mkdir(parents=True, exist_ok=True)
                if directory.parent.resolve(strict=True) != directory.parent:
                    raise ReferenceError("附件暂存目录不能指向其他位置")
                directory.mkdir(mode=0o700)
                created = True
            target = staged_path(directory, index, raw)
            with source.open("rb") as incoming:
                stat = os.fstat(incoming.fileno())
                if not S_ISREG(stat.st_mode) or source.resolve(strict=True) != source or not os.path.samestat(stat, source.stat()):
                    raise ReferenceError("所选文件在读取时发生变更，请重新选择")
                if stat.st_size > remaining:
                    raise ReferenceError("项目外引用文件合计不能超过 32 MiB")
                with target.open("xb") as outgoing:
                    while block := incoming.read(1024 * 1024):
                        remaining -= len(block)
                        if remaining < 0:
                            raise ReferenceError("项目外引用文件合计不能超过 32 MiB")
                        outgoing.write(block)
            paths.append(target)
        return paths, [directory] if created else []
    except (OSError, RuntimeError, ValueError) as exc:
        if created:
            shutil.rmtree(directory, ignore_errors=True)
        if isinstance(exc, ReferenceError):
            raise
        raise ReferenceError("无法读取所选文件，请检查文件是否存在并重新选择") from exc
