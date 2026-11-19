"""Local agy profiles. Only agy itself reads or writes login credentials."""
from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from .. import _paths
from .anti_engine import AntiError

DEFAULT = "default"
PROFILE_ID = r"(?:default|[0-9a-f]{32})"
_PROXY_KEYS = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
_LOOPBACK = "localhost,127.0.0.1,::1"
_CLI_CREDENTIAL_FILES = (
    "antigravity-oauth-token",
    "settings.json",
    "installation_id",
    "jetski_state.pbtxt",
)


@dataclass(frozen=True)
class Profile:
    id: str
    name: str


def _root() -> Path:
    return _paths.ADMIN_DATA / "agy-profiles"


def _load_raw() -> tuple[str, list[Profile], dict[str, dict[str, Any]]]:
    default = Profile(DEFAULT, "系统默认")
    try:
        raw = json.loads((_root() / "profiles.json").read_text(encoding="utf-8"))
        profiles = [default, *(Profile(id=item["id"], name=item["name"]) for item in raw["profiles"])]
        active = raw["active"]
        ids = {p.id for p in profiles}
        if (len(ids) != len(profiles) or active not in ids or
                any(not re.fullmatch(PROFILE_ID, p.id) or not isinstance(p.name, str) for p in profiles)):
            raise ValueError("Invalid profile metadata")
        meta = raw.get("meta")
        clean_meta = {k: v for k, v in meta.items() if k in ids and isinstance(v, dict)} if isinstance(meta, dict) else {}
        return active, profiles, clean_meta
    except FileNotFoundError:
        return DEFAULT, [default], {}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise AntiError(503, "无法读取 Agy 账号设置") from exc


def _load() -> tuple[str, list[Profile]]:
    active, profiles, _ = _load_raw()
    return active, profiles


def snapshot() -> tuple[str, list[Profile]]:
    return _load()


def has_local_credentials(profile_id: str) -> bool:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return False
    base = Path.home() if profile_id == DEFAULT else (_root() / profile_id / "home")
    token = base / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"
    try:
        return token.is_file() and token.stat().st_size > 0
    except OSError:
        return False


def snapshot_details() -> dict[str, dict[str, Any]]:
    _, profiles, meta = _load_raw()
    details: dict[str, dict[str, Any]] = {}
    for p in profiles:
        entry: dict[str, Any] = {"has_credentials": has_local_credentials(p.id)}
        p_meta = meta.get(p.id)
        if p_meta:
            if isinstance(p_meta.get("auth_state"), str):
                entry["auth_state"] = p_meta["auth_state"]
            if isinstance(p_meta.get("usage"), dict):
                entry["usage"] = p_meta["usage"]
        details[p.id] = entry
    return details


def _save(active: str, profiles: list[Profile], meta: dict[str, dict[str, Any]] | None = None) -> None:
    path = _root() / "profiles.json"
    stage = None
    if meta is None:
        _, _, existing_meta = _load_raw()
        ids = {p.id for p in profiles}
        meta = {k: v for k, v in existing_meta.items() if k in ids}
    payload: dict[str, Any] = {
        "active": active,
        "profiles": [{"id": item.id, "name": item.name} for item in profiles if item.id != DEFAULT],
    }
    if meta:
        payload["meta"] = meta
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            stage = Path(file.name)
            json.dump(payload, file, ensure_ascii=False)
        stage.replace(path)
    except OSError as exc:
        raise AntiError(503, "无法保存 Agy 账号设置") from exc
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def add(name: str) -> Profile:
    active, profiles, meta = _load_raw()
    if any(p.name.casefold() == name.casefold() for p in profiles):
        raise AntiError(409, "已有同名 Agy 账号")
    profile = Profile(uuid4().hex, name)
    _save(active, [*profiles, profile], meta)
    return profile


def rename(profile_id: str, name: str) -> Profile:
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AntiError(404, "找不到 Agy 账号")
    if profile_id == DEFAULT:
        raise AntiError(409, "系统默认账号不能修改备注")
    if any(p.id != profile_id and p.name.casefold() == name.casefold() for p in profiles):
        raise AntiError(409, "已有同名 Agy 账号")
    renamed = Profile(profile_id, name)
    _save(active, [renamed if p.id == profile_id else p for p in profiles], meta)
    return renamed


def select(profile_id: str) -> None:
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AntiError(404, "找不到 Agy 账号")
    if active != profile_id:
        _save(profile_id, profiles, meta)


def delete(profile_id: str) -> None:
    if profile_id == DEFAULT:
        raise AntiError(409, "系统默认账号不能删除")
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AntiError(404, "找不到 Agy 账号")
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AntiError(404, "找不到 Agy 账号")
    if active == profile_id:
        raise AntiError(409, "请先切换到其他账号后再删除当前账号")
    next_profiles = [p for p in profiles if p.id != profile_id]
    meta.pop(profile_id, None)
    _save(active, next_profiles, meta)
    target = _root() / profile_id
    if target.exists():
        try:
            if target.resolve() != target:
                raise AntiError(409, "Agy 账号目录不得重定向")
            shutil.rmtree(target, ignore_errors=True)
        except OSError as exc:
            raise AntiError(503, "无法删除 Agy 账号目录") from exc


def capture_default(name: str) -> Profile:
    """Clone the host default CLI credentials into a new isolated profile."""
    active, profiles, meta = _load_raw()
    if any(p.name.casefold() == name.casefold() for p in profiles):
        raise AntiError(409, "已有同名 Agy 账号")
    src_cli = Path.home() / ".gemini" / "antigravity-cli"
    token = src_cli / "antigravity-oauth-token"
    try:
        if not token.is_file() or token.stat().st_size == 0:
            raise AntiError(409, "系统默认账号尚未登录 agy CLI，无法另存")
        if src_cli.resolve() != src_cli:
            raise AntiError(409, "系统默认 agy 目录不得重定向")
    except OSError as exc:
        raise AntiError(503, "无法读取系统默认 agy 凭据目录") from exc

    profile = Profile(uuid4().hex, name)
    dest_cli = _root() / profile.id / "home" / ".gemini" / "antigravity-cli"
    try:
        dest_cli.mkdir(mode=0o700, parents=True, exist_ok=True)
        for fname in _CLI_CREDENTIAL_FILES:
            src_file = src_cli / fname
            if src_file.is_file() and src_file.resolve() == src_file:
                dst_file = dest_cli / fname
                shutil.copy2(src_file, dst_file)
                try:
                    os.chmod(dst_file, 0o600)
                except OSError:
                    pass
    except OSError as exc:
        shutil.rmtree(_root() / profile.id, ignore_errors=True)
        raise AntiError(503, "无法复制系统默认 agy 凭据") from exc

    if DEFAULT in meta and isinstance(meta[DEFAULT], dict):
        meta[profile.id] = dict(meta[DEFAULT])
    _save(active, [*profiles, profile], meta)
    return profile


def record_usage(profile_id: str, auth_state: str, rows: list[dict[str, Any]]) -> None:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return
    try:
        active, profiles, meta = _load_raw()
    except AntiError:
        return
    if not any(p.id == profile_id for p in profiles):
        return
    pcts = [float(r["remaining_pct"]) for r in rows if isinstance(r.get("remaining_pct"), (int, float))]
    entry = dict(meta.get(profile_id) or {})
    entry["auth_state"] = auth_state
    entry["usage"] = {
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "min_remaining_pct": min(pcts) if pcts else None,
        "rows": rows,
    }
    meta[profile_id] = entry
    try:
        _save(active, profiles, meta)
    except AntiError:
        pass


def agy_executable() -> str:
    name = "agy.exe" if os.name == "nt" else "agy"
    candidates = (os.environ.get("ANTICLI_AGY_PATH"), shutil.which(name),
                  str(Path.home() / ".gemini" / "bin" / name))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise AntiError(503, "找不到官方 agy CLI，请先安装")


def _parse_proxy_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    try:
        url = urlsplit(value if "://" in value else f"http://{value}")
        if (url.scheme in {"http", "https"} and url.hostname and url.port
                and url.username is None and url.password is None and url.path in {"", "/"}
                and not url.query and not url.fragment
                and not any(c.isspace() or c in "\\,;" for c in value)):
            return f"{url.scheme}://{url.netloc}"
    except ValueError:
        pass
    return None


def system_proxy_env(env: dict[str, str]) -> dict[str, str]:
    """Best-effort injection of Windows manual HTTP/HTTPS proxy for agy login."""
    result = env.copy()
    if os.name != "nt":
        return result
    try:
        import winreg
        settings = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings"
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, settings) as key:
            def read(name: str):
                try:
                    return winreg.QueryValueEx(key, name)[0]
                except FileNotFoundError:
                    return None
            if read("AutoConfigURL") or read("ProxyEnable") != 1:
                return result
            server = read("ProxyServer")
    except OSError:
        return result
    if not isinstance(server, str) or not server.strip():
        return result
    http = https = None
    if "=" not in server:
        http = https = _parse_proxy_url(server)
    else:
        routes: dict[str, str] = {}
        for entry in server.split(";"):
            proto, sep, addr = entry.partition("=")
            if sep and proto.strip().lower() in {"http", "https"}:
                parsed = _parse_proxy_url(addr)
                if parsed:
                    routes[proto.strip().lower()] = parsed
        http = routes.get("http") or routes.get("https")
        https = routes.get("https") or routes.get("http")
    if not http or not https:
        return result
    for k in tuple(result):
        if k.lower() in _PROXY_KEYS:
            result.pop(k, None)
    result.update({"HTTP_PROXY": http, "HTTPS_PROXY": https, "ALL_PROXY": https, "NO_PROXY": _LOOPBACK})
    return result


def profile_data_dir(profile_id: str) -> Path:
    if profile_id == DEFAULT or not re.fullmatch(PROFILE_ID, profile_id):
        raise AntiError(404, "找不到 Agy 账号")
    data_dir = _root() / profile_id / "anticli-data"
    try:
        if data_dir.resolve() != data_dir:
            raise AntiError(409, "Agy 账号目录不得重定向")
        data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise AntiError(503, "无法创建 Agy 账号数据目录") from exc
    return data_dir


def profile_env(profile_id: str, env: dict[str, str]) -> dict[str, str]:
    if profile_id == DEFAULT:
        return env.copy()
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AntiError(404, "找不到 Agy 账号")
    home = _root() / profile_id / "home"
    try:
        if home.resolve() != home:
            raise AntiError(409, "Agy 账号目录不得重定向")
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise AntiError(503, "无法创建 Agy 账号目录") from exc
    result = {**env, "HOME": str(home), "ANTICLI_AGY_PATH": agy_executable()}
    if os.name == "nt":
        result.update(USERPROFILE=str(home), HOMEDRIVE=home.drive,
                      HOMEPATH=str(home)[len(home.drive):])
    return result
