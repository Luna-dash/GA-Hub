"""GA ``code_run`` subprocess UI suppression.

Patches ``ga.subprocess.Popen`` so GA's ``code_run`` doesn't spawn
visible windows or kick the macOS app bundle when GA is hosted by Admin.
The full why is in ``_patch_ga_subprocess``'s docstring.
"""
from __future__ import annotations

import logging
import os
import sys

from .. import _paths

log = logging.getLogger(__name__)


def _patch_ga_subprocess() -> None:
    """Patch ``ga.subprocess.Popen`` so ``code_run`` doesn't pollute the UI.

    Two distinct problems on two platforms, same patch site (GA's module-
    level ``import subprocess``, see ``ga.py:4`` and the ``subprocess.Popen``
    call at ``ga.py:52``):

    **Windows** — ``ga.py:code_run`` builds Popen with only
    ``startupinfo.wShowWindow = SW_HIDE``. SW_HIDE is read by the child
    *after* conhost has already attached a console. When the parent
    (this server, started by pythonw / a no-console frozen exe) lacks a
    console of its own, Windows allocates a fresh one for the child and
    the user sees a black window flash on every code_run. Adding
    ``CREATE_NO_WINDOW`` (0x08000000) tells the OS not to allocate the
    console at all, which is the actual fix.

    **macOS frozen .app** — ``ga.py:27`` builds
    ``[sys.executable, "-X", "utf8", "-u", tmp]`` to run user Python.
    In a PyInstaller-frozen ``.app`` build, ``sys.executable`` points at
    the bundle's Mach-O launcher, not Python. The launcher inherits the
    GUI ``Info.plist`` so each spawn shows up as a fresh Dock icon, and
    ``-X``/``-u`` aren't understood — argv just gets fed back into
    ``launch_webui.pyw:main`` which fails to run the user's code. Fix:
    rewrite ``argv[0]`` to a real ``python3`` interpreter discovered by
    ``_paths.discover_user_python()``. We don't touch the helper-app
    path because user code routinely imports user-pip-installed packages
    (numpy, requests, …) that the frozen interpreter doesn't have.

    Patching strategy is the same on all platforms: override the ``Popen``
    reference inside ``ga``'s module namespace at admin-startup time. The
    wrapper rewrites GA ``code_run`` commands away from Admin's runtime and
    toward the configured / GA-local / system Python interpreter, while also
    preserving Windows no-console behavior. The GA repo stays untouched on
    disk and ``git pull`` on GA never conflicts with admin.
    """
    try:
        import ga as _ga  # type: ignore  # resolved via GA sys.path
        import subprocess as _sp
    except Exception:
        log.exception("could not import ga/subprocess for code_run patch")
        return

    if getattr(_ga.subprocess.Popen, "_admin_wrapped", False):
        return

    real_python = _paths.discover_user_python()
    if not real_python:
        log.warning(
            "no external Python found for GA code_run; falling back to current executable: %s",
            sys.executable,
        )

    _orig_popen = _sp.Popen
    _current_exe = os.path.abspath(sys.executable)
    CREATE_NO_WINDOW = 0x08000000

    def _admin_popen(*args, **kwargs):
        cmd = args[0] if args else kwargs.get("args")
        if real_python and isinstance(cmd, (list, tuple)) and cmd:
            env = kwargs.get("env")
            if env is None:
                env = os.environ.copy()
            else:
                env = dict(env)
            python_dir = os.path.dirname(real_python)
            path = env.get("PATH") or ""
            path_parts = path.split(os.pathsep) if path else []
            if python_dir and python_dir not in path_parts:
                env["PATH"] = python_dir + (os.pathsep + path if path else "")
            env.setdefault("GA_PYTHON", real_python)
            kwargs["env"] = env

            try:
                cmd0 = os.path.abspath(str(cmd[0]))
            except Exception:
                cmd0 = ""
            if cmd0 == _current_exe:
                new_cmd = [real_python, *cmd[1:]]
                if args:
                    args = (new_cmd, *args[1:])
                else:
                    kwargs["args"] = new_cmd

        if os.name == "nt":
            cf = kwargs.get("creationflags") or 0
            kwargs["creationflags"] = cf | CREATE_NO_WINDOW
        return _orig_popen(*args, **kwargs)

    _admin_popen._admin_wrapped = True  # type: ignore[attr-defined]
    _ga.subprocess.Popen = _admin_popen
    log.info(
        "patched ga.subprocess.Popen for code_run python=%s no_window=%s",
        real_python or sys.executable,
        os.name == "nt",
    )
