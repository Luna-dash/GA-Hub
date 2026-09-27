"""仓根卫生：散件不许堆在仓根（架构复审问题 9）。

两条规矩，都由这个文件守：

1. 仓根不得有「未跟踪且未被忽略」的条目 —— 过程产物进 `temp/`，一次性报告进
   `docs/archive/`。
2. 仓根的**已跟踪文件**必须与下面的 `ROOT_FILES` 白名单一致 —— 「加一个根目录文件」
   应该是一个决定，而不是顺手的事。

为什么用测试守：2026-09-23 的仓库卫生审查把当时那批散件**逐条写进 .gitignore**，
两天后又长出 32 条（09-24 新增 19 条、09-25 新增 13 条）。命名式 ignore 是快照，
护栏才是机制 —— 和问题 7「规矩由测试守」同一个道理。
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

# 仓根允许存在的已跟踪文件。新增/改名时请连这里一起改（否则本文件会红）。
ROOT_FILES = {
    ".gitignore",
    "AGENTS.md",
    "README.md",
    "build_all.bat",
    "build_all.command",
    "check.bat",
    "check.sh",
    "install_webui.bat",
    "install_webui.sh",
    "package-lock.json",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "start.bat",
    "start.command",
    "start_hidden.vbs",
}

# 允许留在仓根的未跟踪条目。当前为空：一切都该被跟踪，或被 .gitignore 忽略。
ALLOWED_UNTRACKED_AT_ROOT: set[str] = set()

pytestmark = pytest.mark.skipif(
    shutil.which("git") is None, reason="仓根卫生检查需要 git"
)

_UNTRACKED_HINT = (
    "仓根出现了未跟踪散件：{offenders}\n"
    "  · 过程产物（探针脚本 / 结果快照 / diff 文本 / 截图 / 分析目录）→ 放进 temp/（已忽略）\n"
    "  · 一次性报告（诊断 / 审查 / 实验记录）→ 归档到 docs/archive/，命名 kebab-case-YYYYMMDD.md，"
    "并同步修引用链（否则断链）\n"
    "  · 确有必要留在仓根 → 把名字加进本文件 ALLOWED_UNTRACKED_AT_ROOT 并说明理由\n"
    "背景见 docs/BACKLOG.md 的问题 9 记录。"
)

_TRACKED_HINT = (
    "仓根已跟踪文件与白名单不一致：多出 {added}，缺失 {removed}\n"
    "  · 新增根目录文件 → 同时更新本文件 ROOT_FILES（让「加根目录文件」是个决定）\n"
    "  · 搬走/改名 → 也要同步，否则白名单过期，这个护栏就失灵了"
)


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    ).stdout


def _root_untracked() -> list[str]:
    """仓根未跟踪、且未被忽略的条目（目录会以 name/ 折叠，这里归一化）。"""
    out = _git("ls-files", "--others", "--exclude-standard", "--directory")
    names = {line.strip().rstrip("/") for line in out.splitlines() if line.strip()}
    # 只关心仓根：带 "/" 的是子目录里的条目，不是这个护栏的目标
    return sorted(name for name in names if "/" not in name)


def test_root_has_no_untracked_clutter() -> None:
    offenders = [n for n in _root_untracked() if n not in ALLOWED_UNTRACKED_AT_ROOT]
    assert not offenders, _UNTRACKED_HINT.format(offenders=offenders)


def test_root_tracked_files_are_deliberate() -> None:
    tracked = {p for p in _git("ls-files").splitlines() if p and "/" not in p}
    added = sorted(tracked - ROOT_FILES)
    removed = sorted(ROOT_FILES - tracked)
    assert not added and not removed, _TRACKED_HINT.format(added=added, removed=removed)
