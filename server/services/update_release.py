"""Stable GitHub releases from a pinned repository. Never accepts caller URLs.

HTTPS authenticates the repository; SHA256 detects corruption, not a separate
publisher signature. No credentials are needed for the public release feed.
"""
from __future__ import annotations

import json
import re
import sys
import uuid
import urllib.request as proxy_settings
from sys import platform
from pathlib import Path
from urllib.parse import urlsplit

import requests

from .self_update import MAX_ARCHIVE_BYTES, UpdateStore, digest, atomic_json
from .update_lock import FileMutex

REPOSITORY = "Luna-dash/GA-Hub"
API = f"https://api.github.com/repos/{REPOSITORY}/releases/latest"
SESSION_HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "GA-Hub-Updater"}


def version_tuple(value: str) -> tuple[int, int, int]:
    if not re.fullmatch(r"v?\d+\.\d+\.\d+", value):
        raise ValueError("Only stable semantic versions are supported")
    return tuple(int(n) for n in value.removeprefix("v").split("."))


def installed_version() -> str:
    # Frozen onedir sidecar lives at <install>/sidecar/ga-hub-sidecar.exe;
    # build-info.json lives at <install>/build-info.json (or legacy beside exe).
    if getattr(sys, "frozen", False):
        exe = Path(sys.executable).resolve()
        for candidate in (exe.parent.parent / "build-info.json", exe.with_name("build-info.json")):
            if candidate.is_file():
                return json.loads(candidate.read_text(encoding="utf8"))["version"]
    import tomllib
    return tomllib.loads((Path(__file__).resolve().parents[2] / "pyproject.toml").read_text(encoding="utf8"))["project"]["version"]


def asset_url(tag: str, name: str) -> str:
    version_tuple(tag)
    if not re.fullmatch(r"[A-Za-z0-9.\-]+", name):
        raise ValueError("Invalid release asset filename")
    return f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"


def fetch(url: str, destination: Path, limit: int, progress=None) -> None:
    """Bounded streaming with TLS and restricted HTTPS redirect hosts."""
    allowed = {"github.com", "api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"}
    session = requests.Session()
    # requests/urllib choose environment OR registry, not a per-scheme merge.
    # A lone HTTP_PROXY can therefore hide Windows' HTTPS system proxy.
    # Use the enabled Windows proxy for this download, including every redirect;
    # without a static system proxy, retain requests' normal environment behavior.
    system_proxies = proxy_settings.getproxies_registry() if platform == "win32" else {}
    if system_proxies:
        session.trust_env = False
    try:
        for _ in range(6):
            parsed = urlsplit(url)
            if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.username or parsed.password or parsed.port not in (None, 443):
                raise ValueError("Untrusted release download location")
            proxy_options = {}
            if system_proxies:
                proxy_options["proxies"] = {} if proxy_settings.proxy_bypass_registry(parsed.hostname) else system_proxies
            with session.get(url, headers=SESSION_HEADERS, timeout=(15, 60), stream=True, allow_redirects=False, **proxy_options) as response:
                if response.is_redirect:
                    from urllib.parse import urljoin
                    url = urljoin(url, response.headers["Location"])
                    continue
                response.raise_for_status()
                if int(response.headers.get("Content-Length", 0)) > limit:
                    raise ValueError("Release asset exceeds size limit")
                total = 0
                with destination.open("wb") as stream:
                    for block in response.iter_content(1024 * 1024):
                        total += len(block)
                        if total > limit:
                            raise ValueError("Release asset exceeds size limit")
                        stream.write(block)
                        if progress is not None:
                            progress(total)
                return
        raise ValueError("Too many release redirects")
    finally:
        session.close()


def check(root: Path) -> dict:
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"feed-{uuid.uuid4().hex}.json"
    try:
        fetch(API, path, 1024 * 1024)
        info = json.loads(path.read_text(encoding="utf8"))
    finally:
        path.unlink(missing_ok=True)
    tag = info.get("tag_name", "")
    version_tuple(tag)
    if info.get("draft") or info.get("prerelease"):
        raise ValueError("Release is not stable")
    name = f"GA-Hub-{tag.removeprefix('v')}-windows-x64.zip"
    assets = {a["name"]: a for a in info.get("assets", [])}
    if name not in assets or "SHA256SUMS.txt" not in assets:
        raise ValueError("Release is missing the Windows package or checksums")
    if not 0 < assets[name].get("size", 0) <= MAX_ARCHIVE_BYTES:
        raise ValueError("Invalid release package size")
    current = installed_version()
    result = {"repository": REPOSITORY, "current_version": current, "version": tag.removeprefix("v"),
            "tag": tag, "available": version_tuple(tag) > version_tuple(current),
            "name": name, "size": assets[name]["size"], "notes": str(info.get("body") or "")[:20000],
            "url": f"https://github.com/{REPOSITORY}/releases/tag/{tag}"}
    atomic_json(root / "release.json", result)
    return result


def prepare(store: UpdateStore, progress=None) -> dict:
    # Serializes downloads, not only final extraction; requests cannot mix assets.
    with FileMutex(store.root / "download.lock"):
        release = check(store.root)
        if not release["available"]:
            raise ValueError("No newer stable release is available")
        if progress is not None:
            progress("checksums", release=release, total_bytes=release["size"])
        token = uuid.uuid4().hex
        checksums = store.root / f"{token}.checksums"
        archive = store.root / f"{token}.zip"
        try:
            fetch(asset_url(release["tag"], "SHA256SUMS.txt"), checksums, 65536)
            matches = [m.group(1).lower() for line in checksums.read_text(encoding="utf8").splitlines()
                       if (m := re.fullmatch(r"([a-fA-F0-9]{64})  " + re.escape(release["name"]), line))]
            if len(matches) != 1:
                raise ValueError("Missing or duplicate archive checksum")
            if progress is None:
                fetch(asset_url(release["tag"], release["name"]), archive, MAX_ARCHIVE_BYTES)
            else:
                progress("downloading", received_bytes=0)
                fetch(asset_url(release["tag"], release["name"]), archive, MAX_ARCHIVE_BYTES,
                      progress=lambda received: progress("downloading", received_bytes=received))
                progress("verifying", received_bytes=archive.stat().st_size)
            if archive.stat().st_size != release["size"] or digest(archive) != matches[0]:
                raise ValueError("Release archive checksum/size mismatch")
            # Check the version inside before committing a prepared plan.
            import zipfile
            with zipfile.ZipFile(archive) as package:
                info = json.loads(package.read("build-info.json"))
            if info.get("tag") != release["tag"] or info.get("version") != release["version"] or info.get("channel") != "stable" or info.get("dirty") is not False:
                raise ValueError("Release metadata does not match the selected stable version")
            if progress is not None:
                progress("preparing")
            return store.prepare(archive, matches[0], trusted=True)
        finally:
            archive.unlink(missing_ok=True)
            checksums.unlink(missing_ok=True)
