#!/usr/bin/env python3
"""GA-Hub 一键交付构建链（唯一构建入口；CI 与本地同源）。

把交付所需全部步骤固化为一条命令：

    1. 前端生产构建      npm --prefix webui run build
    2. Python sidecar    <sidecar_python> desktop/build_sidecar.py --target <triple>
    3. Tauri 桌面壳      node_modules/.bin/tauri build --target <triple>
    4. 产物守卫          主 exe / sidecar 中间产物 / sidecar 交付副本 三重校验
    5. 泄漏检测          host-target（target/release）被生成/刷新时告警（不阻断）

不变式（与 docs/BUILD.md「构建纪律与验收」互为镜像，改动须同步两边）：

    - 唯一入口：build_all.bat（Windows）/ build_all.command（macOS）/
      python scripts/build_all.py。npm run desktop:build 已改为拒绝式。
      裸 tauri build 的产物会落到非正式区（已两次污染仓库）。
    - 解释器：GA_HUB_PYTHON 显式指定 > 启动本脚本的解释器（sys.executable）。
      不做静默回退；缺依赖时预检失败并给出修复命令。
    - 并发与占用：写锁 src-tauri/target/.build_all.lock 挡并发构建；预检检测
      GA-Hub 运行中占用（产物文件锁）时直接失败。
    - 子进程一律 stdin=DEVNULL：继承被悬挂读取的 stdin 管道会静默卡死子进程
      （2026-09-24 stdin 探针系列事故同源）。

退出码：2 = 预检失败（缺工具/依赖/应用未退出/并发构建）
        3 = 某个构建阶段失败
        5 = 产物守卫失败（缺失 / 为空 / 构建遗漏）

用法：
    python scripts/build_all.py                 # 标准交付
    python scripts/build_all.py --full          # 先跑后端 pytest + 前端 vitest
    python scripts/build_all.py --target aarch64-apple-darwin

环境变量：
    GA_HUB_PYTHON   sidecar 打包解释器；未设置时用启动本脚本的解释器。

通用性约定：
    - 所有路径由 __file__ 推导，仓库放任何位置都能构建
    - 依赖一次性写入 requirements.txt，pip install -r 后即可构建
    - 完全没有环境的机器用 GitHub Actions
      （.github/workflows/desktop-build.yml，云端步骤与本脚本相同）
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TARGET = "x86_64-pc-windows-msvc"

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


def run_stage(title: str, cmd: list[str], *, extra_env: dict[str, str] | None = None) -> float:
    """Run one build stage, streaming output; abort the chain on failure."""
    _stage(title)
    _log("$ " + " ".join(cmd))
    # Windows 控制台默认 GBK，子进程输出含 ✓ 或中文时会炸编码——全链路统一 UTF-8
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    if extra_env:
        env.update(extra_env)
    started = time.monotonic()
    # stdin 必须显式 DEVNULL：若继承的 stdin 管道被上游悬挂读取，子进程会静默卡死
    # （2026-09-24 stdin 探针系列事故同源）。
    result = subprocess.run(cmd, cwd=str(ROOT), env=env, stdin=subprocess.DEVNULL)
    elapsed = time.monotonic() - started
    if result.returncode != 0:
        _log(f"✗ {title} 失败（exit {result.returncode}，耗时 {elapsed:.1f}s）— 链式中止")
        raise SystemExit(EXIT_STAGE_FAILED)
    _log(f"✓ {title} 完成（{elapsed:.1f}s）")
    return elapsed


def resolve_sidecar_python() -> str:
    """sidecar 打包解释器：显式 GA_HUB_PYTHON → 启动本脚本的解释器。

    不做静默回退：缺依赖时交给预检失败并给出修复命令，保证
    「用哪个 python 启动 build_all，就用哪个 python 打包」永远成立。
    """
    env = os.environ.get("GA_HUB_PYTHON", "").strip()
    if env:
        return env
    return sys.executable or "python"


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


def resolve_npm() -> str:
    for name in ("npm", "npm.cmd"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def resolve_tauri() -> str:
    """定位仓库内 tauri CLI；彻底绕开 npm 脚本层（避免递归与解析歧义）。"""
    bindir = ROOT / "node_modules" / ".bin"
    names = ("tauri.cmd", "tauri") if os.name == "nt" else ("tauri",)
    for name in names:
        candidate = bindir / name
        if candidate.is_file():
            return str(candidate)
    return ""


def tauri_stage_command(tauri: str, target: str) -> list[str]:
    """构造 Tauri 构建命令；Windows 下 .cmd 需经 cmd /c 才能直接执行。"""
    command = [tauri, "build", "--target", target]
    if os.name == "nt" and tauri.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", *command]
    return command


def artifact_path(target: str) -> Path:
    suffix = ".exe" if "windows" in target else ""
    return ROOT / "src-tauri" / "target" / target / "release" / f"ga-hub-desktop{suffix}"


def delivery_sidecar_path(target: str) -> Path:
    """sidecar 交付副本（Tauri externalBin 拷贝落点，必须与主 exe 同目录）。"""
    suffix = ".exe" if "windows" in target else ""
    return ROOT / "src-tauri" / "target" / target / "release" / f"ga-hub-sidecar{suffix}"


def sidecar_artifact_path(target: str) -> Path:
    """sidecar 中间产物（PyInstaller 输出 + Tauri 的 externalBin 输入）。"""
    suffix = ".exe" if "windows" in target else ""
    return ROOT / "src-tauri" / "binaries" / f"ga-hub-sidecar-{target}{suffix}"


def host_target_artifact_path() -> Path:
    """无 --target 的裸构建（host triple）落点：src-tauri/target/release/。

    正式链只使用 target/<triple>/release/（见 docs/BUILD.md）；此路径仅用于
    防复发检测（2026-09-23 审查 §2.1 方案 b——第二次复发后的加固）。
    """
    suffix = ".exe" if os.name == "nt" else ""
    return ROOT / "src-tauri" / "target" / "release" / f"ga-hub-desktop{suffix}"


def build_lock_path() -> Path:
    return ROOT / "src-tauri" / "target" / ".build_all.lock"


def acquire_build_lock() -> tuple[object | None, str]:
    """跨进程构建互斥（src-tauri/target/.build_all.lock）。

    成功返回 (handle, "pid=... · path")；锁被他人持有时返回
    (None, "holder pid=... · path")。锁随进程退出自动释放；并发构建会互踩
    target 目录，必须尽早挡住。
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
            # Windows 区域锁连读都会被拒绝——拿不到 pid 就直接报告占用
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


def _snapshot(path: Path) -> tuple[int, int] | None:
    if not path.is_file():
        return None
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size)


def _same_snapshot(path: Path, before: tuple[int, int] | None) -> bool:
    if before is None or not path.is_file():
        return False
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size) == before


def _sha256(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _newest_input_mtime() -> float:
    """主 exe 构建输入的最新 mtime（区分「增量复用」与「构建遗漏」）。

    输入 = src-tauri/src/**、webui/dist/**（内嵌前端；cargo rerun-if-changed
    已覆盖每个 dist 文件——2026-09-26 实测 build script 输出）、tauri.conf.json、
    Cargo.toml、build.rs。
    """
    newest = 0.0
    for relative in ("src-tauri/src", "webui/dist"):
        root = ROOT / relative
        if not root.is_dir():
            continue
        for item in root.rglob("*"):
            if item.is_file():
                try:
                    newest = max(newest, item.stat().st_mtime)
                except OSError:
                    continue
    for relative in ("src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/build.rs"):
        item = ROOT / relative
        if item.is_file():
            try:
                newest = max(newest, item.stat().st_mtime)
            except OSError:
                continue
    return newest


def _locked_by_process(path: Path) -> bool:
    """目标文件是否被运行中的进程占用（Windows 映像锁语义；只读探测）。"""
    if not path.is_file():
        return False
    try:
        with open(path, "r+b"):
            return False
    except OSError:
        return True


def _log_fingerprints(paths: tuple[Path, ...]) -> None:
    _stage("交付指纹")
    for path in paths:
        if not path.is_file():
            continue
        stat = path.stat()
        try:
            label = path.relative_to(ROOT)
        except ValueError:
            label = path
        _log(f"  {label}")
        _log(
            f"    {stat.st_size / (1024 * 1024):.1f} MB · sha256 {_sha256(path)[:16]} · "
            f"{time.strftime('%m-%d %H:%M:%S', time.localtime(stat.st_mtime))}"
        )


def preflight(sidecar_python: str, npm: str, tauri: str) -> None:
    _stage("预检")
    problems: list[str] = []
    if not npm:
        problems.append("未找到 npm —— 请安装 Node.js 18+ 并确保 npm 在 PATH 中")
    if not tauri:
        problems.append(
            "node_modules 缺少 tauri CLI —— 先在仓库根执行 npm ci（或 npm install）"
        )
    if shutil.which("cargo") is None:
        problems.append(
            "未找到 cargo —— 请安装 Rust 工具链（https://rustup.rs）；"
            "Windows 还需 MSVC Build Tools（x86_64-pc-windows-msvc 目标）"
        )
    if not (ROOT / "webui").is_dir():
        problems.append("缺少 webui/ 目录")
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


def artifact_guard(path: Path, before: tuple[int, int] | None) -> int:
    """主程序守卫：缺失/为空 → 失败；未重写 → 早于最新输入=构建遗漏（失败），
    否则视为合法增量复用（cargo 认定无需重新链接）→ 警告放行。"""
    _stage("产物守卫")
    if not path.is_file():
        _log(f"✗ 产物不存在：{path}")
        return EXIT_ARTIFACT_GUARD
    stat = path.stat()
    if stat.st_size <= 0:
        _log(f"✗ 产物为空文件：{path}")
        return EXIT_ARTIFACT_GUARD
    if _same_snapshot(path, before):
        if stat.st_mtime < _newest_input_mtime():
            _log(f"✗ 产物未刷新且早于最新构建输入：{path}")
            _log("  Tauri/cargo 可能跳过链接或构建到了其他 target 目录。")
            return EXIT_ARTIFACT_GUARD
        _log("⚠ 产物未重写（mtime/size 与构建前一致），但无更新的构建输入——")
        _log("  判定为增量复用（cargo 认为无需重新链接），放行。")
        return 0
    _log(f"✓ 产物已刷新：{path}")
    _log(
        f"  大小 {stat.st_size / (1024 * 1024):.1f} MB · "
        f"mtime {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(stat.st_mtime))}"
    )
    _log("桌面快捷方式指向该文件，可直接使用。")
    return 0


def sidecar_artifact_guard(path: Path, before: tuple[int, int] | None) -> int:
    """sidecar 中间产物（src-tauri/binaries/）：缺失/为空 → 失败；未重写 → 警告放行。

    正常构建每次都会重新打包（build_sidecar.py 重建并原子替换）；
    连续出现「未重写」时再上报排查 PyInstaller 链路。
    """
    if not path.is_file():
        _log(f"✗ sidecar 中间产物缺失：{path}")
        return EXIT_ARTIFACT_GUARD
    stat = path.stat()
    if stat.st_size <= 0:
        _log(f"✗ sidecar 中间产物为空：{path}")
        return EXIT_ARTIFACT_GUARD
    if _same_snapshot(path, before):
        _log(f"⚠ sidecar 中间产物未重写（mtime/size 与构建前一致）：{path}")
        return 0
    _log(f"✓ sidecar 中间产物已刷新：{path} ({stat.st_size} bytes)")
    return 0


def sidecar_delivery_guard(
    path: Path,
    before: tuple[int, int] | None,
    *,
    intermediate_refreshed: bool,
) -> int:
    """sidecar 交付副本（target/<triple>/release/）：缺失/为空 → 失败；
    上游中间产物已重建而副本未同步 → 失败（Tauri externalBin 拷贝被跳过）；
    其余未重写 → 警告放行。"""
    if not path.is_file():
        _log(f"✗ sidecar 交付副本缺失：{path}")
        _log("  主 exe 启动时从自己旁边解析 sidecar——两文件必须同目录。")
        return EXIT_ARTIFACT_GUARD
    stat = path.stat()
    if stat.st_size <= 0:
        _log(f"✗ sidecar 交付副本为空：{path}")
        return EXIT_ARTIFACT_GUARD
    if _same_snapshot(path, before):
        if intermediate_refreshed:
            _log(f"✗ sidecar 中间产物已重建，但交付副本未同步：{path}")
            _log("  Tauri externalBin 拷贝可能被跳过——产物目录与应用不配套。")
            return EXIT_ARTIFACT_GUARD
        _log(f"⚠ sidecar 交付副本未重写：{path}（判定为增量复用，放行）")
        return 0
    _log(f"✓ sidecar 交付副本已刷新：{path} ({stat.st_size} bytes)")
    return 0


def host_target_snapshot() -> tuple[int, int] | None:
    path = host_target_artifact_path()
    if not path.is_file():
        return None
    stat = path.stat()
    return (stat.st_mtime_ns, stat.st_size)


def host_target_guard(before: tuple[int, int] | None) -> None:
    """防复发：正式链只写 target/<triple>/release/；target/release/ 若出现新产物，
    说明有人绕过唯一入口直跑了 tauri build（host triple 落点）。只告警不阻断。"""
    path = host_target_artifact_path()
    if not path.is_file():
        return
    stat = path.stat()
    after = (stat.st_mtime_ns, stat.st_size)
    if before is not None and after == before:
        return
    if before is None:
        _log("⚠ 检测到 host-target 泄漏：target/release/ 出现新产物（构建前不存在）")
    else:
        _log("⚠ 检测到 host-target 泄漏：target/release/ 产物被刷新")
    _log(f"  {path}")
    _log("  正式链只使用 target/<triple>/release/；有人绕过唯一入口直跑了 tauri build，")
    _log("  请清理该目录并纠正流程（见 docs/BUILD.md「构建纪律与验收」）。")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", default=DEFAULT_TARGET, help="Rust target triple")
    parser.add_argument(
        "--full",
        action="store_true",
        help="先跑后端 pytest（tests/）与前端 vitest，再进入构建阶段",
    )
    args = parser.parse_args(argv)

    _force_utf8_stdio()
    overall_started = time.monotonic()

    # 并发构建会互踩 src-tauri/target —— 拿到锁之前不做任何事
    lock_handle, lock_desc = acquire_build_lock()
    if lock_handle is None:
        _log("✗ 已有另一个构建在进行（并发构建会互踩 src-tauri/target）")
        _log(f"  {lock_desc}")
        _log("  锁随进程退出自动释放；确认无残留构建后直接重试。")
        return EXIT_PREFLIGHT
    _log(f"✓ 构建锁已获取（{lock_desc}）")

    npm = resolve_npm()
    tauri = resolve_tauri()
    sidecar_python = resolve_sidecar_python()
    preflight(sidecar_python, npm, tauri)

    artifact = artifact_path(args.target)
    sidecar_delivery = delivery_sidecar_path(args.target)
    for busy in (artifact, sidecar_delivery):
        if _locked_by_process(busy):
            _log(f"✗ {busy.name} 正被运行中的进程占用（GA-Hub 没退出？）")
            _log("  请先退出 GA-Hub 桌面应用（含托盘/后台 sidecar）再构建；")
            _log("  若确认已退出仍报占用，稍后重试（杀毒软件扫描会短暂持有文件）。")
            return EXIT_PREFLIGHT

    before = _snapshot(artifact)
    sidecar_delivery_before = _snapshot(sidecar_delivery)
    sidecar_artifact = sidecar_artifact_path(args.target)
    sidecar_before = _snapshot(sidecar_artifact)
    host_before = host_target_snapshot()

    if args.full:
        # Cross-repo imports (frontends/GA core) require both variables; avoid
        # relying on a developer shell that happens to have them configured.
        ga_root = Path(os.environ.get("GA_ROOT", str(ROOT.parent / "GA"))).resolve()
        test_env = {"GA_ROOT": str(ga_root), "PYTHONPATH": str(ga_root)}
        # pytest 与 PyInstaller 同环境：requirements.txt 里两者一并安装
        run_stage(
            "后端测试",
            [sidecar_python, "-m", "pytest", "tests/", "-q"],
            extra_env=test_env,
        )
        run_stage("前端测试", [npm, "--prefix", "webui", "test", "--", "--run"])

    run_stage("前端生产构建", [npm, "--prefix", "webui", "run", "build"])
    run_stage(
        "Python sidecar",
        [sidecar_python, "desktop/build_sidecar.py", "--target", args.target],
    )
    run_stage("Tauri 桌面壳", tauri_stage_command(tauri, args.target))

    intermediate_refreshed = not _same_snapshot(sidecar_artifact, sidecar_before)
    code = sidecar_artifact_guard(sidecar_artifact, sidecar_before)
    if code:
        return code
    code = sidecar_delivery_guard(
        sidecar_delivery,
        sidecar_delivery_before,
        intermediate_refreshed=intermediate_refreshed,
    )
    if code:
        return code
    code = artifact_guard(artifact, before)
    if code:
        return code
    host_target_guard(host_before)

    _log_fingerprints((artifact, sidecar_delivery, sidecar_artifact))
    _log(f"✓ 构建链全部通过（总耗时 {time.monotonic() - overall_started:.1f}s）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
