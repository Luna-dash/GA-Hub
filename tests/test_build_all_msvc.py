"""统一入口的 MSVC bootstrap 契约，不调用真实 VS/编译器。"""
from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path
from unittest import mock

import pytest

spec = importlib.util.spec_from_file_location(
    "build_all_msvc_contract", Path(__file__).resolve().parents[1] / "scripts/build_all.py"
)
assert spec and spec.loader
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)
TARGET = "x86_64-pc-windows-msvc"


@pytest.mark.parametrize("target,arch", [
    (TARGET, "x64"), ("i686-pc-windows-msvc", "x86"),
    ("aarch64-pc-windows-msvc", "arm64"),
])
def test_arch_mapping(target, arch):
    assert build._msvc_arch(target) == arch


def test_unknown_arch_is_actionable():
    with pytest.raises(RuntimeError, match="不支持"):
        build._msvc_arch("riscv64-pc-windows-msvc")


def test_non_msvc_or_non_windows_skips():
    with mock.patch.object(build, "_vcvars_candidates") as candidates:
        build.ensure_msvc_environment("x86_64-unknown-linux-gnu")
        with mock.patch.object(build.os, "name", "posix"):
            build.ensure_msvc_environment(TARGET)
    candidates.assert_not_called()


def test_explicit_override_is_exclusive(tmp_path):
    script = tmp_path / "vcvarsall.bat"
    script.touch()
    with mock.patch.dict(os.environ, {"GA_HUB_VCVARSALL": str(script)}, clear=True), \
         mock.patch.object(build.subprocess, "run") as run:
        assert build._vcvars_candidates() == [script]
    run.assert_not_called()


def test_missing_override_fails(tmp_path):
    with mock.patch.dict(os.environ, {"GA_HUB_VCVARSALL": str(tmp_path / "missing.bat")}, clear=True):
        with pytest.raises(RuntimeError, match="文件不存在"):
            build._vcvars_candidates()


@pytest.mark.parametrize("mode", ["empty", "error", "timeout", "found"])
def test_standard_directory_fallback_and_vswhere_no_component_filter(tmp_path, mode):
    script = tmp_path / "Microsoft Visual Studio/2022/Community/VC/Auxiliary/Build/vcvarsall.bat"
    script.parent.mkdir(parents=True)
    script.touch()
    result = subprocess.CompletedProcess([], 1 if mode == "error" else 0,
        str(script.parents[3]) if mode == "found" else "", "")
    with mock.patch.dict(os.environ, {"ProgramFiles": str(tmp_path)}, clear=True), \
         mock.patch.object(build.shutil, "which", return_value="vswhere.exe"), \
         mock.patch.object(build.subprocess, "run", return_value=result) as run:
        if mode == "timeout":
            run.side_effect = subprocess.TimeoutExpired("vswhere", 15)
        assert script in build._vcvars_candidates()
    assert "-requires" not in run.call_args.args[0]
    assert "-products" in run.call_args.args[0]


@pytest.mark.parametrize("host,arch,argument", [
    ("AMD64", "x64", "x64"), ("AMD64", "arm64", "x64_arm64"),
    ("AMD64", "x86", "x64_x86"), ("ARM64", "x64", "arm64_x64"),
])
def test_load_unicode_env_and_arch_argument(host, arch, argument):
    script = Path("路径 with spaces/vcvarsall.bat")
    output = "noise\r\n__GA_HUB_MSVC_ENV__ \r\nPath=路径 with spaces\r\nLIB=a=b\r\n=C:=drive\r\nGA_HUB_VCVARS_SCRIPT=internal\r\n"
    result = subprocess.CompletedProcess([], 0, output.encode("utf-16-le"), b"")
    with mock.patch.dict(os.environ, {"PROCESSOR_ARCHITECTURE": host}, clear=True), \
         mock.patch.object(build.subprocess, "run", return_value=result) as run:
        loaded = build._load_msvc_env(script, arch)
    assert loaded == {"Path": "路径 with spaces", "LIB": "a=b"}
    command = run.call_args.args[0]
    assert isinstance(command, str)
    assert '\\"' not in command
    assert f'"%GA_HUB_VCVARS_SCRIPT%" {argument}' in command
    assert run.call_args.kwargs["env"]["GA_HUB_VCVARS_SCRIPT"] == str(script)
    assert "/u" in run.call_args.args[0]
    assert "/v:off" in run.call_args.args[0]


@pytest.mark.parametrize("rc,output", [(1, ""), (0, "no marker")])
def test_load_failure(rc, output):
    result = subprocess.CompletedProcess([], rc, output.encode("utf-16-le"), b"")
    with mock.patch.object(build.subprocess, "run", return_value=result):
        with pytest.raises(RuntimeError, match="初始化失败"):
            build._load_msvc_env(Path("vcvarsall.bat"), "x64")


def ready_fixture(tmp_path):
    vc, sdk, libs = tmp_path / "VC", tmp_path / "SDK", tmp_path / "libs"
    for directory in [vc, sdk, libs]:
        directory.mkdir()
    for name in ["kernel32.lib", "ucrt.lib", "libcmt.lib"]:
        (libs / name).touch()
    env = {"VSCMD_ARG_TGT_ARCH": "x64", "VCToolsInstallDir": str(vc),
           "WindowsSdkDir": str(sdk), "INCLUDE": "headers", "LIB": str(libs), "Path": "bin"}
    tools = {"cl.exe": str(vc / "cl.exe"), "link.exe": str(vc / "link.exe"), "rc.exe": str(sdk / "rc.exe")}
    return env, tools, libs


@pytest.mark.parametrize("defect", [None, "arch", "gnu_link", "no_sdk", "no_include", "no_lib"])
def test_ready_rejects_incomplete_or_wrong_toolchain(tmp_path, defect):
    env, tools, libs = ready_fixture(tmp_path)
    if defect == "arch": env["VSCMD_ARG_TGT_ARCH"] = "x86"
    if defect == "gnu_link": tools["link.exe"] = str(tmp_path / "gnu/link.exe")
    if defect == "no_sdk": tools["rc.exe"] = None
    if defect == "no_include": env["INCLUDE"] = ""
    if defect == "no_lib": (libs / "ucrt.lib").unlink()
    with mock.patch.object(build.shutil, "which", side_effect=lambda name, **kw: tools[name]):
        assert build._msvc_ready(env, "x64") is (defect is None)


def test_existing_environment_reused():
    with mock.patch.dict(os.environ, {}, clear=True), \
         mock.patch.object(build, "_msvc_ready", return_value=True), \
         mock.patch.object(build, "_vcvars_candidates") as candidates:
        build.ensure_msvc_environment(TARGET)
    candidates.assert_not_called()


def test_bad_candidate_does_not_leak_and_next_candidate_is_used():
    with mock.patch.dict(os.environ, {"ORIGINAL": "keep"}, clear=True), \
         mock.patch.object(build, "_msvc_ready", side_effect=[False, False, True]), \
         mock.patch.object(build, "_vcvars_candidates", return_value=[Path("bad"), Path("good")]), \
         mock.patch.object(build, "_load_msvc_env", side_effect=[{"BAD": "leak"}, {"GOOD": "inherited"}]), \
         mock.patch.object(build.subprocess, "run") as run:
        build.ensure_msvc_environment(TARGET)
        assert "BAD" not in os.environ
        assert os.environ["GOOD"] == "inherited"
        assert os.environ["ORIGINAL"] == "keep"
        run.return_value.returncode = 0
        build.run_stage("probe", ["probe"])
        assert run.call_args.kwargs["env"]["GOOD"] == "inherited"


def test_override_forces_reload_even_if_current_env_ready():
    with mock.patch.dict(os.environ, {"GA_HUB_VCVARSALL": "custom"}, clear=True), \
         mock.patch.object(build, "_msvc_ready", return_value=True), \
         mock.patch.object(build, "_vcvars_candidates", return_value=[Path("custom")]), \
         mock.patch.object(build, "_load_msvc_env", return_value={}) as load:
        build.ensure_msvc_environment(TARGET)
    load.assert_called_once()


def test_missing_msvc_stops_preflight_with_exit_two():
    with mock.patch.object(build, "ensure_msvc_environment", side_effect=RuntimeError("MSVC missing")), \
         mock.patch.object(build.shutil, "which", return_value="cargo"), \
         mock.patch.object(build, "_has_pyinstaller", return_value=True):
        with pytest.raises(SystemExit) as exc:
            build.preflight("python", "npm", "tauri", target=TARGET)
    assert exc.value.code == 2


def test_main_passes_explicit_target_before_running_stages():
    # --full runs pytest while the parent builder holds the real build lock.
    with mock.patch.object(build, "acquire_build_lock", return_value=(object(), "test-lock")), \
         mock.patch.object(build, "preflight", side_effect=SystemExit(2)) as preflight, \
         mock.patch.object(build, "run_stage") as stage:
        with pytest.raises(SystemExit):
            build.main(["--target", "aarch64-pc-windows-msvc"])
    assert preflight.call_args.kwargs["target"] == "aarch64-pc-windows-msvc"
    stage.assert_not_called()
