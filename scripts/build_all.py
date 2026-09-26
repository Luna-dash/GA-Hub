#!/usr/bin/env python3
"""GA-Hub 一键交付构建链（唯一构建入口；CI 与本地同源）。

把交付所需全部步骤固化为一条命令：

    1. 前端生产构建      npm --prefix webui run build
    2. Python sidecar    <sidecar_python> desktop/build_sidecar.py --target <triple>
    3. Tauri 桌面壳      node_modules/.bin/tauri build --target <triple> --no-bundle
                         （--bundle 时额外产出 MSI/NSIS 安装包）
    4. 产物守卫          三件产物均须存在、非空、且被本次构建重写
    5. 非正式区排查      target/release 残留（裸 tauri build 痕迹）预检期告警（不阻断）

不变式（与 docs/BUILD.md「构建纪律与验收」互为镜像，改动须同步两边）：

    - 唯一入口：build_all.bat（Windows）/ build_all.command（macOS）/
      python scripts/build_all.py。npm run desktop:build 已改为拒绝式。
      裸 tauri build 的产物会落到非正式区（已两次污染仓库）。
    - 前端归本脚本独占构建（sidecar 要把 webui/dist 打进包里），tauri.conf.json
      不再配 beforeBuildCommand：否则同一份前端会被构建两次，且主 exe 与 sidecar
      内嵌的可能来自两次不同的构建。
    - 解释器：启动本脚本的解释器（sys.executable），可用 GA_HUB_PYTHON 覆盖。
      不做静默回退；缺依赖时预检失败并给出修复命令。
    - 并发与占用：写锁 src-tauri/target/.build_all.lock 挡并发构建；预检检测
      GA-Hub 运行中占用（产物文件锁）时直接失败。
    - 子进程一律 stdin=DEVNULL：继承被悬挂读取的 stdin 管道会静默卡死子进程
      （2026-09-24 stdin 探针系列事故同源）。

退出码：2 = 预检失败（缺工具/依赖/应用未退出/并发构建）
        3 = 某个构建阶段失败
        5 = 产物守卫失败（缺失 / 为空 / 未被本次构建重写）

用法：
    python scripts/build_all.py                 # 标准交付（便携版两个 exe）
    python scripts/build_all.py --full          # 先跑后端 pytest + 前端 vitest
    python scripts/build_all.py --bundle        # 额外产出 MSI/NSIS 安装包
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


def _log(msg: str) -> None:
    line = f"[build_all] {msg}"
    try:
        print(line, flush=True)
    except UnicodeEncodeError:
        # 控制台码页（GBK/cp437）编码不了 ✓/✗/⚠：退化成该码页能表示的字符，
        # 绝不因为一行日志把构建搞崩——守卫的结论比符号的形状重要。
        encoding = getattr(sys.stdout, "encoding", None) or "ascii"
        print(line.encode(encoding, "replace").decode(encoding, "replace"), flush=True)


def _force_utf8_stdio() -> None:
    """Windows consoles default to a legacy codepage (GBK/cp936) that cannot
    encode the ✓/✗/━ glyphs used below; pin UTF-8 with replacement fallback."""
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass


# 在任何输出发生之前固定 UTF-8。控制台默认码页（GBK/cp437）编码不了 ✓/✗/⚠，
# 而 argparse 的 --help 输出、以及守卫函数被当作库直接调用时（测试、排查脚本）
# 都发生在 main() 之前——把固定动作放在模块级，这些路径才不会炸编码。
_force_utf8_stdio()


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


def tauri_stage_command(tauri: str, target: str, *, bundle: bool = False) -> list[str]:
    """构造 Tauri 构建命令；Windows 下 .cmd 需经 cmd /c 才能直接执行。

    默认 ``--no-bundle``：交付物是便携版两个 exe，安装包（MSI/NSIS，实测每次
    ~104MB、tauri 阶段多花 ~15-20s，且 CI 并不上传）不该是每次构建的固定代价。
    需要安装包时显式 ``--bundle``。
    """
    command = [tauri, "build", "--target", target]
    if not bundle:
        command.append("--no-bundle")
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


def _refreshed(path: Path, before: tuple[int, int] | None) -> bool:
    """本次构建是否重写了该产物（mtime/size 任一变化，或构建前根本不存在）。

    这是产物守卫唯一的时间判据。不再拿产物 mtime 与「输入树最新 mtime」比对：
    2026-09-26 冷/热各一次真实全链实测证明，前端每次都重写 webui/dist（vite
    不做内容比对），而 tauri build script 对 dist 每个文件都发 rerun-if-changed，
    cargo 因此必然重链；sidecar 中间产物则由 build_sidecar.py 先 unlink 再打包。
    三件产物在正常链里必然被重写——「未重写」只可能是写到了别处、或这一步被
    跳过，两种情况都不该放行。
    """
    if before is None:
        return path.is_file()
    return _snapshot(path) != before


def _human_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    return f"{size / 1024:.1f} KB"


def _sha256(path: Path, chunk_size: int = 1 << 20) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _locked_by_process(path: Path) -> bool:
    """目标产物是否被运行中的进程占用（Windows 映像锁语义；只读探测）。

    实测（2026-09-27，运行中的 ga-hub-desktop.exe / ga-hub-sidecar.exe）：Python
    对正在运行的映像做写方式打开只抛 ``PermissionError`` (errno 13)，**不带**
    winerror——所以不能按 winerror 32/33 判定（那样会漏判，构建会一路跑到 Tauri
    阶段才失败）。只读产物同样报 EACCES，用 Windows 只读属性区分：属性可写却被
    拒 = 被运行中的进程占用；属性只读 = 权限问题，交给 ``_readonly_artifact``。
    """
    if not path.is_file():
        return False
    try:
        with open(path, "r+b"):
            return False
    except OSError:
        return _writable(path)


def _writable(path: Path) -> bool:
    """文件属性是否允许写入（Windows 就绪属性；POSIX 就看权限位）。"""
    try:
        return bool(path.stat().st_mode & stat.S_IWRITE)
    except OSError:
        return False


def _readonly_artifact(path: Path) -> bool:
    """产物存在但不可写（只读属性/权限）：后续阶段必然写不进去，提前说清楚。"""
    return path.is_file() and not _writable(path)


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
            f"    {_human_size(stat.st_size)} · sha256 {_sha256(path)[:16]} · "
            f"{time.strftime('%m-%d %H:%M:%S', time.localtime(stat.st_mtime))}"
        )


def preflight(
    sidecar_python: str,
    npm: str,
    tauri: str,
    *,
    ga_root: Path | None = None,
) -> None:
    """环境预检：缺什么都在这里报出来并以 2 退出，而不是让某个阶段以 3 失败。

    ``ga_root`` 只在 ``--full`` 时传入（后端测试需要注入 GA_ROOT/PYTHONPATH）。
    """
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


def _guard(title: str, path: Path, before: tuple[int, int] | None, hint: str) -> int:
    """产物守卫（三件产物共用）：缺失 / 为空 / 未被本次构建重写 → 失败。"""
    if not path.is_file():
        _log(f"✗ {title}缺失：{path}")
        _log(f"  {hint}")
        return EXIT_ARTIFACT_GUARD
    stat = path.stat()
    if stat.st_size <= 0:
        _log(f"✗ {title}为空文件：{path}")
        return EXIT_ARTIFACT_GUARD
    if not _refreshed(path, before):
        _log(f"✗ {title}未被本次构建重写：{path}")
        _log(f"  {hint}")
        _log("  交付上一次的旧产物没有意义——先查清这一步为什么没有产出新文件。")
        return EXIT_ARTIFACT_GUARD
    _log(f"✓ {title}已刷新：{path} ({_human_size(stat.st_size)})")
    return 0


def artifact_guard(path: Path, before: tuple[int, int] | None) -> int:
    """主程序产物：桌面快捷方式 / start.bat 指向它。"""
    return _guard(
        "主程序产物",
        path,
        before,
        "Tauri/cargo 可能跳过了链接，或把产物写到了别的 target 目录。",
    )


def sidecar_artifact_guard(path: Path, before: tuple[int, int] | None) -> int:
    """sidecar 中间产物（PyInstaller 输出，也是 Tauri externalBin 的输入）。"""
    return _guard(
        "sidecar 中间产物",
        path,
        before,
        "PyInstaller 没有产出新文件（desktop/build_sidecar.py 先 unlink 再打包）。",
    )


def sidecar_delivery_guard(path: Path, before: tuple[int, int] | None) -> int:
    """sidecar 交付副本（Tauri externalBin 拷到主 exe 旁边；缺它应用起不来）。"""
    return _guard(
        "sidecar 交付副本",
        path,
        before,
        "Tauri externalBin 拷贝被跳过——产物目录与应用不配套。",
    )


def bundle_guard(target: str) -> int:
    """--bundle 的产物守卫：声明要打包却没产出安装包 → 失败（bundler 没跑成）。"""
    root = ROOT / "src-tauri" / "target" / target / "release" / "bundle"
    found = sorted(
        path
        for path in root.rglob("*")
        if path.is_file() and path.suffix.lower() in (".msi", ".exe")
    )
    _stage("安装包（--bundle）")
    if not found:
        _log(f"✗ 请求了 --bundle，但 {root} 下没有 MSI/NSIS 产物")
        _log("  Tauri bundler 可能没跑成（缺 WiX/NSIS，或 --no-bundle 被传入）。")
        return EXIT_ARTIFACT_GUARD
    for path in found:
        _log(f"✓ {path.relative_to(ROOT)} · {_human_size(path.stat().st_size)}")
    return 0


def report_host_target_leak() -> bool:
    """预检期排查非正式区产物（src-tauri/target/release/）。

    正式链恒传 --target，绝不会写这里，所以「文件存在」就等于有人裸跑过
    tauri build（2026-08-22、2026-09-23 两次污染仓库）。旧实现比较「构建前后
    mtime 是否被刷新」——可绕过只会发生在 build_all 不在场的时候，那个事件永远
    等不到，而已存在的残留又会被静默放过；改成「存在即报告」才对应真实的复发形态。
    只告警不阻断：清理历史残留不是构建的前置条件。
    """
    path = host_target_artifact_path()
    if not path.is_file():
        return False
    _log(f"⚠ 非正式区残留产物：{path}")
    _log("  target/release/ 不是正式路径（裸 tauri build 的落点）；应用与交付只认")
    _log("  target/<triple>/release/。请删掉它，并按 docs/BUILD.md 的入口构建。")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--target", default=DEFAULT_TARGET, help="Rust target triple")
    parser.add_argument(
        "--full",
        action="store_true",
        help="先跑后端 pytest（tests/）与前端 vitest，再进入构建阶段",
    )
    parser.add_argument(
        "--bundle",
        action="store_true",
        help="额外产出 MSI/NSIS 安装包（默认只产出便携版两个 exe）",
    )
    args = parser.parse_args(argv)

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
    # Cross-repo imports (frontends/GA core) require both variables; avoid
    # relying on a developer shell that happens to have them configured.
    ga_root = Path(os.environ.get("GA_ROOT", str(ROOT.parent / "GA"))).resolve()
    preflight(sidecar_python, npm, tauri, ga_root=ga_root if args.full else None)

    artifact = artifact_path(args.target)
    sidecar_delivery = delivery_sidecar_path(args.target)
    for busy in (artifact, sidecar_delivery):
        if _locked_by_process(busy):
            _log(f"✗ {busy.name} 正被运行中的进程占用（GA-Hub 没退出？）")
            _log("  请先退出 GA-Hub 桌面应用（含托盘/后台 sidecar）再构建；")
            _log("  若确认已退出仍报占用，稍后重试（杀毒软件扫描会短暂持有文件）。")
            return EXIT_PREFLIGHT
        if _readonly_artifact(busy):
            _log(f"✗ {busy.name} 没有写权限（只读属性？）：{busy}")
            _log("  构建必须替换它：先 attrib -r（或直接删掉）再重试。")
            return EXIT_PREFLIGHT
    report_host_target_leak()

    before = _snapshot(artifact)
    sidecar_delivery_before = _snapshot(sidecar_delivery)
    sidecar_artifact = sidecar_artifact_path(args.target)
    sidecar_before = _snapshot(sidecar_artifact)

    if args.full:
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
    run_stage("Tauri 桌面壳", tauri_stage_command(tauri, args.target, bundle=args.bundle))

    _stage("产物守卫")
    for guard, path, snapshot in (
        (sidecar_artifact_guard, sidecar_artifact, sidecar_before),
        (sidecar_delivery_guard, sidecar_delivery, sidecar_delivery_before),
        (artifact_guard, artifact, before),
    ):
        code = guard(path, snapshot)
        if code:
            return code
    if args.bundle:
        code = bundle_guard(args.target)
        if code:
            return code

    _log_fingerprints((artifact, sidecar_delivery, sidecar_artifact))
    _log(f"✓ 构建链全部通过（总耗时 {time.monotonic() - overall_started:.1f}s）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
