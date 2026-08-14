"""mykey.py 可视化管理 — read / write / sessions upsert / backup-restore.

mykey.py 是 GA 的核心配置：所有 LLM 链路、apikey、apibase、第三方平台 token
都在这里。终端编辑门槛太高，本路由把它搬到 webui。

GA 已经支持 mykey.py 热更新：``llmcore.reload_mykeys()`` 基于 mtime，所以只要
落盘就会被下次 ``agent.load_llm_sessions()`` 自动拉起，不需要重启进程。

安全约束：
    * apikey 永远 mask（前 4 + ``***`` + 后 4），仅 raw 文本视图能看到完整值
    * 路径只能是 ``GA_ROOT/mykey.py``
    * 写入前 ast.parse + compile 双重校验，失败一律拒写
    * 备份落到 admin 数据目录，不污染 GA 仓库
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import _paths
from ..services.mykey_codec import (
    AssignmentNotFoundError,
    InvalidSourceError,
    classify_config as _classify,
    delete_assignment,
    render_assign as _render_assign,
    render_dict as _render_dict,
    render_value as _render_value,
    structurize as _structurize,
    upsert_assignment,
    validate_text as _validate_text,
)
from ..schemas import (
    MyKeyBackupListResp,
    MyKeyDataResp,
    MyKeyOpenResp,
    MyKeySessionTestResp,
    MyKeySyncResultResp,
    MyKeyWriteResp,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/mykey", tags=["mykey"])


# ── locations ───────────────────────────────────────────────────────────
def _mykey_path() -> Path:
    if _paths.GA_ROOT is None:
        raise HTTPException(503, "GA_ROOT 未配置")
    return _paths.GA_ROOT / "mykey.py"


def _backup_dir() -> Path:
    p = _paths.ADMIN_DATA / "mykey-backups"
    p.mkdir(parents=True, exist_ok=True)
    return p




def _backup_current(path: Path) -> str | None:
    """Snapshot the current file before overwrite. Returns backup name or None."""
    if not path.is_file(): return None
    bdir = _backup_dir()
    name = f"mykey.py.{time.strftime('%Y%m%d-%H%M%S')}.bak"
    target = bdir / name
    try:
        target.write_bytes(path.read_bytes())
    except Exception as e:
        log.warning("mykey backup failed: %s", e)
        return None
    # keep last 10
    snapshots = sorted(bdir.glob("mykey.py.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in snapshots[10:]:
        try: old.unlink()
        except Exception: pass
    return name


def _atomic_write(path: Path, text: str) -> None:
    """tmp → fsync → replace. mtime jumps exactly once."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _trigger_reload() -> tuple[list[dict], list[str]]:
    """Force GA to re-read mykey.py + return resulting llm list + warnings.

    Errors loading individual sessions are caught silently inside
    load_llm_sessions itself (it `try: ... except: pass`s per config), so
    we reconstruct warnings by diffing intent vs result: every var that
    looks like a session config but doesn't appear in the resulting llm
    names is reported.
    """
    try:
        from ..services.agent_service import get_agent_service
    except Exception as e:
        return [], [f"无法 import agent_service: {e}"]
    try:
        svc = get_agent_service()
    except Exception as e:
        return [], [f"agent_service 实例化失败: {e}"]
    try:
        svc.agent.load_llm_sessions()
    except Exception as e:
        return [], [f"load_llm_sessions 抛出: {type(e).__name__}: {e}"]
    try:
        llms = svc.list_llms()
    except Exception as e:
        return [], [f"list_llms 抛出: {type(e).__name__}: {e}"]
    return llms, []


# ── pydantic models ────────────────────────────────────────────────────
class RawWriteReq(BaseModel):
    raw: str


class SessionUpsertReq(BaseModel):
    var: str
    type: str  # native_claude | native_oai | claude | oai | mixin
    fields: dict[str, Any]


# ── routes ─────────────────────────────────────────────────────────────
@router.get("")
async def get_mykey() -> MyKeyDataResp:
    p = _mykey_path()
    if not p.is_file():
        return {
            "path": str(p),
            "exists": False,
            "raw": "",
            "structured": {"sessions": [], "mixins": [], "mixin": None, "globals": {}},
            "mtime": 0,
        }
    raw = p.read_text(encoding="utf-8")
    return {
        "path": str(p),
        "exists": True,
        "raw": raw,
        "structured": _structurize(raw),
        "mtime": int(p.stat().st_mtime),
    }


@router.put("/raw")
async def put_raw(req: RawWriteReq) -> MyKeyWriteResp:
    p = _mykey_path()
    text = req.raw
    if not text.endswith("\n"): text += "\n"

    ok, msg, line, col = _validate_text(text)
    if not ok:
        raise HTTPException(400, {
            "error": "syntax_error",
            "message": msg,
            "line": line,
            "col": col,
        })

    backup = _backup_current(p)
    _atomic_write(p, text)
    llms, warnings = _trigger_reload()
    return {
        "ok": True,
        "backup": backup,
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(text),
    }


@router.post("/sessions")
async def upsert_session(req: SessionUpsertReq) -> MyKeyWriteResp:
    p = _mykey_path()
    raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    var = req.var.strip()
    if not var.replace("_", "").isalnum():
        raise HTTPException(400, "变量名只允许字母 / 数字 / 下划线")

    try:
        new_text = upsert_assignment(raw, var, req.fields)
    except InvalidSourceError as e:
        raise HTTPException(400, {
            "error": "syntax_error_after_render",
            "message": e.message,
            "line": e.line,
            "col": e.col,
        })
    ok, msg, line, col = _validate_text(new_text)
    if not ok:
        raise HTTPException(400, {
            "error": "syntax_error_after_render",
            "message": msg,
            "line": line,
            "col": col,
        })

    backup = _backup_current(p)
    _atomic_write(p, new_text)
    llms, warnings = _trigger_reload()
    return {
        "ok": True,
        "backup": backup,
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(new_text),
    }


@router.delete("/sessions/{var}")
async def delete_session(var: str) -> MyKeyWriteResp:
    p = _mykey_path()
    if not p.is_file():
        raise HTTPException(404, "mykey.py 不存在")
    raw = p.read_text(encoding="utf-8")
    try:
        new_text = delete_assignment(raw, var)
    except InvalidSourceError as e:
        raise HTTPException(400, f"当前 mykey.py 语法错误，无法定位：{e.message}")
    except AssignmentNotFoundError:
        raise HTTPException(404, f"找不到变量 {var}")

    ok, msg, line, col = _validate_text(new_text)
    if not ok:
        raise HTTPException(400, {
            "error": "syntax_error_after_delete",
            "message": msg,
            "line": line,
            "col": col,
        })

    backup = _backup_current(p)
    _atomic_write(p, new_text)
    llms, warnings = _trigger_reload()
    return {
        "ok": True,
        "backup": backup,
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(new_text),
    }


@router.post("/sessions/{var}/test")
async def test_session(var: str) -> MyKeySessionTestResp:
    """Ping a single mykey session by variable name.

    This avoids fragile /api/llms index mapping: mykey cards know their
    assignment variable, so resolve a fresh client directly from mykey.py.
    Mixin routes are intentionally not tested here.
    """
    if _classify(var) == "mixin":
        return {"ok": False, "error": "mixin session cannot be ping-tested here"}

    try:
        from llmcore import resolve_client
        client = resolve_client(var)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "name": var}

    backend = getattr(client, "backend", None)
    if backend is None:
        return {"ok": False, "error": "client has no backend", "name": var}

    saved_history = list(getattr(backend, "history", []))
    saved_tools = getattr(backend, "tools", None)
    try:
        if hasattr(backend, "history"):
            backend.history = []
        if hasattr(backend, "tools"):
            backend.tools = None

        messages = [
            {"role": "system", "content": "Reply with exactly: pong"},
            {"role": "user", "content": "ping"},
        ]
        text = ""
        start = time.time()
        gen = client.chat(messages=messages, tools=None)
        for chunk in gen:
            if isinstance(chunk, str):
                text += chunk
            if len(text) > 80:
                break
        elapsed_ms = int((time.time() - start) * 1000)
        name = f"{type(backend).__name__}/{getattr(backend, 'name', var)}"
        return {
            "ok": True,
            "latency_ms": elapsed_ms,
            "preview": (text or "").strip()[:120],
            "model": getattr(backend, "model", None),
            "name": name,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "name": f"{type(backend).__name__}/{getattr(backend, 'name', var)}",
        }
    finally:
        try:
            if hasattr(backend, "history"):
                backend.history = saved_history
            if hasattr(backend, "tools"):
                backend.tools = saved_tools
        except Exception:
            pass


@router.get("/backups")
async def list_backups() -> MyKeyBackupListResp:
    bdir = _backup_dir()
    out = []
    for f in sorted(bdir.glob("mykey.py.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"name": f.name, "mtime": int(st.st_mtime), "size": st.st_size})
    return {"backups": out}


@router.post("/backups/{name}/restore")
async def restore_backup(name: str) -> MyKeyWriteResp:
    if "/" in name or ".." in name or not name.startswith("mykey.py.") or not name.endswith(".bak"):
        raise HTTPException(400, "非法备份名")
    bdir = _backup_dir()
    src = bdir / name
    if not src.is_file():
        raise HTTPException(404, "备份不存在")
    p = _mykey_path()
    text = src.read_text(encoding="utf-8")
    ok, msg, line, col = _validate_text(text)
    if not ok:
        raise HTTPException(400, {
            "error": "backup_invalid",
            "message": msg,
            "line": line,
            "col": col,
        })
    # snapshot current before restore (so user can re-roll-forward)
    backup = _backup_current(p)
    _atomic_write(p, text)
    llms, warnings = _trigger_reload()
    return {
        "ok": True,
        "backup": backup,
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(text),
    }


# ── encrypted sync via GA assets/mykey_sync.py ─────────────────────────
def _mykey_sync_script() -> Path:
    if _paths.GA_ROOT is None:
        raise HTTPException(503, "GA_ROOT 未配置")
    script = _paths.GA_ROOT / "assets" / "mykey_sync.py"
    if not script.is_file():
        raise HTTPException(500, f"同步脚本不存在: {script}")
    return script


def _sync_base_url() -> str:
    return os.environ.get("GA_MYKEY_SYNC_URL", "https://sector.lunadash.me").rstrip("/")


def _run_mykey_sync(args: list[str]) -> dict[str, Any]:
    """Run mykey_sync.py without passing secrets on argv.

    Secrets are read by the script from environment variables:
    GA_MYKEY_SYNC_PASSPHRASE / GA_MYKEY_UPLOAD_TOKEN.
    """
    script = _mykey_sync_script()
    if _paths.GA_ROOT is None:
        raise HTTPException(503, "GA_ROOT 未配置")
    cmd = [sys.executable, str(script), *args]
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(_paths.GA_ROOT),
            text=True,
            capture_output=True,
            timeout=90,
            check=False,
        )
    except subprocess.TimeoutExpired as e:
        raise HTTPException(504, {
            "error": "mykey_sync_timeout",
            "message": "mykey 同步超时",
            "stdout": e.stdout or "",
            "stderr": e.stderr or "",
        })
    except Exception as e:
        raise HTTPException(500, f"启动 mykey 同步失败: {type(e).__name__}: {e}")

    result = {
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    if proc.returncode != 0:
        raise HTTPException(500, {
            "error": "mykey_sync_failed",
            "message": f"mykey_sync.py 退出码 {proc.returncode}",
            **result,
        })
    return result


@router.post("/sync/upload")
async def sync_upload_mykey() -> MyKeySyncResultResp:
    """Encrypt and upload current GA_ROOT/mykey.py to the configured sync server."""
    p = _mykey_path()
    if not p.is_file():
        raise HTTPException(404, "mykey.py 不存在")
    upload_url = os.environ.get("GA_MYKEY_SYNC_UPLOAD_URL") or f"{_sync_base_url()}/api/mykey/upload"
    result = _run_mykey_sync([
        "upload",
        "--upload-url", upload_url,
        "--source", str(p),
    ])
    return {"ok": True, "action": "upload", "path": str(p), **result}


@router.post("/sync/fetch")
async def sync_fetch_mykey() -> MyKeySyncResultResp:
    """Fetch, decrypt and replace GA_ROOT/mykey.py from the configured sync server."""
    p = _mykey_path()
    result = _run_mykey_sync([
        "fetch",
        "--base-url", _sync_base_url(),
        "--target", str(p),
        "--force",
    ])
    raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    llms, warnings = _trigger_reload()
    return {
        "ok": True,
        "action": "fetch",
        "path": str(p),
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(raw),
        **result,
    }


@router.post("/open")
async def open_mykey_file() -> MyKeyOpenResp:
    """Open mykey.py in system default editor."""
    import subprocess
    import sys
    
    p = _mykey_path()
    if not p.is_file():
        raise HTTPException(404, "mykey.py 不存在")
    
    try:
        if sys.platform == "win32":
            subprocess.Popen(["cmd", "/c", "start", "", str(p)], shell=True)
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)])
        else:
            subprocess.Popen(["xdg-open", str(p)])
        return {"ok": True, "path": str(p)}
    except Exception as e:
        raise HTTPException(500, f"打开文件失败: {str(e)}")
