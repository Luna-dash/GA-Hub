#!/usr/bin/env python3
"""GA-Hub 一键交付构建链。

把 project_memory 约定的三步人肉命令固化为一条命令：

    1. 前端生产构建      npm --prefix webui run build
    2. Python sidecar    <python> desktop/build_sidecar.py --target <triple>
    3. Tauri 桌面壳      npm run desktop:build -- --target <triple>
    4. 产物守卫          断言 ga-hub-desktop.exe 已被原位刷新

任何一步失败立即中止并保留前序日志。产物守卫对比构建前后的 mtime/size，
防止"构建成功但产物没有刷新"的静默失效——桌面快捷方式固定指向该文件，
这是最危险的失败模式。

用法：
    python scripts/build_all.py                 # 标准交付
    python scripts/build_all.py --full          # 先跑后端 pytest + 前端 vitest
    python scripts/build_all.py --target aarch64-apple-darwin

环境变量：
    GA_HUB_PYTHON   sidecar 构建使用的解释器（默认依次探测
                    D:\\APP\\anaconda3\\envs\\ga\\python.exe → 当前解释器）
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = "x86_64-pc-windows-msvc"
_CONDA_GA_PYTHON = Path(r"D:\APP\anaconda3\envs\ga\python.exe")

EXIT_PREFLIGHT = 2
EXIT_STAGE_FAILED = 3
EXIT_ARTIFACT_GUARD = 5


def _log(msg: str) -> None:
    print(f"[build_all] {msg}", flush=True)


def _force_utf8_stdio() -> None:
    """Windows consoles default to a legacy codepage (GBK/cp936) that cannot
    encode the ✓/✗/━ glyphs used below; pin UTF-8 with replacement fallback."""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


def _stage(name: str) -> None:
    print(flush=True)
    _log(f"━━ {name} " + "━" * max(0, 58 - len(name)))


def resolve_sidecar_python() -> str:
    env = os.environ.get("GA_HUB_PYTHON", "").strip()
    if env:
        return env
    if _CONDA_GA_PYTHON.is_file():
        return str(_CONDA_GA_PYTHON)
    return sys.executable or "python"


def resolve_npm() -> str:
    for name in ("npm", "npm.cmd"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def run_stage(title: str, cmd: list[str]) -> float:
    """Run one build stage, streaming output; abort the chain on failure."""
    _stage(title)
    _log("$ " + " ".join(cmd))
    started = time.monotonic()
    result = subprocess.run(cmd, cwd=str(ROOT))
    elapsed = time.monotonic() - started
    if result.returncode != 0:
        _log(f"✗ {title} 失败（exit {result.returncode}，耗时 {elapsed:.1f}s）— 链式中止")
        raise SystemExit(EXIT_STAGE_FAILED)
    _log(f"✓ {title} 完成（{elapsed:.1f}s）")
    return elapsed


def artifact_path(target: str) -> Path:
    suffix = ".exe" if "windows" in target else ""
    return ROOT / "src-tauri" / "target" / target / "release" / f"ga-hub-desktop{suffix}"


def preflight(sidecar_python: str, npm: str) -> None:
    _stage("预检")
    problems: list[str] = []
    if not npm:
        problems.append("未找到 npm —— 请安装 Node.js 18+ 并确保 npm 在 PATH 中")
    if not (ROOT / "webui").is_dir():
        problems.append("缺少 webui/ 目录")
    probe = subprocess.run(
        [sidecar_python, "-c", "import PyInstaller"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    if probe.returncode != 0:
        problems.append(
            f"解释器缺少 PyInstaller：{sidecar_python}\n"
            f"  先执行：\"{sidecar_python}\" -m pip install pyinstaller"
        )
    if problems:
        for problem in problems:
            _log("✗ " + problem)
        raise SystemExit(EXIT_PREFLIGHT)
    _log(f"npm       = {npm}")
    _log(f"sidecar py = {sidecar_python}")
    _log("✓ 预检通过")


def artifact_guard(path: Path, before: tuple[int, int] | None) -> int:
    _stage("产物守卫")
    if not path.is_file():
        _log(f"✗ 产物不存在：{path}")
        return EXIT_ARTIFACT_GUARD
    stat = path.stat()
    after = (stat.st_mtime_ns, stat.st_size)
    if before is not None and after == before:
        _log(f"✗ 产物未刷新（mtime/size 与构建前一致）：{path}")
        _log("  Tauri 可能跳过了链接阶段——检查是否构建到了其他 target 目录")
        return EXIT_ARTIFACT_GUARD
    _log(f"✓ 产物已刷新：{path}")
    _log(f"  大小 {stat.st_size / (1024 * 1024):.1f} MB · mtime {time.strftime('%H:%M:%S', time.localtime(stat.st_mtime))}")
    _log("桌面快捷方式指向该文件，可直接使用。")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", default=DEFAULT_TARGET, help="Rust target triple")
    parser.add_argument("--full", action="store_true", help="先跑后端 pytest 与前端 vitest")
    args = parser.parse_args(argv)

    _force_utf8_stdio()
    overall_started = time.monotonic()
    npm = resolve_npm()
    sidecar_python = resolve_sidecar_python()
    preflight(sidecar_python, npm)

    artifact = artifact_path(args.target)
    before: tuple[int, int] | None = None
    if artifact.is_file():
        stat = artifact.stat()
        before = (stat.st_mtime_ns, stat.st_size)

    python = shutil.which("python") or "python"

    if args.full:
        run_stage("后端测试", [python, "-m", "pytest", "-q"])
        run_stage("前端测试", [npm, "--prefix", "webui", "test", "--", "--run"])

    run_stage("前端生产构建", [npm, "--prefix", "webui", "run", "build"])
    run_stage(
        "Python sidecar",
        [sidecar_python, "desktop/build_sidecar.py", "--target", args.target],
    )
    run_stage(
        "Tauri 桌面壳",
        [npm, "run", "desktop:build", "--", "--target", args.target],
    )

    code = artifact_guard(artifact, before)
    _log(f"总耗时 {time.monotonic() - overall_started:.1f}s")
    return code


if __name__ == "__main__":
    raise SystemExit(main())
