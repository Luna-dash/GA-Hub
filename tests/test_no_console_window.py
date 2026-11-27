"""Regression guard: GA-Hub internal/background spawns must never pop up Windows console windows."""
from __future__ import annotations

import ast
import re
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from server import process_utils
from server.services import ga_external_worker, ga_subprocess_patch

ROOT = Path(__file__).resolve().parents[1]
SERVER_DIR = ROOT / "server"
RUST_SRC_DIR = ROOT / "src-tauri" / "src"

# Explicit, documented allowlist for Python subprocess call sites under server/:
# - child_job.py:422 is the generic wrapper around subprocess.Popen (callers pass hidden_process_kwargs)
# - file_manager.py:77 launches GUI-subsystem explorer.exe (must NOT receive SW_HIDE)
# - mykey_service.py open_mykey_file() launches GUI notepad.exe fallback with CREATE_NO_WINDOW (must NOT receive SW_HIDE)
# - agy_runtime.py login_profile() is the sole explicit interactive Windows terminal TUI fallback
_PYTHON_SPAWN_ALLOWLIST: dict[tuple[str, str], str] = {
    ("server/services/child_job.py", "ChildJob.spawn"): "generic Popen wrapper",
    ("server/services/file_manager.py", "ExplorerWindow._reveal"): "GUI explorer.exe must stay visible",
    ("server/services/mykey_service.py", "open_mykey_file"): "GUI notepad.exe editor fallback must stay visible",
    ("server/services/agy_runtime.py", "AgyRuntimeManager.login_profile"): "explicit interactive terminal login TUI",
}

_SUBPROCESS_CALL_NAMES = {"Popen", "run", "call", "check_call", "check_output"}


def _iter_python_calls(path: Path):
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    rel = path.relative_to(ROOT).as_posix()

    class _Visitor(ast.NodeVisitor):
        def __init__(self) -> None:
            self.scope: list[str] = []
            self.hits: list[tuple[str, int, str, ast.Call]] = []

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self.scope.append(node.name)
            self.generic_visit(node)
            self.scope.pop()

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self.scope.append(node.name)
            self.generic_visit(node)
            self.scope.pop()

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_Call(self, node: ast.Call) -> None:
            func = node.func
            call_kind = None
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id in {"subprocess", "_sp"} and func.attr in _SUBPROCESS_CALL_NAMES:
                    call_kind = f"{func.value.id}.{func.attr}"
                elif func.value.id == "asyncio" and func.attr in {"create_subprocess_exec", "create_subprocess_shell"}:
                    call_kind = f"asyncio.{func.attr}"
                elif func.value.id == "child_job" and func.attr == "spawn":
                    call_kind = "child_job.spawn"
            if call_kind:
                qual = ".".join(self.scope) or "<module>"
                self.hits.append((rel, node.lineno, qual, node))
            self.generic_visit(node)

    visitor = _Visitor()
    visitor.visit(tree)
    return visitor.hits


def _call_uses_hidden_process_kwargs(node: ast.Call, source: str) -> bool:
    for kw in node.keywords:
        if kw.arg is None and isinstance(kw.value, ast.Call):
            fn = kw.value.func
            if isinstance(fn, ast.Name) and fn.id == "hidden_process_kwargs":
                return True
        if kw.arg is None and isinstance(kw.value, ast.Name):
            # e.g. kwargs.update(hidden_process_kwargs()); subprocess.check_output(..., **kwargs)
            var_name = kw.value.id
            if re.search(rf"\b{re.escape(var_name)}\.update\(\s*hidden_process_kwargs\(", source):
                return True
    return False


def _call_uses_detach_console(node: ast.Call) -> bool:
    for kw in node.keywords:
        if kw.arg is None and isinstance(kw.value, ast.Call):
            fn = kw.value.func
            if isinstance(fn, ast.Name) and fn.id == "hidden_process_kwargs":
                for inner in kw.value.keywords:
                    if inner.arg == "detach_console" and isinstance(inner.value, ast.Constant) and inner.value.value:
                        return True
    return False


def test_every_server_subprocess_call_suppresses_windows_console():
    violations: list[str] = []
    for py_file in sorted(SERVER_DIR.rglob("*.py")):
        rel = py_file.relative_to(ROOT).as_posix()
        source = py_file.read_text(encoding="utf-8")
        for _rel, lineno, qual, call in _iter_python_calls(py_file):
            if _call_uses_detach_console(call):
                violations.append(f"{rel}:{lineno} ({qual}) passes detach_console=True (use CREATE_NO_WINDOW)")
                continue
            if (rel, qual) in _PYTHON_SPAWN_ALLOWLIST:
                continue
            if not _call_uses_hidden_process_kwargs(call, source):
                violations.append(f"{rel}:{lineno} ({qual}) missing **hidden_process_kwargs()")

        # No production server code (outside the Popen guard definitions) should use DETACHED_PROCESS
        if rel not in {"server/process_utils.py", "server/services/ga_external_worker.py"} and "DETACHED_PROCESS" in source:
            violations.append(f"{rel} references DETACHED_PROCESS (use CREATE_NO_WINDOW via hidden_process_kwargs)")

        # Only the explicitly allowlisted interactive login_profile and Popen guard definitions may reference CREATE_NEW_CONSOLE
        if rel not in {
            "server/process_utils.py",
            "server/services/ga_external_worker.py",
            "server/services/agy_runtime.py",
        } and "CREATE_NEW_CONSOLE" in source:
            violations.append(f"{rel} references CREATE_NEW_CONSOLE")

    assert not violations, "Windows console suppression violations:\n" + "\n".join(violations)


def test_rust_production_spawns_use_create_no_window_not_detached():
    violations: list[str] = []
    for rs_file in sorted(RUST_SRC_DIR.rglob("*.rs")):
        rel = rs_file.relative_to(ROOT).as_posix()
        raw = rs_file.read_text(encoding="utf-8")
        prod = raw.split("#[cfg(test)]", 1)[0]
        if "DETACHED_PROCESS" in prod:
            violations.append(f"{rel} uses DETACHED_PROCESS in production code (use CREATE_NO_WINDOW)")
        if "CREATE_NEW_CONSOLE" in prod:
            violations.append(f"{rel} uses CREATE_NEW_CONSOLE in production code")
    assert not violations, "Rust Windows console violations:\n" + "\n".join(violations)


def test_install_silent_subprocess_default_injects_create_no_window_only():
    seen: list[dict] = []

    class FakePopen:
        def __init__(self, *args, **kwargs):
            seen.append(dict(kwargs))

    with (
        mock.patch.object(process_utils.os, "name", "nt"),
        mock.patch.object(process_utils.subprocess, "Popen", FakePopen),
        mock.patch.object(process_utils.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(process_utils.subprocess, "CREATE_NEW_CONSOLE", 0x00000010, create=True),
        mock.patch.object(process_utils.subprocess, "DETACHED_PROCESS", 0x00000008, create=True),
    ):
        assert process_utils.install_silent_subprocess_default() is True
        # Idempotent second install does not double-wrap
        wrapped_once = FakePopen.__init__
        assert process_utils.install_silent_subprocess_default() is True
        assert FakePopen.__init__ is wrapped_once

        FakePopen(["cmd", "/c", "echo", "hi"])
        FakePopen(["cmd"], creationflags=0x00000200)
        FakePopen(["agy.exe"], creationflags=0x00000010)
        FakePopen(["helper.exe"], creationflags=0x00000008)

    assert seen[0]["creationflags"] == 0x08000000
    assert "startupinfo" not in seen[0]
    assert seen[1]["creationflags"] == (0x08000000 | 0x00000200)
    assert seen[2]["creationflags"] == 0x00000010
    assert seen[3]["creationflags"] == 0x00000008


def test_ga_subprocess_patch_covers_run_and_helpers_on_windows():
    fake_ga = SimpleNamespace(subprocess=subprocess)
    calls: list[dict] = []

    def fake_run(*args, **kwargs):
        calls.append(dict(kwargs))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with (
        mock.patch.dict(sys.modules, {"ga": fake_ga}),
        mock.patch.object(ga_subprocess_patch.os, "name", "nt"),
        mock.patch.object(process_utils.os, "name", "nt"),
        mock.patch.object(subprocess, "run", fake_run),
        mock.patch.object(subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True),
        mock.patch.object(ga_subprocess_patch._paths, "discover_user_python", return_value=None),
    ):
        ga_subprocess_patch._patch_ga_subprocess()
        fake_ga.subprocess.run(["pwsh", "-Command", "echo hi"])

    assert len(calls) == 1
    assert calls[0]["creationflags"] & 0x08000000


def test_external_worker_script_installs_create_no_window_default():
    assert "CREATE_NO_WINDOW" in ga_external_worker._WEB_TOOL_WORKER_SCRIPT
    assert "subprocess.Popen.__init__" in ga_external_worker._WEB_TOOL_WORKER_SCRIPT
