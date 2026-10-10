#!/usr/bin/env python3
"""GA-Hub 交付构建链（唯一入口）。

    npm 前端构建 → Python sidecar（PyInstaller）→ Tauri 壳（--no-bundle）
    → 三件产物守卫（缺失 / 为空 / 未被本次构建重写 = 失败）

退出码：0 成功 · 2 预检失败 · 3 阶段失败 · 5 产物守卫失败
用法：
    python scripts/build_all.py                 # 标准交付：便携版两个 exe
    python scripts/build_all.py --full          # 前端构建后追加后端 pytest + 前端 vitest
    python scripts/build_all.py --target <triple>   # 仅 Windows x86_64 实测过
环境变量：
    GA_HUB_PYTHON   sidecar 打包解释器（默认用启动本脚本的解释器）

构建纪律见 docs/BUILD.md；历史上的事故与为什么这样写见
docs/archive/build-chain-incidents-20260927.md。
"""
from __future__ import annotations

import argparse
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = "x86_64-pc-windows-msvc"

EXIT_PREFLIGHT = 2
EXIT_STAGE_FAILED = 3
EXIT_ARTIFACT_GUARD = 5

# 三件交付产物；顺序即守卫与产物体检的报告顺序。值是守卫失败时的排查提示。
ARTIFACT_HINTS = {
    "sidecar 中间产物": "PyInstaller 没有产出新文件（build_sidecar.py 先 unlink 再打包）。",
    "sidecar 交付副本": "Tauri externalBin 拷贝被跳过——产物目录与应用不配套。",
    "主程序产物": "Tauri/cargo 可能跳过了链接，或产物写到了别的 target 目录。",
}


class StageFailed(RuntimeError):
    """某个构建阶段失败。抛异常而不是直接退出，让 main 在失败路径上也报告产物体检。"""

    def __init__(self, stage: str) -> None:
        super().__init__(stage)
        self.stage = stage


# 控制台默认码页（GBK/cp437）编码不了下面用的 ✓/✗/━。模块级固定 UTF-8：argparse 的
# --help、以及把本模块当库调用（测试、排查脚本）都可能发生在 main() 之前。
for _stream in (sys.stdout, sys.stderr):
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def _log(msg: str) -> None:
    print(f"[build_all] {msg}", flush=True)


def _stage(name: str) -> None:
    print(flush=True)
    _log(f"━━ {name} " + "━" * max(0, 58 - len(name)))


def _mb(size: int) -> str:
    return f"{size / (1024 * 1024):.1f} MB"


def run_stage(title: str, cmd: list[str], *, extra_env: dict[str, str] | None = None) -> None:
    """跑一个构建阶段；非零退出抛 StageFailed，链式中止。"""
    _stage(title)
    _log("$ " + " ".join(cmd))
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    if extra_env:
        env.update(extra_env)
    started = time.monotonic()
    # stdin 必须显式 DEVNULL：继承一个被上游悬挂读取的 stdin 管道会让子进程静默卡死。
    result = subprocess.run(cmd, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL)
    elapsed = time.monotonic() - started
    if result.returncode != 0:
        _log(f"✗ {title} 失败（exit {result.returncode}，耗时 {elapsed:.1f}s）— 链式中止")
        raise StageFailed(title)
    _log(f"✓ {title} 完成（{elapsed:.1f}s）")


# ── 环境解析与预检 ──────────────────────────────────────────────────────────


def resolve_sidecar_python() -> str:
    """sidecar 打包解释器：GA_HUB_PYTHON 优先，否则就是启动本脚本的解释器。

    刻意不做静默回退：缺 PyInstaller 时让预检失败并给出修复命令，保证
    「用哪个 python 启动 build_all，就用哪个 python 打包」永远成立。
    """
    return os.environ.get("GA_HUB_PYTHON", "").strip() or sys.executable or "python"


def resolve_npm() -> str:
    for name in ("npm", "npm.cmd"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def resolve_tauri() -> str:
    """定位仓库内 tauri CLI；绕开 npm 脚本层（避免递归与解析歧义）。"""
    bindir = ROOT / "node_modules" / ".bin"
    names = ("tauri.cmd", "tauri") if os.name == "nt" else ("tauri",)
    for name in names:
        candidate = bindir / name
        if candidate.is_file():
            return str(candidate)
    return ""


def _has_pyinstaller(python: str) -> bool:
    try:
        probe = subprocess.run(
            [python, "-c", "import PyInstaller"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return probe.returncode == 0


def _msvc_arch(target: str) -> str:
    arch = target.split("-", 1)[0]
    try:
        return {"x86_64": "x64", "i686": "x86", "aarch64": "arm64"}[arch]
    except KeyError:
        raise RuntimeError(f"不支持自动初始化的 MSVC target：{target}") from None


def _msvc_ready(env: dict[str, str], arch: str) -> bool:
    """不能仅凭 PATH 有 link 判定：GNU link、错架构、缺 SDK 都不能构建。"""
    values = {key.upper(): value for key, value in env.items()}
    if values.get("VSCMD_ARG_TGT_ARCH", "").lower() != arch:
        return False
    vc = values.get("VCTOOLSINSTALLDIR", "")
    sdk = values.get("WINDOWSSDKDIR", "")
    if not vc or not sdk or not values.get("INCLUDE") or not values.get("LIB"):
        return False
    for tool, root in (("cl.exe", vc), ("link.exe", vc), ("rc.exe", sdk)):
        found = shutil.which(tool, path=values.get("PATH", ""))
        if not found or not Path(found).resolve().is_relative_to(Path(root).resolve()):
            return False
    libdirs = [Path(part) for part in values["LIB"].split(";") if part]
    return all(any((directory / name).is_file() for directory in libdirs)
               for name in ("kernel32.lib", "ucrt.lib", "libcmt.lib"))


def _vcvars_candidates() -> list[Path]:
    """vswhere 失败/空结果仍回退标准 VS2017+ 目录，不依赖 Everything。"""
    override = os.environ.get("GA_HUB_VCVARSALL", "").strip()
    if override:
        path = Path(override)
        if not path.is_file():
            raise RuntimeError(f"GA_HUB_VCVARSALL 指定的文件不存在：{path}")
        return [path]
    candidates: list[Path] = []
    program_roots = list(dict.fromkeys(filter(None, (
        os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
        r"C:\Program Files", r"C:\Program Files (x86)",
    ))))
    where = shutil.which("vswhere.exe")
    if not where:
        where = next((str(Path(root) / "Microsoft Visual Studio/Installer/vswhere.exe")
                      for root in program_roots
                      if (Path(root) / "Microsoft Visual Studio/Installer/vswhere.exe").is_file()), None)
    if where:
        try:
            result = subprocess.run(
                [where, "-all", "-products", "*", "-prerelease", "-utf8", "-property", "installationPath"],
                capture_output=True, encoding="utf-8", errors="replace",
                stdin=subprocess.DEVNULL, timeout=15,
            )
            if result.returncode == 0:
                candidates.extend(Path(line.strip()) / "VC/Auxiliary/Build/vcvarsall.bat"
                                  for line in result.stdout.splitlines() if line.strip())
        except (OSError, subprocess.TimeoutExpired):
            pass
    for root in program_roots:
        base = Path(root) / "Microsoft Visual Studio"
        if base.is_dir():
            candidates.extend(sorted(base.glob("*/*/VC/Auxiliary/Build/vcvarsall.bat"), reverse=True))
    return list(dict.fromkeys(path for path in candidates if path.is_file()))


def _load_msvc_env(script: Path, arch: str) -> dict[str, str]:
    """cmd /u 的 set 输出是 UTF-16；不受系统 GBK/UTF-8 码页或路径空格影响。"""
    env = dict(os.environ)
    env["GA_HUB_VCVARS_SCRIPT"] = str(script)
    host = env.get("PROCESSOR_ARCHITEW6432", env.get("PROCESSOR_ARCHITECTURE", "AMD64")).upper()
    host_arch = {"AMD64": "x64", "ARM64": "arm64", "X86": "x86"}.get(host, "x64")
    argument = arch if host_arch == arch else f"{host_arch}_{arch}"
    marker = "__GA_HUB_MSVC_ENV__"
    command = f'call "%GA_HUB_VCVARS_SCRIPT%" {argument} >nul && echo {marker} && set'
    result = subprocess.run(
        # Windows list2cmdline 会把嵌套双引号变成 \"\\\"\"，cmd 不认识该转义。
        # 这里明确使用 cmd 原生命令行；脚本路径通过环境变量传递。
        f'"{env.get("COMSPEC", "cmd.exe")}" /d /u /v:off /s /c "{command}"',
        env=env, capture_output=True, stdin=subprocess.DEVNULL, timeout=90,
    )
    output = result.stdout.decode("utf-16-le", errors="replace")
    if result.returncode or marker not in (line.strip() for line in output.splitlines()):
        diagnostic = result.stderr.decode("utf-16-le", errors="replace")[-1200:]
        raise RuntimeError(f"vcvarsall 初始化失败（exit {result.returncode}）：{script}\n{diagnostic}")
    loaded: dict[str, str] = {}
    for line in output.split(marker, 1)[1].splitlines():
        key, sep, value = line.partition("=")
        if sep and key and key != "GA_HUB_VCVARS_SCRIPT":
            loaded[key] = value
    return loaded


def ensure_msvc_environment(target: str) -> None:
    """只修改当前构建进程的环境；所有 run_stage 子进程自动继承。"""
    if os.name != "nt" or not target.endswith("-windows-msvc"):
        return
    arch = _msvc_arch(target)
    override = os.environ.get("GA_HUB_VCVARSALL", "").strip()
    if not override and _msvc_ready(dict(os.environ), arch):
        _log(f"✓ MSVC/SDK 环境已就绪（{arch}）")
        return
    failures: list[str] = []
    for script in _vcvars_candidates():
        try:
            loaded = _load_msvc_env(script, arch)
            if not _msvc_ready(loaded, arch):
                raise RuntimeError("初始化后仍缺少匹配架构的 cl/link、Windows SDK 或系统/C运行库")
        except (OSError, subprocess.TimeoutExpired, RuntimeError) as exc:
            failures.append(f"{script}: {exc}")
            continue
        os.environ.update(loaded)
        _log(f"✓ 已自动加载 MSVC/SDK（{arch}）：{script}")
        return
    raise RuntimeError(
        "MSVC/Windows SDK 环境不可用。安装 VS2017+ 的“使用 C++ 的桌面开发”及 Windows SDK，"
        "或设置 GA_HUB_VCVARSALL 指向 VC\\Auxiliary\\Build\\vcvarsall.bat。\n"
        + "\n".join(failures)
    )


def preflight(
    sidecar_python: str,
    npm: str,
    tauri: str,
    *,
    ga_root: Path | None = None,
    target: str = DEFAULT_TARGET,
) -> None:
    """环境预检：缺什么都在这里以 2 退出，而不是让某个阶段以 3 失败。

    ``ga_root`` 只在 ``--full`` 时传入（后端测试要注入 GA_ROOT/PYTHONPATH）。
    """
    _stage("预检")
    problems: list[str] = []
    try:
        ensure_msvc_environment(target)
    except RuntimeError as exc:
        problems.append(str(exc))
    if not npm:
        problems.append("未找到 npm —— 请安装 Node.js 18+ 并确保 npm 在 PATH 中")
    if not tauri:
        problems.append("node_modules 缺少 tauri CLI —— 先在仓库根执行 npm ci")
    if shutil.which("cargo") is None:
        problems.append(
            "未找到 cargo —— 请安装 Rust 工具链（https://rustup.rs）；"
            "Windows 还需 MSVC Build Tools"
        )
    if not (ROOT / "webui").is_dir():
        problems.append("缺少 webui/ 目录")
    if not (ROOT / "webui" / "node_modules").is_dir():
        problems.append("webui 依赖未安装 —— 先执行 npm ci --prefix webui")
    if ga_root is not None and not ga_root.is_dir():
        problems.append(
            f"--full 需要 GA 仓库（给测试注入 GA_ROOT/PYTHONPATH），但 {ga_root} 不存在\n"
            "  设置 GA_ROOT 指向 GA 仓库，或把它克隆到本仓库的同级目录"
        )
    if not _has_pyinstaller(sidecar_python):
        problems.append(
            f"解释器缺少 PyInstaller：{sidecar_python}\n"
            "  修复任选其一：\n"
            "    1) 用 build_all.bat 运行（自动选择本机已配置的构建解释器）\n"
            "    2) 设置 GA_HUB_PYTHON 指向已装依赖的解释器\n"
            f"    3) 执行：\"{sidecar_python}\" -m pip install -r requirements.txt"
        )
    if problems:
        for problem in problems:
            _log("✗ " + problem)
        raise SystemExit(EXIT_PREFLIGHT)
    _log(f"npm        = {npm}")
    _log(f"tauri      = {tauri}")
    _log(f"sidecar py = {sidecar_python}")
    _log("✓ 预检通过")


# ── 产物路径、占用检查、守卫 ────────────────────────────────────────────────


def tauri_stage_command(tauri: str, target: str) -> list[str]:
    """Tauri 构建命令；Windows 下 .cmd 需经 cmd /c 才能直接执行。

    恒传 ``--no-bundle``：交付物只有便携版两个 exe，安装包不在本链职责内。
    """
    command = [tauri, "build", "--target", target, "--no-bundle"]
    if os.name == "nt" and tauri.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", *command]
    return command


def artifact_paths(target: str) -> dict[str, Path]:
    """三件交付产物：label -> 路径。"""
    suffix = ".exe" if "windows" in target else ""
    release = ROOT / "src-tauri" / "target" / target / "release"
    return {
        "sidecar 中间产物": ROOT / "src-tauri" / "binaries" / f"ga-hub-sidecar-{target}{suffix}",
        "sidecar 交付副本": release / f"ga-hub-sidecar{suffix}",
        "主程序产物": release / f"ga-hub-desktop{suffix}",
    }


def artifact_blocker(path: Path) -> str:
    """产物现在能不能被替换：``""`` = 可以；否则返回给使用者看的原因。

    运行中的映像被写方式打开，实测只抛 PermissionError(errno 13) 且没有 winerror；
    只读产物同样报 EACCES，所以用只读属性区分「应用没退出」与「文件不可写」。
    """
    if not path.is_file():
        return ""
    try:
        with open(path, "r+b"):
            return ""
    except OSError:
        try:
            writable = bool(path.stat().st_mode & stat.S_IWRITE)
        except OSError:
            writable = False
        if writable:
            return (
                f"{path.name} 正被运行中的进程占用 —— 先退出 GA-Hub（含托盘/后台 "
                "sidecar）再构建；若确认已退出仍报占用，稍后重试（杀毒软件扫描会短暂持有文件）。"
            )
        return f"{path.name} 没有写权限（只读属性？）—— 先 attrib -r（或直接删掉）再重试。"


def _snapshot(path: Path) -> tuple[int, int] | None:
    if not path.is_file():
        return None
    stat_result = path.stat()
    return (stat_result.st_mtime_ns, stat_result.st_size)


def _refreshed(path: Path, before: tuple[int, int] | None) -> bool:
    """本次构建是否重写了该产物（mtime/size 有变化，或构建前根本不存在）。

    正常链里三件产物必然被重写：前端每次都重写 webui/dist，Tauri 因此必然重链；
    sidecar 先 unlink 再打包。「未重写」只可能是写到了别处或这一步被跳过。
    """
    if before is None:
        return path.is_file()
    return _snapshot(path) != before


def check_artifact(label: str, path: Path, before: tuple[int, int] | None) -> int:
    """产物守卫：缺失 / 为空 / 未被本次构建重写 → 5。"""
    if not path.is_file():
        _log(f"✗ {label}缺失：{path}")
        _log(f"  {ARTIFACT_HINTS[label]}")
        return EXIT_ARTIFACT_GUARD
    size = path.stat().st_size
    if size <= 0:
        _log(f"✗ {label}为空文件：{path}")
        return EXIT_ARTIFACT_GUARD
    if not _refreshed(path, before):
        _log(f"✗ {label}未被本次构建重写：{path}")
        _log(f"  {ARTIFACT_HINTS[label]}")
        _log("  交付上一次的旧产物没有意义——先查清这一步为什么没有产出新文件。")
        return EXIT_ARTIFACT_GUARD
    _log(f"✓ {label}已刷新：{path} ({_mb(size)})")
    return 0


def report_consistency(
    paths: dict[str, Path], before: dict[str, tuple[int, int] | None]
) -> None:
    """阶段失败后的产物体检：说清磁盘上现在是哪一套产物（只报告，退出码仍是 3）。

    守卫只覆盖成功路径，而「主 exe 是上一次的、sidecar 已是这一次的」正是中断留下
    的典型形态——不报告出来就会被当成交付物。
    """
    _stage("产物一致性体检（阶段失败后）")
    fresh: list[str] = []
    stale: list[str] = []
    missing: list[str] = []
    for label, path in paths.items():
        if not path.is_file():
            missing.append(label)
            _log(f"  ✗ {label}：不存在")
        elif _refreshed(path, before[label]):
            fresh.append(label)
            _log(f"  ✓ {label}：本次已重写（{_mb(path.stat().st_size)}）")
        else:
            stale.append(label)
            _log(f"  · {label}：仍是构建前的版本")
    if not fresh:
        _log("本次没有写入任何产物：磁盘上仍是上一套交付，可放心排查后重跑。")
    elif stale or missing:
        _log("⚠ 产物集不配套：本次只刷新了一部分 —— 不要把这几件当交付物；")
        _log("  修好失败原因后重跑构建（守卫要求三件产物被同一次构建重写）。")
    else:
        _log("三件产物都是本次产出（失败发生在写产物之后），修好原因后重跑复核。")


# ── 并发锁 ─────────────────────────────────────────────────────────────────


def build_lock_path() -> Path:
    return ROOT / "src-tauri" / "target" / ".build_all.lock"


def acquire_build_lock() -> tuple[object | None, str]:
    """跨进程构建互斥；并发构建会互踩 target 目录。

    成功返回 (handle, "pid=… · path")（句柄要活到构建结束，锁随进程退出释放）；
    已被持有时返回 (None, "holder pid=… · path")。
    """
    path = build_lock_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+", encoding="utf-8")
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            handle.seek(0)
            holder = handle.read().strip()
        except OSError:
            holder = ""
        handle.close()
        if holder:
            return None, f"holder pid={holder} · {path}"
        return None, f"另一个构建进程持有锁（pid 不可读）· {path}"
    handle.seek(0)
    handle.truncate()
    handle.write(f"{os.getpid()}\n")
    handle.flush()
    return handle, f"pid={os.getpid()} · {path}"


# ── 主流程 ─────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--target",
        default=DEFAULT_TARGET,
        help="Rust target triple（目前只有 x86_64-pc-windows-msvc 实测过）",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="先跑后端 pytest（tests/）与前端 vitest，再进入构建阶段",
    )
    args = parser.parse_args(argv)
    started = time.monotonic()

    handle, lock_desc = acquire_build_lock()
    if handle is None:
        _log("✗ 已有另一个构建在进行（并发构建会互踩 src-tauri/target）")
        _log(f"  {lock_desc}")
        return EXIT_PREFLIGHT
    _log(f"✓ 构建锁已获取（{lock_desc}）")

    npm = resolve_npm()
    tauri = resolve_tauri()
    sidecar_python = resolve_sidecar_python()
    # --full 的后端测试需要 GA_ROOT/PYTHONPATH 指向 GA 核心仓库
    ga_root = Path(os.environ.get("GA_ROOT", str(ROOT.parent / "GA"))).resolve()
    preflight(sidecar_python, npm, tauri, ga_root=ga_root if args.full else None, target=args.target)

    paths = artifact_paths(args.target)
    for path in paths.values():
        blocker = artifact_blocker(path)
        if blocker:
            _log("✗ " + blocker)
            return EXIT_PREFLIGHT
    before = {label: _snapshot(path) for label, path in paths.items()}

    try:
        # 顺序纪律：前端构建必须排在 --full 的后端测试之前。
        # test_built_spa_deep_link_and_hashed_entry_asset 需要 webui/dist 的 hashed 入口，
        # 而 dist 正是下面这条命令的产物——测试先行会在新克隆上因 dist 缺失而 404，
        # 使 --full 永远走不到本该补上 dist 的这一步（自锁）。check.bat 早已按此顺序。
        run_stage("前端生产构建", [npm, "--prefix", "webui", "run", "build"])
        if args.full:
            test_env = {"GA_ROOT": str(ga_root), "PYTHONPATH": str(ga_root)}
            run_stage(
                "后端测试",
                [sidecar_python, "-m", "pytest", "tests/", "-q"],
                extra_env=test_env,
            )
            run_stage("前端测试", [npm, "--prefix", "webui", "test", "--", "--run"])
        run_stage(
            "Python sidecar",
            [sidecar_python, "desktop/build_sidecar.py", "--target", args.target],
        )
        run_stage("Tauri 桌面壳", tauri_stage_command(tauri, args.target))
    except StageFailed:
        report_consistency(paths, before)
        return EXIT_STAGE_FAILED

    _stage("产物守卫")
    for label, path in paths.items():
        code = check_artifact(label, path, before[label])
        if code:
            return code

    _log(f"✓ 构建链全部通过（总耗时 {time.monotonic() - started:.1f}s）")
    _log("  交付物：src-tauri/target/<triple>/release/ 下的 ga-hub-desktop 与 ga-hub-sidecar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
