"""Authorize selected indexed files and grant only the per-run copy directory."""
from __future__ import annotations

import os
from pathlib import Path
import shutil
from contextlib import closing
from stat import S_ISREG

from .. import _paths
from .file_transfer import FileTransfer

MAX_EXTERNAL_BYTES = 32 * 1024 * 1024


class ReferenceError(ValueError):
    pass


def staged_path(directory: Path, index: int, source: str) -> Path:
    return directory / f"{index:02d}-{Path(source).name}"


def _safe_file_name(raw_name: str, fallback: str) -> str:
    leaf = Path(raw_name.replace("\\", "/")).name
    if not leaf or leaf in {".", ".."}:
        return fallback
    return leaf


def _validate_local_source(raw: str, *, require_unredirected: bool = True) -> Path:
    if not raw or raw.startswith(("//", chr(92) * 2)) or any(char in raw for char in (chr(0), chr(10), chr(13))):
        raise ReferenceError("只能引用本地文件")
    source = Path(raw)
    if not source.is_absolute():
        raise ReferenceError("只能引用本地文件")
    if require_unredirected:
        if source.resolve(strict=True) != source or not S_ISREG(source.stat().st_mode):
            raise ReferenceError("所选文件已变更或不再是普通文件，请重新选择")
    else:
        if source.is_symlink() or not S_ISREG(source.stat().st_mode):
            raise ReferenceError("所选文件已变更或不再是普通文件，请重新选择")
    return source


def _stage_external_file(
    source: Path,
    target: Path,
    remaining: int,
    *,
    require_unredirected: bool = True,
) -> int:
    with source.open("rb") as incoming:
        stat = os.fstat(incoming.fileno())
        if not S_ISREG(stat.st_mode) or not os.path.samestat(stat, source.stat()):
            raise ReferenceError("所选文件在读取时发生变更，请重新选择")
        if require_unredirected and source.resolve(strict=True) != source:
            raise ReferenceError("所选文件在读取时发生变更，请重新选择")
        if stat.st_size > remaining:
            raise ReferenceError("项目外引用文件合计不能超过 32 MiB")
        with target.open("xb") as outgoing:
            while block := incoming.read(1024 * 1024):
                remaining -= len(block)
                if remaining < 0:
                    raise ReferenceError("项目外引用文件合计不能超过 32 MiB")
                outgoing.write(block)
    return remaining


def _ensure_staging_dir(directory: Path, created: bool) -> bool:
    if created:
        return True
    directory.parent.mkdir(parents=True, exist_ok=True)
    if directory.parent.resolve(strict=True) != directory.parent:
        raise ReferenceError("附件暂存目录不能指向其他位置")
    directory.mkdir(mode=0o700)
    return True


def prepare_references(references: list[tuple[int, str]], workspace: Path,
                       directory: Path) -> tuple[list[Path], list[Path]]:
    paths, dirs, _ = prepare_inputs(references, [], workspace, directory)
    return paths, dirs


def prepare_inputs(
    references: list[tuple[int, str]],
    attachments: list[dict],
    workspace: Path,
    directory: Path,
) -> tuple[list[Path], list[Path], list[dict]]:
    if len(references) > 8:
        raise ReferenceError("每条消息最多引用 8 个文件")
    if len(attachments) > 256:
        raise ReferenceError("一次最多添加256个附件")
    created = False
    paths: list[Path] = []
    staged_attachments: list[dict] = []
    seen: set[Path] = set()
    staged_by_source: dict[Path, Path] = {}
    remaining = MAX_EXTERNAL_BYTES
    try:
        if references:
            with closing(FileTransfer().connect()) as db:
                marks = ",".join("?" for _ in references)
                rows = dict(db.execute(f"SELECT id,path FROM manual_files WHERE id IN ({marks})",
                                       [file_id for file_id, _ in references]))
            for index, (file_id, raw) in enumerate(references, 1):
                if rows.get(file_id) != raw:
                    raise ReferenceError("所选文件已从文件传输列表变更，请重新选择")
                source = _validate_local_source(raw, require_unredirected=True)
                if source.is_relative_to(workspace):
                    if source not in seen:
                        paths.append(source)
                        seen.add(source)
                        staged_by_source[source] = source
                    continue
                created = _ensure_staging_dir(directory, created)
                target = staged_path(directory, index, raw)
                remaining = _stage_external_file(source, target, remaining, require_unredirected=True)
                paths.append(target)
                seen.add(source)
                staged_by_source[source] = target

        uploads_root = _paths.admin_uploads_dir().resolve() if attachments else None
        for index, attachment in enumerate(attachments, 1):
            raw = str(attachment.get("path") or "")
            kind = attachment.get("source") or "managed_upload"
            if kind == "managed_upload":
                source = _validate_local_source(raw, require_unredirected=False)
                resolved = source.resolve(strict=True)
                if uploads_root is None or not resolved.is_relative_to(uploads_root):
                    raise ReferenceError("上传附件路径无效，请重新上传")
            else:
                source = _validate_local_source(raw, require_unredirected=True)
            if source in seen:
                mapped = staged_by_source.get(source, source)
                staged_attachments.append({**attachment, "path": str(mapped)})
                continue
            if kind != "managed_upload" and source.is_relative_to(workspace):
                paths.append(source)
                seen.add(source)
                staged_by_source[source] = source
                staged_attachments.append({**attachment, "path": str(source)})
                continue
            created = _ensure_staging_dir(directory, created)
            fallback = f"attachment-{index}"
            leaf = _safe_file_name(str(attachment.get("name") or "") or source.name, fallback)
            target = directory / f"att-{index:02d}-{leaf}"
            if target.exists():
                target = directory / f"att-{index:02d}-{Path(source.name).stem}-{index}{source.suffix}"
            remaining = _stage_external_file(
                source, target, remaining, require_unredirected=(kind != "managed_upload")
            )
            paths.append(target)
            seen.add(source)
            staged_by_source[source] = target
            staged_attachments.append({**attachment, "path": str(target)})

        return paths, ([directory] if created else []), staged_attachments
    except (OSError, RuntimeError, ValueError) as exc:
        if created:
            shutil.rmtree(directory, ignore_errors=True)
        if isinstance(exc, ReferenceError):
            raise
        raise ReferenceError("无法读取所选文件，请检查文件是否存在并重新选择") from exc
