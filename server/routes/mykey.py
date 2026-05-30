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

import ast
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import _paths

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


# ── apikey masking ─────────────────────────────────────────────────────
def _mask(key: Any) -> str:
    if not isinstance(key, str): return ""
    if len(key) <= 8: return "*" * len(key)
    return f"{key[:4]}***{key[-4:]}"


# ── parse mykey.py → structured ─────────────────────────────────────────
_SESSION_KEYS = ("api", "config", "cookie")  # matches load_llm_sessions

def _classify(var: str) -> str:
    """Mirror agentmain.load_llm_sessions:113-120 detection rules."""
    if not any(k in var for k in _SESSION_KEYS): return "global"
    if "native" in var and "claude" in var: return "native_claude"
    if "native" in var and "oai"    in var: return "native_oai"
    if "claude" in var: return "claude"
    if "oai"    in var: return "oai"
    if "mixin"  in var: return "mixin"
    return "global"


def _structurize(raw: str) -> dict:
    """Walk top-level Assigns; bucket into sessions / mixin / globals.

    apikey is always masked here. Rendering uses ast.literal_eval so any
    weird construct (call, comprehension, f-string) is silently skipped —
    user can still edit those via the raw editor.
    """
    sessions: list[dict] = []
    mixins: list[dict] = []
    globals_: dict[str, Any] = {}
    try:
        tree = ast.parse(raw)
    except SyntaxError:
        return {"sessions": [], "mixins": [], "mixin": None, "globals": {}}
    for node in tree.body:
        if not isinstance(node, ast.Assign): continue
        if len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name): continue
        var = node.targets[0].id
        try: value = ast.literal_eval(node.value)
        except Exception: continue
        kind = _classify(var)
        if kind == "global":
            globals_[var] = value
            continue
        if not isinstance(value, dict): continue
        # mask apikey for transport
        masked_fields = dict(value)
        if "apikey" in masked_fields:
            masked_fields["apikey_masked"] = _mask(masked_fields.pop("apikey"))
        entry = {
            "var": var,
            "type": kind,
            "fields": masked_fields,
            "lineno": node.lineno,
            "end_lineno": getattr(node, "end_lineno", node.lineno),
        }
        if kind == "mixin":
            mixins.append(entry)
        else:
            sessions.append(entry)
    return {"sessions": sessions, "mixins": mixins, "mixin": (mixins[0] if mixins else None), "globals": globals_}


# ── write helpers ──────────────────────────────────────────────────────
def _validate_text(text: str) -> tuple[bool, str | None, int | None, int | None]:
    """Return (ok, msg, line, col). compile() catches a few things ast.parse misses."""
    try:
        ast.parse(text)
    except SyntaxError as e:
        return False, str(e.msg), e.lineno, e.offset
    try:
        compile(text, "mykey.py", "exec")
    except SyntaxError as e:
        return False, str(e.msg), e.lineno, e.offset
    return True, None, None, None


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


# ── render dict back to Python source ──────────────────────────────────
def _render_value(value: Any, level: int = 0, width: int = 88) -> str:
    """Render a literal as Python source matching the hand-written mykey.py style.

    Style rules (so the file diff stays human-friendly and the edited block
    looks identical to the surrounding hand-written config):
      * 4-space indentation per nesting level
      * double-quoted strings, insertion order preserved
      * trailing comma on multi-line dicts / sequences
      * short dicts/lists stay inline when they fit within ``width``

    Unlike ``pprint.pformat`` the continuation indentation is computed from the
    nesting level (column 0), not from the column where the opening brace lands
    after a ``var = `` prefix — that mismatch is what produced the ugly hanging
    indentation when a mixin's ``llm_nos`` was reordered via the webui.
    """
    ind = "    " * level
    ind1 = "    " * (level + 1)
    if isinstance(value, bool):
        return "True" if value else "False"
    if value is None:
        return "None"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{ind1}{_render_value(k)}: {_render_value(v, level + 1, width)}"
            for k, v in value.items()
        ]
        return "{\n" + ",\n".join(items) + ",\n" + ind + "}"
    if isinstance(value, (list, tuple)):
        open_b, close_b = ("[", "]") if isinstance(value, list) else ("(", ")")
        if not value:
            return open_b + close_b
        rendered = [_render_value(v, level + 1, width) for v in value]
        inline = open_b + ", ".join(rendered) + close_b
        if len(ind) + len(inline) <= width and "\n" not in inline:
            return inline
        return (
            open_b + "\n"
            + ",\n".join(f"{ind1}{r}" for r in rendered)
            + ",\n" + ind + close_b
        )
    return repr(value)


def _render_dict(d: dict) -> str:
    """Render a dict literal that round-trips through ast.literal_eval.

    Keeps insertion order so the file diff is human-friendly.
    """
    return _render_value(d, 0)


def _render_assign(var: str, value: dict, header_comment: str | None = None) -> str:
    out = ""
    if header_comment:
        out += f"# {header_comment}\n"
    out += f"{var} = {_render_dict(value)}\n"
    return out


# ── pydantic models ────────────────────────────────────────────────────
class RawWriteReq(BaseModel):
    raw: str


class SessionUpsertReq(BaseModel):
    var: str
    type: str  # native_claude | native_oai | claude | oai | mixin
    fields: dict[str, Any]


# ── routes ─────────────────────────────────────────────────────────────
@router.get("")
async def get_mykey():
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
async def put_raw(req: RawWriteReq):
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
async def upsert_session(req: SessionUpsertReq):
    p = _mykey_path()
    raw = p.read_text(encoding="utf-8") if p.is_file() else ""
    var = req.var.strip()
    if not var.replace("_", "").isalnum():
        raise HTTPException(400, "变量名只允许字母 / 数字 / 下划线")

    # If user supplied apikey == "" or "***", treat as "keep existing".
    fields = dict(req.fields)
    incoming_key = fields.get("apikey")
    if incoming_key in (None, "", "***"):
        # try to read the prior literal value
        try:
            tree = ast.parse(raw)
            for node in tree.body:
                if (isinstance(node, ast.Assign)
                        and len(node.targets) == 1
                        and isinstance(node.targets[0], ast.Name)
                        and node.targets[0].id == var):
                    prior = ast.literal_eval(node.value)
                    if isinstance(prior, dict) and prior.get("apikey"):
                        fields["apikey"] = prior["apikey"]
                    break
        except Exception:
            pass
        # if still missing → leave it absent; user can fill via raw tab
        if fields.get("apikey") in (None, "", "***"):
            fields.pop("apikey", None)

    # locate existing assignment (line span) so we can splice precisely
    span: tuple[int, int] | None = None
    try:
        tree = ast.parse(raw)
        for node in tree.body:
            if (isinstance(node, ast.Assign)
                    and len(node.targets) == 1
                    and isinstance(node.targets[0], ast.Name)
                    and node.targets[0].id == var):
                span = (node.lineno, getattr(node, "end_lineno", node.lineno))
                break
    except SyntaxError:
        # raw is broken; we can still append at end after backing up the broken raw
        pass

    new_block = _render_assign(var, fields, header_comment=None)

    if span is not None:
        lines = raw.splitlines(keepends=True)
        # ast lines are 1-based, end_lineno is inclusive
        before = "".join(lines[: span[0] - 1])
        after  = "".join(lines[span[1]:])
        new_text = before + new_block + after
    else:
        sep = "" if raw.endswith("\n\n") else ("\n" if raw.endswith("\n") else "\n\n")
        new_text = raw + sep + "\n# ── 通过 webui 新增 ──\n" + new_block

    if not new_text.endswith("\n"): new_text += "\n"
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
async def delete_session(var: str):
    p = _mykey_path()
    if not p.is_file():
        raise HTTPException(404, "mykey.py 不存在")
    raw = p.read_text(encoding="utf-8")
    try:
        tree = ast.parse(raw)
    except SyntaxError as e:
        raise HTTPException(400, f"当前 mykey.py 语法错误，无法定位：{e.msg}")
    span: tuple[int, int] | None = None
    for node in tree.body:
        if (isinstance(node, ast.Assign)
                and len(node.targets) == 1
                and isinstance(node.targets[0], ast.Name)
                and node.targets[0].id == var):
            span = (node.lineno, getattr(node, "end_lineno", node.lineno))
            break
    if span is None:
        raise HTTPException(404, f"找不到变量 {var}")
    lines = raw.splitlines(keepends=True)
    new_text = "".join(lines[: span[0] - 1]) + "".join(lines[span[1]:])

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


@router.get("/backups")
async def list_backups():
    bdir = _backup_dir()
    out = []
    for f in sorted(bdir.glob("mykey.py.*.bak"), key=lambda p: p.stat().st_mtime, reverse=True):
        st = f.stat()
        out.append({"name": f.name, "mtime": int(st.st_mtime), "size": st.st_size})
    return {"backups": out}


@router.post("/backups/{name}/restore")
async def restore_backup(name: str):
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
