"""Local agy profiles. Only agy itself reads or writes login credentials."""
from __future__ import annotations

import json
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile
from uuid import uuid4

from .. import _paths
from .anti_engine import AntiError

DEFAULT = "default"
PROFILE_ID = r"(?:default|[0-9a-f]{32})"


@dataclass(frozen=True)
class Profile:
    id: str
    name: str


def _root() -> Path:
    return _paths.ADMIN_DATA / "agy-profiles"


def _load() -> tuple[str, list[Profile]]:
    default = Profile(DEFAULT, "系统默认")
    try:
        raw = json.loads((_root() / "profiles.json").read_text(encoding="utf-8"))
        profiles = [default, *(Profile(**item) for item in raw["profiles"])]
        active = raw["active"]
        ids = {p.id for p in profiles}
        if (len(ids) != len(profiles) or active not in ids or
                any(not re.fullmatch(PROFILE_ID, p.id) or not isinstance(p.name, str) for p in profiles)):
            raise ValueError("Invalid profile metadata")
        return active, profiles
    except FileNotFoundError:
        return DEFAULT, [default]
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise AntiError(503, "无法读取 Agy 账号设置") from exc


def snapshot() -> tuple[str, list[Profile]]:
    return _load()


def _save(active: str, profiles: list[Profile]) -> None:
    path = _root() / "profiles.json"
    stage = None
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as file:
            stage = Path(file.name)
            json.dump({"active": active, "profiles": [vars(item) for item in profiles if item.id != DEFAULT]},
                      file, ensure_ascii=False)
        stage.replace(path)
    except OSError as exc:
        raise AntiError(503, "无法保存 Agy 账号设置") from exc
    finally:
        if stage is not None:
            stage.unlink(missing_ok=True)


def add(name: str) -> Profile:
    active, profiles = _load()
    if any(p.name.casefold() == name.casefold() for p in profiles):
        raise AntiError(409, "已有同名 Agy 账号")
    profile = Profile(uuid4().hex, name)
    _save(active, [*profiles, profile])
    return profile


def rename(profile_id: str, name: str) -> Profile:
    active, profiles = _load()
    if not any(p.id == profile_id for p in profiles):
        raise AntiError(404, "找不到 Agy 账号")
    if profile_id == DEFAULT:
        raise AntiError(409, "系统默认账号不能修改备注")
    if any(p.id != profile_id and p.name.casefold() == name.casefold() for p in profiles):
        raise AntiError(409, "已有同名 Agy 账号")
    renamed = Profile(profile_id, name)
    _save(active, [renamed if p.id == profile_id else p for p in profiles])
    return renamed


def select(profile_id: str) -> None:
    active, profiles = _load()
    if not any(p.id == profile_id for p in profiles):
        raise AntiError(404, "找不到 Agy 账号")
    if active != profile_id:
        _save(profile_id, profiles)


def agy_executable() -> str:
    name = "agy.exe" if os.name == "nt" else "agy"
    candidates = (os.environ.get("ANTICLI_AGY_PATH"), shutil.which(name),
                  str(Path.home() / ".gemini" / "bin" / name))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(Path(candidate).resolve())
    raise AntiError(503, "找不到官方 agy CLI，请先安装")


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
