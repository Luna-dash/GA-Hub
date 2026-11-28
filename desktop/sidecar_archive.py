"""Release guard for the standalone desktop sidecar (onedir & legacy onefile)."""
from __future__ import annotations

import zipfile
from pathlib import Path

EXCLUDED_MODULES = (
    # External GA checkout modules (loaded dynamically from user's GA_ROOT)
    "mykey", "agentmain", "ga", "llmcore", "frontends", "plugins", "server.run",
    "TMWebDriver", "legacy_llmcore", "agent_loop",
    # Heavy third-party & dev-only libraries not used by the desktop sidecar
    "numpy", "scipy", "matplotlib", "pandas", "torch",
    "cryptography", "Pythonwin", "pywin", "win32ui",
    "_pytest", "pytest", "setuptools", "pkg_resources",
    "watchfiles", "tornado", "unittest",
)


def _collect_onedir_names(internal_dir: Path, exe_path: Path) -> set[str]:
    names: set[str] = set()
    for entry in internal_dir.rglob("*"):
        rel = entry.relative_to(internal_dir).as_posix()
        parts = rel.split("/")
        if parts:
            stem = parts[0]
            if stem.endswith((".py", ".pyc", ".pyd", ".so")):
                stem = stem.split(".", 1)[0]
            names.add(stem)
        names.add(rel.replace("/", "."))
        if entry.is_file() and entry.suffix == ".zip":
            try:
                with zipfile.ZipFile(entry) as zf:
                    for member in zf.namelist():
                        mod = member.replace("\\", "/").removesuffix(".pyc").removesuffix(".py").replace("/", ".")
                        names.add(mod)
            except zipfile.BadZipFile:
                pass
    # Also inspect the embedded PYZ inside the onedir bootloader executable if present.
    try:
        from PyInstaller.archive.readers import CArchiveReader

        archive = CArchiveReader(str(exe_path))
        for name in archive.toc:
            names.add(name.replace("\\", "/").replace("/", "."))
        for name, entry in archive.toc.items():
            if entry[-1] == "z":
                names.update(archive.open_embedded_archive(name).toc)
    except Exception:
        pass
    return names


def verify_sidecar_archive(path: Path) -> None:
    """Verify neither an onedir sidecar bundle nor a onefile exe embeds excluded modules."""
    target = path
    if target.is_dir():
        exe = target / "ga-hub-sidecar.exe"
        if not exe.is_file():
            exe = target / "ga-hub-sidecar"
        target = exe

    internal_dir = target.parent / "_internal"
    if internal_dir.is_dir():
        names = _collect_onedir_names(internal_dir, target)
    else:
        from PyInstaller.archive.readers import CArchiveReader

        try:
            archive = CArchiveReader(str(target))
            embedded = [name for name, entry in archive.toc.items() if entry[-1] == "z"]
            if not embedded:
                raise ValueError("no embedded Python module archive")
            names = {name.replace("\\", "/").replace("/", ".") for name in archive.toc}
            for name in embedded:
                names.update(archive.open_embedded_archive(name).toc)
        except Exception as exc:
            raise ValueError(f"Cannot verify sidecar archive {target}: {exc}") from exc

    forbidden = sorted({
        root for root in EXCLUDED_MODULES
        if any(name == root or name.startswith(root + ".") for name in names)
    })
    if forbidden:
        raise ValueError(f"Sidecar archive includes excluded modules: {', '.join(forbidden)}")
