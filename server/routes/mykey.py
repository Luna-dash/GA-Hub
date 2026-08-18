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

import asyncio
import logging
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import _paths
from ..process_utils import hidden_process_kwargs
from ..services.mykey_codec import (
    AssignmentNotFoundError,
    InvalidSourceError,
    classify_config as _classify,
    delete_assignment,
    delete_base_assignment,
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
from ..services.llm_registry import LlmRegistry

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
        llms = svc.list_llms()
    except Exception as e:
        return [], [f"list_llms 抛出: {type(e).__name__}: {e}"]
    return llms, []


def _delete_session_assignment(raw: str, var: str) -> tuple[str, int]:
    """Remove a base LLM or mixin, cleaning stale references for base LLMs."""
    structured = _structurize(raw)
    if any(item["var"] == var for item in structured["sessions"]):
        return delete_base_assignment(raw, var)
    if any(item["var"] == var for item in structured["mixins"]):
        return delete_assignment(raw, var), 0
    raise AssignmentNotFoundError(var)


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

    with LlmRegistry.synchronized():
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
    var = req.var.strip()
    if not var.replace("_", "").isalnum():
        raise HTTPException(400, "变量名只允许字母 / 数字 / 下划线")

    with LlmRegistry.synchronized():
        raw = p.read_text(encoding="utf-8") if p.is_file() else ""
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

    with LlmRegistry.synchronized():
        raw = p.read_text(encoding="utf-8")
        try:
            new_text, removed_references = _delete_session_assignment(raw, var)
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
        "removed_mixin_references": removed_references,
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
    return await asyncio.to_thread(_test_session_sync, var)


def _test_session_sync(var: str) -> MyKeySessionTestResp:
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
    with LlmRegistry.synchronized():
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


_MYKEY_MIN_PYTHON = (3, 11)
_MYKEY_PYTHON_PROBE_TIMEOUT = 4
_MYKEY_PYTHON_PROBE = (
    "import sys\n"
    "try:\n"
    " from cryptography.hazmat.primitives import hashes\n"
    " from cryptography.hazmat.primitives.ciphers.aead import AESGCM\n"
    " from cryptography.hazmat.primitives.kdf.hkdf import HKDF\n"
    "except Exception:\n"
    " cryptography_ok = 0\n"
    "else:\n"
    " cryptography_ok = 1\n"
    "sys.stdout.write('GA_HUB_MYKEY_PYTHON=%d.%d;CRYPTOGRAPHY=%d' % "
    "(sys.version_info[0], sys.version_info[1], cryptography_ok))\n"
)


def _is_packaged_process() -> bool:
    return any((
        bool(getattr(sys, "frozen", False)),
        hasattr(sys, "_MEIPASS"),
        "__compiled__" in globals(),
    ))


def _mykey_python_candidates() -> list[tuple[str, str]]:
    """Use shared discovery, excluding this executable in packaged builds."""
    return _paths.user_python_candidates(
        _paths.GA_ROOT,
        allow_current_process=not _is_packaged_process(),
    )


def _probe_mykey_python(python: str) -> tuple[tuple[int, int], bool] | None:
    """Read the candidate version and verify the sync script's crypto imports."""
    env = os.environ.copy()
    env.pop("GA_MYKEY_SYNC_PASSPHRASE", None)
    env.pop("GA_MYKEY_UPLOAD_TOKEN", None)
    try:
        proc = subprocess.run(
            [python, "-c", _MYKEY_PYTHON_PROBE],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="ascii",
            errors="replace",
            timeout=_MYKEY_PYTHON_PROBE_TIMEOUT,
            check=False,
            **hidden_process_kwargs(),
        )
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    if proc.returncode != 0:
        return None
    match = re.search(
        r"GA_HUB_MYKEY_PYTHON=(\d+)\.(\d+);CRYPTOGRAPHY=([01])",
        proc.stdout or "",
    )
    if not match:
        return None
    try:
        version = int(match.group(1)), int(match.group(2))
    except (TypeError, ValueError):
        return None
    return version, match.group(3) == "1"


def _mykey_python_error(failures: list[dict[str, str]]) -> HTTPException:
    reasons = {failure["reason"] for failure in failures}
    if "missing_cryptography" in reasons and "python_too_old" in reasons:
        message = (
            "未找到可运行 mykey 同步脚本的 Python：候选解释器要么低于 Python 3.11，"
            "要么缺少 cryptography。请在设置中选择安装了 cryptography 的 Python 3.11+，"
            "或修复 GA 虚拟环境。"
        )
    elif "missing_cryptography" in reasons:
        message = (
            "找到了 Python 3.11 或更高版本，但其中缺少 mykey 同步依赖 cryptography。"
            "请为该解释器安装 cryptography，或在设置中选择已安装该依赖的 GA Python。"
        )
    elif "python_too_old" in reasons:
        message = (
            "找到的 Python 解释器版本低于 3.11，无法运行 mykey 同步脚本。"
            "请在设置中配置 Python 3.11 或更高版本，或升级 GA 虚拟环境。"
        )
    else:
        message = (
            "未找到可运行 mykey 同步脚本的兼容 Python 解释器。"
            "请在设置中配置安装了 cryptography 的 Python 3.11+，"
            "或安装/选择 GA 虚拟环境。"
        )
    return HTTPException(503, {
        "error": "mykey_python_unavailable",
        "message": message,
        "required_python": ">=3.11",
        "required_module": "cryptography",
        "candidate_failures": failures,
    })


def _mykey_sync_python() -> str:
    """Return a real interpreter for GA's external sync script.

    In a packaged desktop build ``sys.executable`` is the PyInstaller sidecar,
    not Python.  Re-launching it with ``mykey_sync.py`` argv only starts the
    sidecar argument parser and exits.  The sync script also uses
    ``datetime.UTC``, so Python 3.11 is the minimum supported version.  Keep
    searching after an unsuitable configured candidate instead of treating it
    as authoritative.
    """
    failures: list[dict[str, str]] = []
    for python, source in _mykey_python_candidates():
        if _is_packaged_process() and _paths._same_as_current_process(python):
            failures.append({"source": source, "reason": "frozen_sidecar"})
            continue
        capability = _probe_mykey_python(python)
        if capability is None:
            failures.append({"source": source, "reason": "probe_failed"})
            continue
        version, has_cryptography = capability
        version_text = f"{version[0]}.{version[1]}"
        if version < _MYKEY_MIN_PYTHON:
            failures.append({
                "source": source,
                "reason": "python_too_old",
                "version": version_text,
            })
            continue
        if not has_cryptography:
            failures.append({
                "source": source,
                "reason": "missing_cryptography",
                "version": version_text,
            })
            continue
        return python

    raise _mykey_python_error(failures)


def _run_mykey_sync(args: list[str]) -> dict[str, Any]:
    """Run mykey_sync.py without passing secrets on argv.

    Secrets are read by the script from environment variables:
    GA_MYKEY_SYNC_PASSPHRASE / GA_MYKEY_UPLOAD_TOKEN.
    """
    script = _mykey_sync_script()
    if _paths.GA_ROOT is None:
        raise HTTPException(503, "GA_ROOT 未配置")
    python = _mykey_sync_python()
    cmd = [python, "-X", "utf8", str(script), *args]
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["GA_ROOT"] = str(_paths.GA_ROOT)
    env["GA_PYTHON"] = python
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(_paths.GA_ROOT),
            env=env,
            stdin=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=90,
            check=False,
            **hidden_process_kwargs(),
        )
    except subprocess.TimeoutExpired as e:
        raise HTTPException(504, {
            "error": "mykey_sync_timeout",
            "message": "mykey 同步超时",
            "stdout": e.stdout or "",
            "stderr": e.stderr or "",
        })
    except OSError as e:
        raise HTTPException(503, {
            "error": "mykey_sync_start_failed",
            "message": f"无法启动 mykey 同步 Python：{type(e).__name__}: {e}",
        })
    except Exception as e:
        raise HTTPException(500, f"启动 mykey 同步失败: {type(e).__name__}: {e}")

    result = {
        "returncode": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }
    if proc.returncode != 0:
        message = f"mykey_sync.py 退出码 {proc.returncode}"
        if "No module named 'cryptography'" in proc.stderr:
            message = (
                f"Python 解释器缺少 mykey 同步依赖 cryptography：{python}。"
                "请为该解释器安装依赖，或在设置中选择已安装该依赖的 GA Python"
            )
        raise HTTPException(500, {
            "error": "mykey_sync_failed",
            "message": message,
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
    result = await asyncio.to_thread(_run_mykey_sync, [
        "upload",
        "--upload-url", upload_url,
        "--source", str(p),
    ])
    return {"ok": True, "action": "upload", "path": str(p), **result}


@router.post("/sync/fetch")
async def sync_fetch_mykey() -> MyKeySyncResultResp:
    """Fetch, decrypt and replace GA_ROOT/mykey.py from the configured sync server."""
    p = _mykey_path()
    result = await asyncio.to_thread(_run_mykey_sync, [
        "fetch",
        "--base-url", _sync_base_url(),
        "--target", str(p),
        "--force",
    ])
    raw, llms, warnings = await asyncio.to_thread(_read_and_reload_mykey, p)
    return {
        "ok": True,
        "action": "fetch",
        "path": str(p),
        "llms": llms,
        "warnings": warnings,
        "structured": _structurize(raw),
        **result,
    }


def _read_and_reload_mykey(path: Path) -> tuple[str, list[dict], list[str]]:
    raw = path.read_text(encoding="utf-8") if path.is_file() else ""
    llms, warnings = _trigger_reload()
    return raw, llms, warnings


@router.post("/open")
async def open_mykey_file() -> MyKeyOpenResp:
    """Open mykey.py in system default editor."""
    p = _mykey_path()
    if not p.is_file():
        raise HTTPException(404, "mykey.py 不存在")
    
    try:
        if sys.platform == "win32":
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)], **hidden_process_kwargs())
        else:
            subprocess.Popen(["xdg-open", str(p)], **hidden_process_kwargs())
        return {"ok": True, "path": str(p)}
    except Exception as e:
        raise HTTPException(500, f"打开文件失败: {str(e)}")
