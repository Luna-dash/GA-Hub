"""Release guard for the standalone desktop sidecar (module metadata only)."""
from pathlib import Path


EXCLUDED_MODULES = (
    "mykey", "agentmain", "ga", "llmcore", "frontends", "plugins", "server.run",
    "TMWebDriver", "legacy_llmcore", "agent_loop",
)


def verify_sidecar_archive(path: Path) -> None:
    from PyInstaller.archive.readers import CArchiveReader

    try:
        archive = CArchiveReader(str(path))
        embedded = [name for name, entry in archive.toc.items() if entry[-1] == "z"]
        if not embedded:
            raise ValueError("no embedded Python module archive")
        names = {name.replace("\\", "/").replace("/", ".") for name in archive.toc}
        for name in embedded:
            names.update(archive.open_embedded_archive(name).toc)
    except Exception as exc:
        raise ValueError(f"Cannot verify sidecar archive {path}: {exc}") from exc

    forbidden = sorted({
        root for root in EXCLUDED_MODULES
        if any(name == root or name.startswith(root + ".") for name in names)
    })
    if forbidden:
        raise ValueError(f"Sidecar archive includes excluded GA modules: {', '.join(forbidden)}")
