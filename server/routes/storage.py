"""Storage usage summary, tiered Agy archive GC, and cache cleanup endpoints."""
from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import _paths
from ..services import agy_storage_gc

router = APIRouter(prefix="/api/storage", tags=["storage"])

_AGY_TIER_CATEGORY_MAP: dict[str, str] = {
    "agy_gc_l0": "l0",
    "agy_gc_l1": "l1",
    "agy_gc_l2": "l2",
    "agy_gc_l3": "l3",
}


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


class AgyGcPolicyModel(BaseModel):
    auto_enabled: bool = True
    interval_hours: int = Field(default=24, ge=1, le=168)
    l0_orphans_enabled: bool = True
    l0_log_retention_days: int = Field(default=7, ge=1, le=365)
    l1_redundant_enabled: bool = True
    l1_grace_hours: int = Field(default=6, ge=0, le=720)
    l1_steps_retention_days: int = Field(default=3, ge=0, le=365)
    l1_steps_max_file_mb: int = Field(default=5, ge=1, le=1024)
    l1_scratch_retention_days: int = Field(default=7, ge=0, le=365)
    l2_subagents_enabled: bool = True
    l2_killed_grace_hours: int = Field(default=24, ge=0, le=720)
    l2_idle_retention_days: int = Field(default=7, ge=1, le=365)
    l2_keep_artifacts: bool = True
    l3_cold_roots_enabled: bool = False
    l3_cold_root_days: int = Field(default=30, ge=7, le=3650)
    l3_run_events_retention_days: int = Field(default=30, ge=7, le=3650)


class AgyGcPolicyPatchReq(BaseModel):
    auto_enabled: bool | None = None
    interval_hours: int | None = Field(default=None, ge=1, le=168)
    l0_orphans_enabled: bool | None = None
    l0_log_retention_days: int | None = Field(default=None, ge=1, le=365)
    l1_redundant_enabled: bool | None = None
    l1_grace_hours: int | None = Field(default=None, ge=0, le=720)
    l1_steps_retention_days: int | None = Field(default=None, ge=0, le=365)
    l1_steps_max_file_mb: int | None = Field(default=None, ge=1, le=1024)
    l1_scratch_retention_days: int | None = Field(default=None, ge=0, le=365)
    l2_subagents_enabled: bool | None = None
    l2_killed_grace_hours: int | None = Field(default=None, ge=0, le=720)
    l2_idle_retention_days: int | None = Field(default=None, ge=1, le=365)
    l2_keep_artifacts: bool | None = None
    l3_cold_roots_enabled: bool | None = None
    l3_cold_root_days: int | None = Field(default=None, ge=7, le=3650)
    l3_run_events_retention_days: int | None = Field(default=None, ge=7, le=3650)


class AgyGcPolicyStatusResp(BaseModel):
    policy: AgyGcPolicyModel
    last_run_at: str | None = None
    last_reclaimed_bytes: int = 0
    last_removed_entries: int = 0
    last_error: str | None = None
    pending_delete_count: int = 0


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
    uploads_paths = [admin / "uploads"] if (admin / "uploads").is_dir() else []
    logs_paths = [admin / "logs"] if (admin / "logs").is_dir() else []
    webview_path = _webview_cache_dir()

    agy_scan = agy_storage_gc.scan_storage()
    agy_cli_path = str(agy_scan.cli_dir)
    policy = agy_scan.policy

    path_specs: list[tuple[str, str, str, list[Path], bool, bool, str]] = [
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
    ]

    out: list[tuple[StorageCategoryResp, list[Path]]] = []
    for cid, label, desc, paths, cleanable, caution, display_path in path_specs:
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

    # Tiered Agy archive categories (L0 / L1 / L2 / L3 + Protected Core)
    out.append((
        StorageCategoryResp(
            id="agy_gc_l0",
            label="L0 · Agy 孤儿存档与过期日志",
            description=(
                f"已从 GA-Hub 删除会话的残留底层对话树（{agy_scan.l0.item_count} 条）、"
                f"超过 {policy['l0_log_retention_days']} 天的 Agy CLI 日志与崩溃转储；清理零副作用。"
            ),
            bytes=agy_scan.l0.bytes,
            file_count=agy_scan.l0.file_count,
            cleanable=True,
            caution=False,
            path=agy_cli_path,
        ),
        [],
    ))
    out.append((
        StorageCategoryResp(
            id="agy_gc_l1",
            label="L1 · Agy 活跃会话冗余副本",
            description=(
                f"空闲主会话中的重复日志副本（tasks/、logs/chunks/、transcript_full.jsonl）、"
                f"超期或超 {policy['l1_steps_max_file_mb']}MB 的步骤输出及超过 {policy['l1_scratch_retention_days']} 天的 scratch 临时文件；"
                "保留完整主库、精简 transcript 与制品，不影响续聊。"
            ),
            bytes=agy_scan.l1.bytes,
            file_count=agy_scan.l1.file_count,
            cleanable=True,
            caution=False,
            path=agy_cli_path,
        ),
        [],
    ))
    out.append((
        StorageCategoryResp(
            id="agy_gc_l2",
            label="L2 · Agy 已结束子会话 (Subagent)",
            description=(
                f"已终止超过 {policy['l2_killed_grace_hours']}h 或已完结超过 {policy['l2_idle_retention_days']} 天的 "
                f"{agy_scan.l2.item_count} 条子 Agent 存档；其汇报结果与主会话上下文均已保留。"
            ),
            bytes=agy_scan.l2.bytes,
            file_count=agy_scan.l2.file_count,
            cleanable=True,
            caution=False,
            path=agy_cli_path,
        ),
        [],
    ))
    out.append((
        StorageCategoryResp(
            id="agy_gc_l3",
            label="L3 · Agy 冷门主会话降级与库压缩",
            description=(
                f"超过 {policy['l3_cold_root_days']} 天未活跃的 {agy_scan.l3.item_count} 条主会话底层状态库"
                f"（保留 GA-Hub 聊天记录与顶层制品，下次续聊自动用前文摘要续接），并裁剪超 {policy['l3_run_events_retention_days']} 天的旧流式事件与压缩 SQLite。"
            ),
            bytes=agy_scan.l3.bytes,
            file_count=agy_scan.l3.file_count,
            cleanable=True,
            caution=True,
            path=agy_cli_path,
        ),
        [],
    ))
    out.append((
        StorageCategoryResp(
            id="agy_active_core",
            label="Agy 活跃主会话核心（受保护）",
            description=(
                f"当前 {agy_scan.active_root_count} 条活跃主会话的可恢复上下文库、用户制品与保护期内 "
                f"{agy_scan.protected_child_count} 条子会话；自动清理绝不会删除此部分主要信息。"
            ),
            bytes=agy_scan.active_core_bytes,
            file_count=agy_scan.active_core_files,
            cleanable=False,
            caution=False,
            path=agy_cli_path,
        ),
        [],
    ))

    uploads_bytes, uploads_files = _dir_stats(uploads_paths)
    out.append((
        StorageCategoryResp(
            id="uploads",
            label="历史上传附件",
            description="通过聊天粘贴或拖拽上传的本地附件副本；清理后旧对话中的附件预览将不可见。",
            bytes=uploads_bytes,
            file_count=uploads_files,
            cleanable=True,
            caution=True,
            path=str(admin / "uploads"),
        ),
        uploads_paths,
    ))

    if webview_path is not None:
        wb_bytes, wb_files = _dir_stats([webview_path])
        out.append((
            StorageCategoryResp(
                id="webview_cache",
                label="WebView2 浏览器磁盘缓存",
                description="Edge WebView2 运行期持有的 HTTP 缓存；退出应用后可释放，此处仅供体积参考。",
                bytes=wb_bytes,
                file_count=wb_files,
                cleanable=False,
                caution=False,
                path=str(webview_path),
            ),
            [webview_path],
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

    agy_tiers: list[str] = []
    for cat_id, tier_name in _AGY_TIER_CATEGORY_MAP.items():
        if cat_id in wanted:
            agy_tiers.append(tier_name)
    if "agy_gemini_history" in wanted:
        # Backward-compatible alias for callers requesting full Agy tiered cleanup.
        agy_tiers = ["l0", "l1", "l2", "l3"]
    if agy_tiers:
        res = agy_storage_gc.run_cleanup(agy_tiers)
        reclaimed += int(res.get("reclaimed_bytes", 0))
        removed += int(res.get("removed_entries", 0))
        failed += int(res.get("failed_entries", 0))

    for item, paths in _build_categories():
        if item.id not in wanted or not item.cleanable or item.id in _AGY_TIER_CATEGORY_MAP:
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


@router.get("/agy-gc-policy", response_model=AgyGcPolicyStatusResp)
async def get_agy_gc_policy() -> AgyGcPolicyStatusResp:
    return await asyncio.to_thread(agy_storage_gc.get_policy_status)


@router.patch("/agy-gc-policy", response_model=AgyGcPolicyStatusResp)
async def update_agy_gc_policy(req: AgyGcPolicyPatchReq) -> AgyGcPolicyStatusResp:
    patch = req.model_dump(exclude_unset=True)
    await asyncio.to_thread(agy_storage_gc.save_policy, patch)
    return await asyncio.to_thread(agy_storage_gc.get_policy_status)
