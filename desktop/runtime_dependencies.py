"""Explicit runtime imports shared by packaging and frozen startup validation.

GA worldline is imported from an external checkout, so its rich.cells dependency
is invisible to static analysis and must be frozen explicitly on every platform.
pywin32 provides the Windows modules. win32cred loads win32timezone implicitly when
converting CREDENTIAL.LastWritten; merely importing win32cred is insufficient.
Artifact downloads dynamically load win32file to validate the opened file handle.
Keep connector.py's static imports too, for third-party Python packagers.
"""
from pathlib import Path

COMMON_IMPORTS = ("rich", "rich.cells")
WINDOWS_IMPORTS = ("win32cred", "win32timezone", "win32file")


def hidden_import_args(platform: str) -> list[str]:
    imports = COMMON_IMPORTS + (WINDOWS_IMPORTS if platform == "win32" else ())
    return [arg for name in imports for arg in ("--hidden-import", name)]


# PyInstaller does not automatically retain Conda's runtime DLLs: C extensions in
# DLLs/*.pyd link against libraries that live in Library/bin, outside the
# interpreter's DLL search path.  A missing one is invisible during Analysis and
# only surfaces at process start -- on 2026-11-16 pyexpat.pyd lost libexpat.dll,
# and the pkg_resources runtime hook crashed the sidecar before any business code.
# Every critical dependency must therefore be explicit, and a glob that matches
# nothing must fail the build instead of silently shipping a broken onefile.
CONDA_RUNTIME_DLL_PATTERNS = (
    "libssl-*.dll", "libcrypto-*.dll",
    "libexpat*.dll", "expat.dll",
    "ffi.dll", "libbz2.dll", "liblzma.dll", "sqlite3.dll", "zlib.dll",
)
CRITICAL_CONDA_DLLS = ("libexpat.dll", "ffi.dll", "libbz2.dll", "liblzma.dll", "sqlite3.dll")


def conda_runtime_binary_args(conda_bin: Path) -> list[str]:
    """Build --add-binary args for Conda DLLs, rejecting a silent miss."""
    matches = {
        dependency.name.lower(): dependency
        for pattern in CONDA_RUNTIME_DLL_PATTERNS
        for dependency in conda_bin.glob(pattern)
    }
    missing = [name for name in CRITICAL_CONDA_DLLS if name not in matches]
    if missing:
        raise RuntimeError(
            f"Conda runtime DLLs missing from {conda_bin}: {', '.join(missing)}"
        )
    args: list[str] = []
    for dependency in sorted(matches.values(), key=lambda path: path.name.lower()):
        args.extend(["--add-binary", f"{dependency};."])
    return args


def runtime_binary_args(prefix: Path) -> list[str]:
    """Only Conda interpreters need explicit Library/bin runtime collection."""
    if not (prefix / "conda-meta").is_dir():
        return []
    return conda_runtime_binary_args(prefix / "Library" / "bin")
