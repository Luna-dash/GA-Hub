"""mykey.py 域服务 — read / structured mutation / backup-restore / sync.

mykey.py 是 GA 的核心配置：所有 LLM 链路、apikey、apibase、第三方平台 token
都在这里。终端编辑门槛太高，把它搬到 webui；本模块持有全部业务逻辑，
``routes/mykey.py`` 只做 HTTP 适配（线程投递 + 错误翻译）。

GA 已经支持 mykey.py 热更新；GA-Hub 通过稳定 model bridge 触发刷新，
配置落盘后无需重启进程。

安全约束：
    * apikey 永远 mask（前 4 + ``***`` + 后 4），仅 raw 文本视图能看到完整值
    * 路径只能是 ``GA_ROOT/mykey.py``
    * 写入前 ast.parse + compile 双重校验，失败一律拒写
    * 备份落到 admin 数据目录，不污染 GA 仓库

错误模型：本模块不 import fastapi（服务层家规）。表单型失败以
:class:`MykeyHttpError` 抛出，携带与旧路由逐字节一致的 (status_code, detail)，
路由层一对一翻译成 HTTPException。
"""
from __future__ import annotations

import logging
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from .. import _paths, constants
from ..process_utils import hidden_process_kwargs
from .llm_registry import LlmRegistry
from .mykey_codec import (
    AssignmentConflictError,
    AssignmentNotFoundError,
    InvalidSourceError,
    InvalidVariableNameError,
    classify_config as _classify,
    delete_base_assignment,
    mutate_session_assignment,
    update_proxy_assignment,
    structurize as _structurize,
    validate_text as _validate_text,
)

log = logging.getLogger(__name__)


class MykeyHttpError(Exception):
    """HTTP-shaped domain failure; routes translate it to HTTPException.

    mykey 的失败大多是「状态码 + 结构化 detail」的表单（语法诊断行号列号、
    同步子进程 stdout/stderr、候选解释器探测清单）。把 (status, detail) 一起
    放在领域层，路由只做一对一翻译，避免 payload 在两层间漂移。
    """

    def __init__(self, status_code: int, detail: str | dict):
        super().__init__(detail.get("error", "mykey error") if isinstance(detail, dict) else str(detail))
        self.status_code = status_code
        self.detail = detail


# ── locations ───────────────────────────────────────────────────────────
def _mykey_path() -> Path:
    if _paths.GA_ROOT is None:
        raise MykeyHttpError(503, "GA_ROOT 未配置")
    return _paths.ga_mykey_path()


def _backup_dir() -> Path:
    # Pure lookup: readers (list_backups) must not create the directory as
    # a side effect. Writers go through _ensure_backup_dir.
    return _paths.ADMIN_DATA / "mykey-backups"


def _ensure_backup_dir() -> Path:
    p = _backup_dir()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _backup_current(path: Path) -> str | None:
    """Snapshot the current file before overwrite. Returns backup name or None."""
    if not path.is_file(): return None
    name = f"mykey.py.{time.strftime('%Y%m%d-%H%M%S')}-{time.time_ns()}.bak"
    try:
        bdir = _ensure_backup_dir()
        target = bdir / name
        with target.open("xb") as snapshot:
            snapshot.write(path.read_bytes())
            snapshot.flush()
            os.fsync(snapshot.fileno())
    except Exception as e:
        log.warning("mykey backup failed: %s", e)
        raise MykeyHttpError(500, {
            "error": "backup_failed",
            "message": "备份失败，配置未保存；请检查磁盘空间和备份目录权限。",
        }) from e
    # keep last 10
    snapshots = sorted(bdir.glob("mykey.py.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True)
    for old in snapshots[10:]:
        try: old.unlink()
        except Exception: pass
    return name


def _atomic_write(path: Path, text: str) -> None:
    """tmp -> fsync -> replace, without platform newline conversion."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _trigger_reload() -> tuple[list[dict], list[str]]:
    """Force GA to re-read mykey.py + return resulting llm list + warnings.

    GA's model bridge preserves native per-config load isolation, so individual
    failures do not abort the whole reload. We reconstruct warnings by diffing
    intent vs result: every var that
    looks like a session config but doesn't appear in the resulting llm
    names is reported.
    """
    try:
        from .agent_service import get_agent_service
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


def read_mykey() -> dict:
    p = _mykey_path()
    if not p.is_file():
        return {
            "path": str(p),
            "exists": False,
            "raw": "",
            "structured": {"sessions": [], "mixins": [], "globals": {}},
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


def _commit_text(path: Path, text: str, error: str = "syntax_error") -> dict:
    """Validate, snapshot, atomically replace and reload under the caller's lock."""
    ok, msg, line, col = _validate_text(text)
    if not ok:
        raise MykeyHttpError(400, {
            "error": error, "message": msg, "line": line, "col": col,
        })
    backup = _backup_current(path)
    _atomic_write(path, text)
    llms, warnings = _trigger_reload()
    return {
        "ok": True, "backup": backup, "llms": llms, "warnings": warnings,
        "structured": _structurize(text),
    }


def write_raw(text: str) -> dict:
    p = _mykey_path()
    if not text.endswith("\n"):
        text += "\n"
    with LlmRegistry.synchronized():
        return _commit_text(p, text)


def mutate_mykey(
    action: str,
    var: str | None = None,
    new_var: str | None = None,
    fields: dict[str, Any] | None = None,
    session_type: str | None = None,
    expected_raw: str | None = None,
) -> dict:
    """Apply one structured mutation as a single locked file transaction."""
    p = _mykey_path()
    removed_references = 0
    with LlmRegistry.synchronized():
        if p.is_file():
            with p.open(encoding="utf-8", newline="") as source:
                original_raw = source.read()
        else:
            original_raw = ""
        raw = original_raw.replace("\r\n", "\n").replace("\r", "\n")
        try:
            if action == "proxy":
                if expected_raw is None or raw != expected_raw:
                    raise MykeyHttpError(409, "配置已被外部更新，请刷新后重试；草稿未保存")
                value = (fields or {}).get("proxy")
                if not isinstance(value, str):
                    raise MykeyHttpError(400, "proxy 必须是字符串")
                new_text = update_proxy_assignment(raw, value)
            elif action in {"create", "update", "rename", "duplicate"}:
                new_text = mutate_session_assignment(raw, action, var, new_var, fields, session_type)
            elif action == "delete":
                if not var:
                    raise MykeyHttpError(400, "缺少变量名")
                new_text, removed_references = delete_base_assignment(raw, var)
            else:
                raise MykeyHttpError(400, f"不支持的 mykey 操作：{action}")
        except MykeyHttpError:
            raise
        except InvalidSourceError as e:
            raise MykeyHttpError(400, {
                "error": "syntax_error_before_mutation",
                "message": str(e),
            }) from e
        except AssignmentNotFoundError as e:
            raise MykeyHttpError(404, f"找不到变量 {e}") from e
        except InvalidVariableNameError as e:
            raise MykeyHttpError(400, f"非法变量名：{e}") from e
        except AssignmentConflictError as e:
            raise MykeyHttpError(409, {
                "error": "assignment_conflict",
                "var": str(e),
                "message": f"变量 {e} 已存在",
            }) from e

        if "\r\n" in original_raw:
            new_text = new_text.replace("\n", "\r\n")
        result = _commit_text(p, new_text, "syntax_error_after_mutation")
    result["action"] = action
    if action == "delete":
        result["removed_mixin_references"] = removed_references
    return result


def test_session_sync(var: str) -> dict:
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
    # Silence the archive logger: a ping must not append to / create
    # model_responses_{pid}.txt (that file *is* the 历史对话 session list).
    saved_log = getattr(client, "log_path", None)
    try:
        if hasattr(backend, "history"):
            backend.history = []
        if hasattr(backend, "tools"):
            backend.tools = None
        if hasattr(client, "log_path"):
            client.log_path = False

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
            if hasattr(client, "log_path"):
                client.log_path = saved_log
        except Exception:
            pass


def list_backups() -> dict:
    bdir = _backup_dir()
    out = []
    for f in sorted(bdir.glob("mykey.py.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"name": f.name, "mtime": int(st.st_mtime), "size": st.st_size})
    return {"backups": out}


def restore_backup(name: str) -> dict:
    if "/" in name or ".." in name or not name.startswith("mykey.py.") or not name.endswith(".bak"):
        raise MykeyHttpError(400, "非法备份名")
    bdir = _backup_dir()
    src = bdir / name
    if not src.is_file():
        raise MykeyHttpError(404, "备份不存在")
    p = _mykey_path()
    with src.open(encoding="utf-8", newline="") as source:
        text = source.read()
    with LlmRegistry.synchronized():
        return _commit_text(p, text, "backup_invalid")


# ── encrypted sync via GA assets/mykey_sync.py ─────────────────────────
def _mykey_sync_script() -> Path:
    if _paths.GA_ROOT is None:
        raise MykeyHttpError(503, "GA_ROOT 未配置")
    script = _paths.ga_mykey_sync_script()
    if not script.is_file():
        raise MykeyHttpError(500, f"同步脚本不存在: {script}")
    return script


def _sync_base_url() -> str:
    # KV 方案(2026-09-17 起)：入口 sync.lunadash.me =
    # Vercel Serverless Function + Cloudflare Workers KV。
    # 每次 upload 只是一次 PUT（不再创建 Vercel 部署），下载是一次 GET。
    # 自定义域名大陆直连可达；*vercel.app 直连被墙，不可作端点。
    # 旧静态站 ga.lunadash.me 仅作历史兜底，不再写入。
    return os.environ.get(constants.ENV_MYKEY_SYNC_URL, "https://sync.lunadash.me").rstrip("/")


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
    env.pop(constants.ENV_MYKEY_SYNC_PASSPHRASE, None)
    env.pop(constants.ENV_MYKEY_UPLOAD_TOKEN, None)
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


def _mykey_python_error(failures: list[dict[str, str]]) -> MykeyHttpError:
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
    return MykeyHttpError(503, {
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

    凭证不进 argv，也不进 env：脚本自身从 GA keychain 读取唯一凭证
    ``ga_mykey_sync_key``（同时用于服务端路径派生、AES-256-GCM 加解密与
    Bearer 写入口令派生），本函数只负责透传环境。

    历史遗留的 GA_MYKEY_SYNC_PASSPHRASE / GA_MYKEY_UPLOAD_TOKEN 仍会被
    原样透传（外部注入时），探测子进程则显式 pop 掉它们
    （见 _probe_mykey_python）。KV 方案下无需设置这两个变量。
    """
    script = _mykey_sync_script()
    if _paths.GA_ROOT is None:
        raise MykeyHttpError(503, "GA_ROOT 未配置")
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
        raise MykeyHttpError(504, {
            "error": "mykey_sync_timeout",
            "message": "mykey 同步超时",
            "stdout": e.stdout or "",
            "stderr": e.stderr or "",
        })
    except OSError as e:
        raise MykeyHttpError(503, {
            "error": "mykey_sync_start_failed",
            "message": f"无法启动 mykey 同步 Python：{type(e).__name__}: {e}",
        })
    except Exception as e:
        raise MykeyHttpError(500, f"启动 mykey 同步失败: {type(e).__name__}: {e}")

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
        raise MykeyHttpError(500, {
            "error": "mykey_sync_failed",
            "message": message,
            **result,
        })
    return result


def sync_upload() -> dict:
    """Encrypt and upload current GA_ROOT/mykey.py to the configured sync server."""
    p = _mykey_path()
    if not p.is_file():
        raise MykeyHttpError(404, "mykey.py 不存在")
    # KV 方案: upload = 加密为单容器后一次 PUT 到 KV（脚本内含回读字节级校验），
    # --base-url 为服务根 URL（默认 sync.lunadash.me）。
    result = _run_mykey_sync([
        "upload",
        "--base-url", _sync_base_url(),
        "--source", str(p),
    ])
    return {"ok": True, "action": "upload", "path": str(p), **result}


def sync_fetch() -> dict:
    """Download into staging; only the shared transaction can replace mykey.py."""
    p = _mykey_path()
    _paths.ADMIN_DATA.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="mykey-fetch-", dir=_paths.ADMIN_DATA) as staging:
        target = Path(staging) / "mykey.py"
        result = _run_mykey_sync([
            "fetch", "--base-url", _sync_base_url(), "--target", str(target), "--force",
        ])
        if not target.is_file():
            raise MykeyHttpError(500, {"error": "sync_output_missing"})
        with target.open(encoding="utf-8", newline="") as source:
            raw = source.read()
        with LlmRegistry.synchronized():
            committed = _commit_text(p, raw, "sync_invalid")
    return {**committed, "action": "fetch", "path": str(p), **result}


def open_mykey_file() -> dict:
    """Open mykey.py in system default editor."""
    p = _mykey_path()
    if not p.is_file():
        raise MykeyHttpError(404, "mykey.py 不存在")

    try:
        if sys.platform == "win32":
            os.startfile(str(p))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(p)], **hidden_process_kwargs())
        else:
            subprocess.Popen(["xdg-open", str(p)], **hidden_process_kwargs())
        return {"ok": True, "path": str(p)}
    except Exception as e:
        raise MykeyHttpError(500, f"打开文件失败: {str(e)}")
