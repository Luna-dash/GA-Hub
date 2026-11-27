"""Storage usage summary and user-initiated cache cleanup endpoints."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import _paths

router = APIRouter(prefix="/api/storage", tags=["storage"])


class StorageCategoryResp(BaseModel):
    id: str
    label: str
    description: str
    bytes: int
    file_count: int
    cleanable: bool
    caution: bool = False
    path: str


class StorageSummaryResp(BaseModel):
    total_bytes: int
    categories: list[StorageCategoryResp]


class StorageCleanupReq(BaseModel):
    categories: list[str] = Field(default_factory=list)


class StorageCleanupResp(BaseModel):
    reclaimed_bytes: int
    removed_entries: int
    failed_entries: int
    summary: StorageSummaryResp


def _dir_stats(paths: list[Path]) -> tuple[int, int]:
    total_bytes = 0
    total_files = 0
    for root in paths:
        if not root.exists():
            continue
        if root.is_file():
            try:
                total_bytes += root.stat().st_size
                total_files += 1
            except OSError:
                pass
            continue
        for dirpath, _dirnames, filenames in os.walk(root):
            for fname in filenames:
                try:
                    total_bytes += (Path(dirpath) / fname).stat().st_size
                    total_files += 1
                except OSError:
                    pass
    return total_bytes, total_files


def _is_gahub_mei_dir(path: Path) -> bool:
    if not path.is_dir() or not path.name.startswith("_MEI"):
        return False
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        try:
            if path.resolve() == Path(meipass).resolve():
                return False
        except OSError:
            return False
    try:
        names = {entry.name for entry in path.iterdir()}
    except OSError:
        return False
    if "gahub_sidecar_bundle.json" in names or "generic_agent_admin.egg-info" in names:
        return True
    if any(n.startswith("generic_agent_admin-") and n.endswith(".dist-info") for n in names):
        return True
    # Legacy pre-sentinel GA-Hub sidecar bundles carry server/ alongside webui/ or assets/remote_access/.
    if "server" in names and ("webui" in names or (path / "assets" / "remote_access").is_dir()):
        return True
    return False


def _mei_targets() -> list[Path]:
    temp_root = Path(tempfile.gettempdir())
    if not temp_root.is_dir():
        return []
    out: list[Path] = []
    try:
        for entry in temp_root.iterdir():
            if _is_gahub_mei_dir(entry):
                out.append(entry)
    except OSError:
        pass
    return out


def _agy_profiles_root() -> Path:
    return _paths.ADMIN_DATA / "agy-profiles"


def _agy_toolchain_targets() -> list[Path]:
    root = _agy_profiles_root()
    if not root.is_dir():
        return []
    targets: list[Path] = []
    for profile in root.iterdir():
        home = profile / "home"
        if not home.is_dir():
            continue
        for sub in (".rustup", ".cargo", ".npm", "go"):
            candidate = home / sub
            if candidate.exists():
                targets.append(candidate)
    return targets


def _agy_runtime_tmp_targets() -> list[Path]:
    root = _agy_profiles_root()
    if not root.is_dir():
        return []
    targets: list[Path] = []
    for profile in root.iterdir():
        if profile.name == "default-runtime-tmp" and profile.is_dir():
            targets.append(profile)
            continue
        rt = profile / "runtime-tmp"
        if rt.is_dir():
            targets.append(rt)
    return targets


def _agy_gemini_history_targets() -> list[Path]:
    root = _agy_profiles_root()
    if not root.is_dir():
        return []
    targets: list[Path] = []
    for profile in root.iterdir():
        cli_dir = profile / "home" / ".gemini" / "antigravity-cli"
        if not cli_dir.is_dir():
            continue
        for sub in ("conversations", "brain", "log", "crashes"):
            candidate = cli_dir / sub
            if candidate.is_dir():
                targets.append(candidate)
    return targets


def _webview_cache_dir() -> Path | None:
    if os.name != "nt":
        return None
    local_app = os.environ.get("LOCALAPPDATA")
    if not local_app:
        return None
    candidate = Path(local_app) / "io.genericagent.hub" / "EBWebView" / "Default" / "Cache"
    return candidate if candidate.exists() else None


def _build_categories() -> list[tuple[StorageCategoryResp, list[Path]]]:
    admin = _paths.ADMIN_DATA
    mei_paths = _mei_targets()
    toolchain_paths = _agy_toolchain_targets()
    runtime_tmp_paths = _agy_runtime_tmp_targets()
    gemini_paths = _agy_gemini_history_targets()
    uploads_paths = [admin / "uploads"] if (admin / "uploads").is_dir() else []
    logs_paths = [admin / "logs"] if (admin / "logs").is_dir() else []
    webview_path = _webview_cache_dir()

    specs: list[tuple[str, str, str, list[Path], bool, bool, str]] = [
        (
            "mei_temp",
            "历史解包临时目录 (_MEI*)",
            "旧版单文件 Sidecar 遗留在系统临时目录的解包残留，清理完全安全。",
            mei_paths,
            True,
            False,
            tempfile.gettempdir(),
        ),
        (
            "agy_toolchain_cache",
            "Agy 隔离目录重复工具链缓存",
            "Agy profile 目录内重复下载的 .rustup / .cargo / .npm 等开发工具缓存（现已透传宿主机缓存，旧副本可安全清理）。",
            toolchain_paths,
            True,
            False,
            str(_agy_profiles_root()),
        ),
        (
            "agy_runtime_tmp",
            "Agy 临时运行暂存目录",
            "历史任务上传与运行期的临时暂存文件（跳过当前正在占用的目录）。",
            runtime_tmp_paths,
            True,
            False,
            str(_agy_profiles_root()),
        ),
        (
            "logs",
            "运行日志",
            "后端与子进程历史滚动日志文件。",
            logs_paths,
            True,
            False,
            str(admin / "logs"),
        ),
        (
            "uploads",
            "历史上传附件",
            "通过聊天粘贴或拖拽上传的本地附件副本；清理后旧对话中的附件预览将不可见。",
            uploads_paths,
            True,
            True,
            str(admin / "uploads"),
        ),
        (
            "agy_gemini_history",
            "Agy 历史对话与制品 (.gemini)",
            "保存在 agy-profiles 下的 Agy 历史会话与步骤输出记录；仅在确认不再需要旧上下文时手动清理。",
            gemini_paths,
            True,
            True,
            str(_agy_profiles_root()),
        ),
    ]
    if webview_path is not None:
        specs.append((
            "webview_cache",
            "WebView2 浏览器磁盘缓存",
            "Edge WebView2 运行期持有的 HTTP 缓存；退出应用后可释放，此处仅供体积参考。",
            [webview_path],
            False,
            False,
            str(webview_path),
        ))

    out: list[tuple[StorageCategoryResp, list[Path]]] = []
    for cid, label, desc, paths, cleanable, caution, display_path in specs:
        size_bytes, file_count = _dir_stats(paths)
        out.append((
            StorageCategoryResp(
                id=cid,
                label=label,
                description=desc,
                bytes=size_bytes,
                file_count=file_count,
                cleanable=cleanable,
                caution=caution,
                path=display_path,
            ),
            paths,
        ))
    return out


def _collect_summary() -> StorageSummaryResp:
    built = _build_categories()
    cats = [item for item, _ in built]
    return StorageSummaryResp(
        total_bytes=sum(c.bytes for c in cats),
        categories=cats,
    )


def _remove_path_contents(path: Path, *, remove_self: bool) -> tuple[int, int, int]:
    reclaimed = 0
    removed = 0
    failed = 0
    if not path.exists():
        return 0, 0, 0
    if remove_self:
        size_before, _ = _dir_stats([path])
        try:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
            return size_before, 1, 0
        except OSError:
            return 0, 0, 1
    for child in list(path.iterdir()):
        size_before, _ = _dir_stats([child])
        try:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
            reclaimed += size_before
            removed += 1
        except OSError:
            failed += 1
    return reclaimed, removed, failed


def _run_cleanup(requested: list[str]) -> StorageCleanupResp:
    wanted = set(requested)
    reclaimed = 0
    removed = 0
    failed = 0
    for item, paths in _build_categories():
        if item.id not in wanted or not item.cleanable:
            continue
        remove_self = item.id in ("mei_temp", "agy_toolchain_cache")
        for target in paths:
            r_bytes, r_ok, r_err = _remove_path_contents(target, remove_self=remove_self)
            reclaimed += r_bytes
            removed += r_ok
            failed += r_err
    return StorageCleanupResp(
        reclaimed_bytes=reclaimed,
        removed_entries=removed,
        failed_entries=failed,
        summary=_collect_summary(),
    )


@router.get("/summary", response_model=StorageSummaryResp)
async def storage_summary() -> StorageSummaryResp:
    return await asyncio.to_thread(_collect_summary)


@router.post("/cleanup", response_model=StorageCleanupResp)
async def storage_cleanup(req: StorageCleanupReq) -> StorageCleanupResp:
    return await asyncio.to_thread(_run_cleanup, req.categories)
