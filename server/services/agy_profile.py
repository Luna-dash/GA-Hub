"""Standalone Antigravity (agy) profile isolation, env hygiene, and login support.

Directly implements T3 Code's isolated GEMINI_HOME + file-storage ACP strategy
inside GA-Hub without requiring an external AntiCLI HTTP daemon.
"""
from __future__ import annotations

import errno
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile, mkdtemp
from typing import Any, BinaryIO, Iterator
from urllib.parse import urlsplit
from uuid import uuid4

from .. import _paths
from ..constants import ENV_AGY_PATH
from ..process_utils import hidden_process_kwargs
from . import child_job

log = logging.getLogger(__name__)

DEFAULT = "default"
PROFILE_ID = r"(?:default|[0-9a-f]{32})"
APP_DATA_DIR_NAME = "antigravity-cli"

_PROXY_KEYS = {"http_proxy", "https_proxy", "all_proxy", "no_proxy"}
_LOOPBACK = "localhost,127.0.0.1,::1"
_CLI_CREDENTIAL_FILES = (
    "antigravity-oauth-token",
    "acp_token.json",
    "settings.json",
    "installation_id",
    "jetski_state.pbtxt",
)

# Match T3 Code's removedEnvironmentKeys so host Gemini/Vertex overrides or dead
# PyInstaller/Electron handles do not leak into isolated agy ACP sessions.
_REMOVED_ENV_KEYS = frozenset({
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_CLOUD_QUOTA_PROJECT",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT",
    "AGY_ACP_CCPA_PROJECT",
    "AGY_ACP_ENABLE_OAUTH",
    "GEMINI_HOME",
    "AGY_ACP_FORCE_FILE_STORAGE",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "BROWSER",
    "PYTHONUNBUFFERED",
    "ELECTRON_RUN_AS_NODE",
    "CHROME_CRASHPAD_PIPE_NAME",
    "WSL_INTEROP",
    "WSLENV",
    "WSL_DISTRO_NAME",
    "ANTIGRAVITY_AGENT",
    "ANTIGRAVITY_AGENTAPI_EXE",
    "ANTIGRAVITY_APP_DATA_DIR",
    "ANTIGRAVITY_AUTH_SUCCESS_APP",
    "ANTIGRAVITY_CONVERSATION_ID",
    "ANTIGRAVITY_CSRF_TOKEN",
    "ANTIGRAVITY_LS_ADDRESS",
    "ANTIGRAVITY_LS_VERSION",
    "ANTIGRAVITY_PROJECT_ID",
    "ANTIGRAVITY_SOURCE_METADATA",
    "ANTIGRAVITY_TRAJECTORY_ID",
    "ANTIGRAVITY_VSCODE_HOST",
})

_USER_SKILL_DIRS = (
    ("skills",),
    ("..", ".agents", "skills"),
)
_USER_CONFIG_FILES = (
    ("AGENTS.md",),
    ("GEMINI.md",),
    ("config", "skills.json"),
)
_RETIRED_TEMP_PREFIX = "agy-tmp.old-"


class AgyProfileError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status


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
        if (
            len(ids) != len(profiles)
            or active not in ids
            or any(not re.fullmatch(PROFILE_ID, p.id) or not isinstance(p.name, str) for p in profiles)
        ):
            raise ValueError("Invalid profile metadata")
        meta = raw.get("meta")
        clean_meta = {k: v for k, v in meta.items() if k in ids and isinstance(v, dict)} if isinstance(meta, dict) else {}
        return active, profiles, clean_meta
    except FileNotFoundError:
        return DEFAULT, [default], {}
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise AgyProfileError(503, "无法读取 Agy 账号设置") from exc


def snapshot() -> tuple[str, list[Profile]]:
    active, profiles, _ = _load_raw()
    return active, profiles


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
        raise AgyProfileError(503, "无法保存 Agy 账号设置") from exc
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def profile_home(profile_id: str) -> Path:
    if profile_id == DEFAULT:
        return Path.home()
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    return _root() / profile_id / "home"


def profile_gemini_dir(profile_id: str) -> Path:
    return profile_home(profile_id) / ".gemini"


def profile_app_data_dir(profile_id: str) -> Path:
    return profile_gemini_dir(profile_id) / APP_DATA_DIR_NAME


def profile_runtime_temp_root(profile_id: str) -> Path:
    if profile_id == DEFAULT:
        return _root() / "default-runtime-tmp"
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    return _root() / profile_id / "runtime-tmp"


def find_credential_file(profile_id: str, filename: str) -> Path | None:
    """Return existing credential file inside antigravity-cli or antigravity-acp."""
    if not re.fullmatch(PROFILE_ID, profile_id):
        return None
    gemini = profile_gemini_dir(profile_id)
    for app_dir in (APP_DATA_DIR_NAME, "antigravity-acp"):
        candidate = gemini / app_dir / filename
        try:
            if candidate.is_file() and candidate.stat().st_size > 0:
                return candidate
        except OSError:
            continue
    return None


def has_local_credentials(profile_id: str) -> bool:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return False
    for fname in ("acp_token.json", "antigravity-oauth-token"):
        if find_credential_file(profile_id, fname) is not None:
            return True
    if profile_id == DEFAULT and os.name == "nt":
        # agy 1.5+ stores default personal OAuth tokens in Windows Credential Manager.
        try:
            from .agy_usage import read_windows_cli_credential
            return read_windows_cli_credential() is not None
        except Exception:
            return False
    return False


def snapshot_details() -> tuple[str, list[dict[str, Any]]]:
    active, profiles, meta = _load_raw()
    items: list[dict[str, Any]] = []
    for p in profiles:
        entry: dict[str, Any] = {
            "id": p.id,
            "name": p.name,
            "has_credentials": has_local_credentials(p.id),
        }
        p_meta = meta.get(p.id)
        if p_meta:
            if isinstance(p_meta.get("auth_state"), str):
                entry["auth_state"] = p_meta["auth_state"]
            if isinstance(p_meta.get("usage"), dict):
                entry["usage"] = p_meta["usage"]
        items.append(entry)
    return active, items


def add(name: str) -> Profile:
    active, profiles, meta = _load_raw()
    if any(p.name.casefold() == name.casefold() for p in profiles):
        raise AgyProfileError(409, "已有同名 Agy 账号")
    profile = Profile(uuid4().hex, name)
    _save(active, [*profiles, profile], meta)
    return profile


def rename(profile_id: str, name: str) -> Profile:
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AgyProfileError(404, "找不到 Agy 账号")
    if profile_id == DEFAULT:
        raise AgyProfileError(409, "系统默认账号不能修改备注")
    if any(p.id != profile_id and p.name.casefold() == name.casefold() for p in profiles):
        raise AgyProfileError(409, "已有同名 Agy 账号")
    renamed = Profile(profile_id, name)
    _save(active, [renamed if p.id == profile_id else p for p in profiles], meta)
    return renamed


def select(profile_id: str) -> None:
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AgyProfileError(404, "找不到 Agy 账号")
    if active != profile_id:
        _save(profile_id, profiles, meta)


def delete(profile_id: str) -> None:
    if profile_id == DEFAULT:
        raise AgyProfileError(409, "系统默认账号不能删除")
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    active, profiles, meta = _load_raw()
    if not any(p.id == profile_id for p in profiles):
        raise AgyProfileError(404, "找不到 Agy 账号")
    if active == profile_id:
        raise AgyProfileError(409, "请先切换到其他账号后再删除当前账号")
    next_profiles = [p for p in profiles if p.id != profile_id]
    meta.pop(profile_id, None)
    with profile_lock(profile_id):
        _save(active, next_profiles, meta)
        target = _root() / profile_id
        if target.exists():
            try:
                if target.resolve() != target:
                    raise AgyProfileError(409, "Agy 账号目录不得重定向")
                shutil.rmtree(target, ignore_errors=True)
            except OSError as exc:
                raise AgyProfileError(503, "无法删除 Agy 账号目录") from exc


def capture_default(name: str) -> Profile:
    """Clone the host default CLI/ACP credentials into a new isolated profile."""
    active, profiles, meta = _load_raw()
    if any(p.name.casefold() == name.casefold() for p in profiles):
        raise AgyProfileError(409, "已有同名 Agy 账号")
    src_cli = Path.home() / ".gemini" / APP_DATA_DIR_NAME
    token_file = find_credential_file(DEFAULT, "antigravity-oauth-token") or find_credential_file(
        DEFAULT, "acp_token.json"
    )
    keyring_blob: bytes | None = None
    if token_file is None and os.name == "nt":
        try:
            from .agy_usage import read_windows_cli_credential
            keyring_blob = read_windows_cli_credential()
        except Exception:
            keyring_blob = None
    if token_file is None and keyring_blob is None:
        raise AgyProfileError(409, "系统默认账号尚未登录 agy CLI，无法另存")
    if src_cli.exists():
        try:
            if src_cli.resolve() != src_cli:
                raise AgyProfileError(409, "系统默认 agy 目录不得重定向")
        except OSError as exc:
            raise AgyProfileError(503, "无法读取系统默认 agy 凭据目录") from exc

    profile = Profile(uuid4().hex, name)
    dest_cli = profile_app_data_dir(profile.id)
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
        if keyring_blob is not None and not (dest_cli / "antigravity-oauth-token").exists():
            dst_tok = dest_cli / "antigravity-oauth-token"
            dst_tok.write_bytes(keyring_blob)
            try:
                os.chmod(dst_tok, 0o600)
            except OSError:
                pass
    except OSError as exc:
        shutil.rmtree(_root() / profile.id, ignore_errors=True)
        raise AgyProfileError(503, "无法复制系统默认 agy 凭据") from exc

    if DEFAULT in meta and isinstance(meta[DEFAULT], dict):
        meta[profile.id] = dict(meta[DEFAULT])
    _save(active, [*profiles, profile], meta)
    return profile


def clear_credentials(profile_id: str) -> dict[str, Any]:
    if profile_id == DEFAULT:
        raise AgyProfileError(409, "系统默认账号凭据由系统 agy CLI 管理，不支持在 Hub 内清除")
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    active, profiles, meta = _load_raw()
    target_profile = next((p for p in profiles if p.id == profile_id), None)
    if target_profile is None:
        raise AgyProfileError(404, "找不到 Agy 账号")
    with profile_lock(profile_id):
        gemini_dir = profile_gemini_dir(profile_id)
        try:
            for sub in (APP_DATA_DIR_NAME, "antigravity-acp"):
                cli_dir = gemini_dir / sub
                if not cli_dir.exists():
                    continue
                if cli_dir.resolve() != cli_dir:
                    raise AgyProfileError(409, "Agy 账号目录不得重定向")
                for fname in _CLI_CREDENTIAL_FILES:
                    candidate = cli_dir / fname
                    if candidate.is_symlink():
                        raise AgyProfileError(409, "Agy 账号凭据文件不得重定向")
                    if candidate.is_file():
                        candidate.unlink(missing_ok=True)
        except OSError as exc:
            raise AgyProfileError(503, "无法清除 Agy 账号凭据") from exc
        retire_runtime_temp_dirs(profile_runtime_temp_root(profile_id))
        meta.pop(profile_id, None)
        _save(active, profiles, meta)
        return {
            "id": target_profile.id,
            "name": target_profile.name,
            "has_credentials": has_local_credentials(profile_id),
        }


def record_usage(profile_id: str, auth_state: str, rows: list[dict[str, Any]]) -> None:
    if not re.fullmatch(PROFILE_ID, profile_id):
        return
    try:
        active, profiles, meta = _load_raw()
    except AgyProfileError:
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
    except AgyProfileError:
        pass


def agy_executable_or_none() -> str | None:
    name = "agy.exe" if os.name == "nt" else "agy"
    candidates = (
        os.environ.get(ENV_AGY_PATH),
        os.environ.get("ANTICLI_AGY_PATH"),
        shutil.which(name),
        str(Path.home() / ".gemini" / "bin" / name),
    )
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    return None


def agy_executable() -> str:
    found = agy_executable_or_none()
    if found is None:
        raise AgyProfileError(503, "找不到官方 agy CLI，请先安装")
    return found


def _parse_proxy_url(value: str) -> str | None:
    value = value.strip()
    if not value:
        return None
    try:
        url = urlsplit(value if "://" in value else f"http://{value}")
        if (
            url.scheme in {"http", "https"}
            and url.hostname
            and url.port
            and url.username is None
            and url.password is None
            and url.path in {"", "/"}
            and not url.query
            and not url.fragment
            and not any(c.isspace() or c in "\\,;" for c in value)
        ):
            return f"{url.scheme}://{url.netloc}"
    except ValueError:
        pass
    return None


def system_proxy_env(env: dict[str, str]) -> dict[str, str]:
    """Best-effort injection of Windows manual HTTP/HTTPS proxy for agy."""
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


def retire_runtime_temp_dirs(temp_root: Path) -> None:
    """Reclaim leftover per-process unpacked agy temp directories asynchronously on launch."""
    try:
        if not temp_root.exists():
            return
        for entry in list(temp_root.iterdir()):
            if entry.is_dir() and (entry.name.startswith("run-") or entry.name.startswith(_RETIRED_TEMP_PREFIX)):
                shutil.rmtree(entry, ignore_errors=True)
    except OSError:
        log.debug("Failed to sweep leftover agy runtime temp directories", exc_info=True)


def make_runtime_temp_dir(profile_id: str) -> Path:
    root = profile_runtime_temp_root(profile_id)
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return Path(mkdtemp(prefix="run-", dir=root))


def _is_pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == 259  # STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _profile_lock_file(profile_id: str) -> Path:
    return profile_runtime_temp_root(profile_id) / "runtime.pid"


def _read_live_lock_pid(profile_id: str) -> int | None:
    if profile_id == DEFAULT or not re.fullmatch(PROFILE_ID, profile_id):
        return None
    lock_file = _profile_lock_file(profile_id)
    try:
        if not lock_file.is_file() or lock_file.is_symlink():
            return None
        raw = lock_file.read_text(encoding="utf-8").strip()
        pid = int(json.loads(raw)["pid"]) if raw.startswith("{") else int(raw)
    except (OSError, ValueError, TypeError, KeyError):
        return None
    if _is_pid_alive(pid):
        return pid
    return None


_profile_locks_guard = threading.Lock()
_profile_locks: dict[Path, tuple[BinaryIO, int]] = {}


def _profile_guard_file(profile_id: str) -> Path:
    # Never unlink this file: waiters must always contend on the same inode.
    return _root() / ".locks" / f"{profile_id}.lock"


def claim_profile_lock(profile_id: str) -> None:
    if profile_id == DEFAULT:
        return
    legacy = _profile_lock_file(profile_id)
    path = _profile_guard_file(profile_id)
    with _profile_locks_guard:
        held = _profile_locks.get(path)
        if held is not None:
            _profile_locks[path] = (held[0], held[1] + 1)
            return
        stream = None
        try:
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            stream = path.open("a+b")
            stream.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                if exc.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    raise AgyProfileError(409, "当前隔离账号正被另一个 GA-Hub 进程占用") from exc
                raise
            pid = _read_live_lock_pid(profile_id)
            if pid is not None and pid != os.getpid():
                raise AgyProfileError(409, f"当前隔离账号正被另一个 GA-Hub 进程（PID {pid}）占用")
            # Keep the PID marker for older Hub builds. Only the OS lock
            # arbitrates concurrent claims by upgraded builds.
            legacy.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            legacy.write_text(json.dumps({"pid": os.getpid()}), encoding="utf-8")
            _profile_locks[path] = (stream, 1)
            stream = None
        except OSError as exc:
            raise AgyProfileError(503, "无法锁定 Agy 隔离账号") from exc
        finally:
            if stream is not None:
                stream.close()


def release_profile_lock(profile_id: str) -> None:
    if profile_id == DEFAULT:
        return
    path = _profile_guard_file(profile_id)
    with _profile_locks_guard:
        held = _profile_locks.get(path)
        if held is None:
            return
        stream, count = held
        if count > 1:
            _profile_locks[path] = (stream, count - 1)
            return
        try:
            _profile_lock_file(profile_id).unlink(missing_ok=True)
        except OSError:
            log.warning("Failed to remove legacy agy PID marker for %s", profile_id, exc_info=True)
        finally:
            del _profile_locks[path]
            stream.close()


@contextmanager
def profile_lock(profile_id: str) -> Iterator[None]:
    claim_profile_lock(profile_id)
    try:
        yield
    finally:
        release_profile_lock(profile_id)


def sync_user_customizations(profile_id: str) -> None:
    """Mirror global skills & instruction files from ~/.gemini into isolated profiles (T3 Code pattern)."""
    if profile_id == DEFAULT:
        return
    user_gemini = Path.home() / ".gemini"
    prof_gemini = profile_gemini_dir(profile_id)
    prof_gemini.mkdir(mode=0o700, parents=True, exist_ok=True)
    for segments in _USER_CONFIG_FILES:
        src = user_gemini.joinpath(*segments)
        dst = prof_gemini.joinpath(*segments)
        try:
            if not src.is_file() or src.is_symlink():
                continue
            if dst.exists() and not dst.is_symlink():
                # Keep user-edited profile overrides untouched once initialized.
                continue
            if dst.is_symlink():
                dst.unlink(missing_ok=True)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        except OSError:
            continue
    for segments in _USER_SKILL_DIRS:
        src = (user_gemini.joinpath(*segments)).resolve() if user_gemini.joinpath(*segments).exists() else None
        if src is None or not src.is_dir():
            continue
        dst = prof_gemini.joinpath(*segments)
        if dst.exists() or dst.is_symlink():
            continue
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(dst), str(src)],
                    capture_output=True,
                    check=False,
                    **hidden_process_kwargs(),
                )
            else:
                os.symlink(src, dst, target_is_directory=True)
        except OSError:
            continue


def prepare_profile(profile_id: str) -> Path:
    """Ensure the profile directories and settings exist; return its GEMINI_HOME path."""
    gemini_dir = profile_gemini_dir(profile_id)
    app_dir = profile_app_data_dir(profile_id)
    try:
        if profile_id != DEFAULT:
            home = profile_home(profile_id)
            if home.exists() and home.resolve() != home:
                raise AgyProfileError(409, "Agy 账号目录不得重定向")
            home.mkdir(mode=0o700, parents=True, exist_ok=True)
            gemini_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        app_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        settings_path = app_dir / "settings.json"
        if profile_id != DEFAULT and not settings_path.exists():
            settings_path.write_text(json.dumps({"auth": {"type": "oauth-personal"}}) + "\n", encoding="utf-8")
        sync_user_customizations(profile_id)
        retire_runtime_temp_dirs(profile_runtime_temp_root(profile_id))
    except OSError as exc:
        raise AgyProfileError(503, "无法准备 Agy 账号运行目录") from exc
    return gemini_dir


def clean_agy_env(
    profile_id: str,
    base_env: dict[str, str] | None = None,
    *,
    temp_dir: Path | None = None,
    headless_login: bool = False,
) -> dict[str, str]:
    """Build a sanitized child environment matching T3 Code's antigravityEnvironment."""
    raw = os.environ if base_env is None else base_env
    env = {k: v for k, v in raw.items() if k.upper() not in _REMOVED_ENV_KEYS}
    gemini_dir = profile_gemini_dir(profile_id)
    env.update({
        "GEMINI_HOME": str(gemini_dir),
        "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
        "PYTHONUNBUFFERED": "1",
    })
    if profile_id != DEFAULT or headless_login:
        # Default profile reads OS keyring (Windows Credential Manager on agy 1.5+);
        # isolated profiles and headless code-login must force isolated file storage.
        env["AGY_ACP_FORCE_FILE_STORAGE"] = "1"
    if profile_id != DEFAULT:
        home = profile_home(profile_id)
        env["HOME"] = str(home)
        if os.name == "nt":
            env.update(USERPROFILE=str(home), HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):])
        # Match T3 Code: agy 1.5 stores Google sign-ins in a single shared OS keyring
        # entry unless SSH_CONNECTION is present, which forces isolated file storage.
        env["SSH_CONNECTION"] = raw.get("SSH_CONNECTION") or "127.0.0.1 0 127.0.0.1 0"
    if headless_login:
        env.pop("DISPLAY", None)
        env.pop("WAYLAND_DISPLAY", None)
        env.setdefault("SSH_CONNECTION", raw.get("SSH_CONNECTION") or "127.0.0.1 0 127.0.0.1 0")
    if temp_dir is not None:
        if os.name == "nt":
            env["TEMP"] = str(temp_dir)
            env["TMP"] = str(temp_dir)
        else:
            env["TMPDIR"] = str(temp_dir)
    executable = agy_executable_or_none()
    if executable:
        env["ANTICLI_AGY_PATH"] = executable
    return system_proxy_env(env)


def profile_env(profile_id: str, env: dict[str, str]) -> dict[str, str]:
    """Compatibility wrapper used by existing profile callers and tests."""
    if profile_id == DEFAULT:
        return env.copy()
    if not re.fullmatch(PROFILE_ID, profile_id):
        raise AgyProfileError(404, "找不到 Agy 账号")
    home = profile_home(profile_id)
    try:
        if home.resolve() != home:
            raise AgyProfileError(409, "Agy 账号目录不得重定向")
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as exc:
        raise AgyProfileError(503, "无法创建 Agy 账号目录") from exc
    result = {
        **env,
        "HOME": str(home),
        "GEMINI_HOME": str(home / ".gemini"),
        "AGY_ACP_FORCE_FILE_STORAGE": "1",
        "AGY_CLI_DISABLE_AUTO_UPDATE": "1",
        "SSH_CONNECTION": env.get("SSH_CONNECTION") or "127.0.0.1 0 127.0.0.1 0",
    }
    executable = agy_executable_or_none()
    if executable:
        result["ANTICLI_AGY_PATH"] = executable
    if os.name == "nt":
        result.update(USERPROFILE=str(home), HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):])
    return result


def acp_spawn_command(
    executable: str,
    profile_id: str,
    *,
    add_dirs: list[str] | tuple[str, ...] = (),
    sandbox: bool = False,
    login: bool = False,
) -> list[str]:
    """Build `agy acp` argv matching T3 Code's --gemini-dir + --app-data-dir contract."""
    gemini_dir = profile_gemini_dir(profile_id)
    cmd = [
        executable,
        "acp",
        "--gemini-dir",
        str(gemini_dir),
        "--app-data-dir",
        APP_DATA_DIR_NAME,
    ]
    if login:
        cmd.append("--login")
    if sandbox:
        cmd.append("--sandbox")
    for directory in add_dirs:
        if directory:
            cmd.extend(["--add-dir", directory])
    return cmd


@dataclass
class CodeLoginFlow:
    """Headless `agy acp --login` session (T3 Code's codeLogin pattern)."""

    flow_id: str
    profile_id: str
    process: subprocess.Popen
    temp_dir: Path | None = None
    phase: str = "starting"  # starting | waiting_code | completed | failed | cancelled
    authorization_url: str | None = None
    error: str | None = None
    expires_at: float = field(default_factory=lambda: time.monotonic() + 300.0)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def public_state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "flow_id": self.flow_id,
                "profile_id": self.profile_id,
                "phase": self.phase,
                "authorization_url": self.authorization_url,
                "error": self.error,
            }

    def watch(self) -> None:
        stdout = self.process.stdout
        stderr_lines: list[str] = []

        def _drain_stderr() -> None:
            if self.process.stderr is None:
                return
            try:
                for line in self.process.stderr:
                    text = line.strip()
                    if text:
                        stderr_lines.append(text[:500])
                        if len(stderr_lines) > 20:
                            stderr_lines.pop(0)
            except OSError:
                pass

        t_err = threading.Thread(target=_drain_stderr, daemon=True)
        t_err.start()
        try:
            if stdout is not None:
                for raw in stdout:
                    line = raw.strip()
                    if line.startswith("https://accounts.google.com/"):
                        with self._lock:
                            self.authorization_url = line
                            if self.phase == "starting":
                                self.phase = "waiting_code"
            code = self.process.wait(timeout=15)
        except Exception:
            code = self.process.poll()
        finally:
            child_job.forget(self.process.pid)
            if self.temp_dir is not None:
                shutil.rmtree(self.temp_dir, ignore_errors=True)
        with self._lock:
            if self.phase not in ("cancelled", "failed"):
                if code == 0:
                    self.phase = "completed"
                else:
                    self.phase = "failed"
                    self.error = stderr_lines[-1] if stderr_lines else f"agy 登录退出码 {code}"

    def submit_code(self, response: str) -> None:
        value = response.strip()
        if not value or "\n" in value or "\r" in value:
            raise AgyProfileError(400, "请输入有效的授权码或回调链接")
        with self._lock:
            if self.phase in ("completed", "failed", "cancelled"):
                raise AgyProfileError(409, "登录流程已结束，请重新发起")
        stdin = self.process.stdin
        if stdin is None:
            raise AgyProfileError(503, "登录进程输入通道已关闭")
        try:
            stdin.write(value + "\n")
            stdin.flush()
        except OSError as exc:
            raise AgyProfileError(503, "无法向登录进程提交授权码") from exc

    def cancel(self) -> None:
        with self._lock:
            if self.phase in ("completed", "failed", "cancelled"):
                return
            self.phase = "cancelled"
        child_job.terminate_tree(self.process.pid)
        child_job.forget(self.process.pid)
        if self.temp_dir is not None:
            shutil.rmtree(self.temp_dir, ignore_errors=True)
