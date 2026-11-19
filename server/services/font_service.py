"""Manage optional downloadable / imported UI font packs under ADMIN_DATA/fonts."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import shutil
import tarfile
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urljoin

import requests

from .. import _paths
from .self_update import atomic_json
from .update_lock import FileMutex

log = logging.getLogger(__name__)

PACK_ID_RE = re.compile(r"^[a-z0-9-]+$")
FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.(?:woff2|ttf|otf)$")
ALLOWED_LOCAL_EXTS = {".woff2", ".ttf", ".otf"}
MAX_LOCAL_FONT_BYTES = 40 * 1024 * 1024
FONT_MAGIC_HEADERS = (b"wOF2", b"\x00\x01\x00\x00", b"OTTO", b"ttcf")
BOLD_STYLES = {"restrained", "standard"}

# Shared compact Latin + monospace variable fonts (~140 KB total across 3 files).
LATIN_MONO_ASSETS: tuple[dict[str, Any], ...] = (
    {
        "family": "GA Latin Sans",
        "file": "inter-latin-wght-normal.woff2",
        "weight": "100 900",
        "style": "normal",
        "unicodeRange": "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+FEFF, U+FFFD",
        "size": 48256,
        "sha256": "3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62",
        "urls": (
            "https://cdn.npmmirror.com/packages/@fontsource-variable/inter/5.3.0/files/files/inter-latin-wght-normal.woff2",
            "https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-normal.woff2",
        ),
    },
    {
        "family": "GA Latin Sans",
        "file": "inter-latin-wght-italic.woff2",
        "weight": "100 900",
        "style": "italic",
        "unicodeRange": "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+FEFF, U+FFFD",
        "size": 51832,
        "sha256": "7291b5970da2237441273c03b424a504b70b18f09791473fab99687dcc314720",
        "urls": (
            "https://cdn.npmmirror.com/packages/@fontsource-variable/inter/5.3.0/files/files/inter-latin-wght-italic.woff2",
            "https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/files/inter-latin-wght-italic.woff2",
        ),
    },
    {
        "family": "GA Mono",
        "file": "jetbrains-mono-latin-wght-normal.woff2",
        "weight": "100 800",
        "style": "normal",
        "size": 40404,
        "sha256": "18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e",
        "urls": (
            "https://cdn.npmmirror.com/packages/@fontsource-variable/jetbrains-mono/5.3.0/files/files/jetbrains-mono-latin-wght-normal.woff2",
            "https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-normal.woff2",
        ),
    },
)

HARMONYOS_ASSETS: tuple[dict[str, Any], ...] = (
    {
        "family": "GA CJK Sans",
        "file": "HarmonyOS_Sans_SC_Regular.woff2",
        "weight": "400",
        "style": "normal",
        "size": 4359364,
        "sha256": "ed837bcd4bc515440e35504c255cdf648fc8611389904b4e44c01fb35b5a0059",
        "urls": (
            "https://cdn.npmmirror.com/packages/@lobehub/webfont-harmony-sans-sc/1.0.0/files/fonts/HarmonyOS_Sans_SC_Regular.woff2",
            "https://cdn.jsdelivr.net/npm/@lobehub/webfont-harmony-sans-sc@1.0.0/fonts/HarmonyOS_Sans_SC_Regular.woff2",
        ),
    },
    {
        "family": "GA CJK Sans",
        "file": "HarmonyOS_Sans_SC_Medium.woff2",
        "weight": "500 600",
        "style": "normal",
        "size": 4440632,
        "sha256": "2402beaeb6813ff143665de9da56e56e3f2b03dc4814bab87ca6e30b9b7f5fac",
        "urls": (
            "https://cdn.npmmirror.com/packages/@lobehub/webfont-harmony-sans-sc/1.0.0/files/fonts/HarmonyOS_Sans_SC_Medium.woff2",
            "https://cdn.jsdelivr.net/npm/@lobehub/webfont-harmony-sans-sc@1.0.0/fonts/HarmonyOS_Sans_SC_Medium.woff2",
        ),
    },
    {
        "family": "GA CJK Sans",
        "file": "HarmonyOS_Sans_SC_Bold.woff2",
        "weight": "700 900",
        "style": "normal",
        "size": 4475560,
        "sha256": "16bb07870bee433a6597e4f13f0e5b08ddffd13ad9d4363364c4c9f84dd6baec",
        "urls": (
            "https://cdn.npmmirror.com/packages/@lobehub/webfont-harmony-sans-sc/1.0.0/files/fonts/HarmonyOS_Sans_SC_Bold.woff2",
            "https://cdn.jsdelivr.net/npm/@lobehub/webfont-harmony-sans-sc@1.0.0/fonts/HarmonyOS_Sans_SC_Bold.woff2",
        ),
    },
)

NOTO_SC_TARBALL = {
    "size": 4648850,
    "sha256": "95a11c5bbacd9995d94fc8cf964ee687307aacf20957ca6a4a16077519388163",
    "urls": (
        "https://registry.npmmirror.com/@fontsource-variable/noto-sans-sc/-/noto-sans-sc-5.3.1.tgz",
        "https://registry.npmjs.org/@fontsource-variable/noto-sans-sc/-/noto-sans-sc-5.3.1.tgz",
    ),
}

MISANS_CSS_VARIANTS: tuple[tuple[str, str], ...] = (
    ("MiSans-Regular.min.css", "400"),
    ("MiSans-Medium.min.css", "500"),
    ("MiSans-Semibold.min.css", "600 900"),
)
MISANS_BASE_URLS = (
    "https://cdn.npmmirror.com/packages/misans/5.0.0/files/lib/Normal/",
    "https://cdn.jsdelivr.net/npm/misans@5.0.0/lib/Normal/",
)


@dataclass(frozen=True)
class FontPackSpec:
    id: str
    name: str
    summary: str
    license: str
    mode: str  # "latin-enhanced" | "enhanced"
    approx_bytes: int


CATALOG: tuple[FontPackSpec, ...] = (
    FontPackSpec(
        id="harmonyos-sans-sc",
        name="HarmonyOS Sans SC + Inter / JetBrains Mono",
        summary="华为鸿蒙黑体三档字重（Regular / Medium / Bold），字怀收敛耐看，中英数字与代码统一。",
        license="HarmonyOS Sans License",
        mode="enhanced",
        approx_bytes=13_416_048,
    ),
    FontPackSpec(
        id="noto-sans-sc",
        name="Noto Sans SC 可变体 + Inter / JetBrains Mono",
        summary="TrueType WOFF2 连续可变思源黑体（100–900 全字阶，仅 ~4.6 MB），告别系统静态 OTF 粗糙感。",
        license="OFL-1.1",
        mode="enhanced",
        approx_bytes=4_789_342,
    ),
    FontPackSpec(
        id="misans",
        name="MiSans + Inter / JetBrains Mono",
        summary="小米 MiSans 简体子集三档字重（Regular / Medium / Semibold），平直现代工具风。",
        license="Apache-2.0",
        mode="enhanced",
        approx_bytes=6_800_000,
    ),
    FontPackSpec(
        id="latin-only",
        name="仅 Inter + JetBrains Mono（轻量西文/代码）",
        summary="仅约 140 KB，统一西文、等宽数字与代码块；中文保留微软雅黑温和加粗策略。",
        license="OFL-1.1",
        mode="latin-enhanced",
        approx_bytes=140_492,
    ),
)
CATALOG_BY_ID = {item.id: item for item in CATALOG}

CSS_FACE_RE = re.compile(r"@font-face\s*\{([^}]+)\}", re.IGNORECASE)
CSS_URL_RE = re.compile(r"url\(['\"]?([^'\")]+\.woff2)['\"]?\)", re.IGNORECASE)
CSS_UNICODE_RE = re.compile(r"unicode-range\s*:\s*([^;]+)", re.IGNORECASE)


def font_root() -> Path:
    return _paths.ADMIN_DATA / "fonts"


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _check_magic(blob: bytes) -> None:
    if len(blob) < 16 or not any(blob.startswith(sig) for sig in FONT_MAGIC_HEADERS):
        raise ValueError("不是有效的 WOFF2/TTF/OTF 字体文件")


def _font_format(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext == ".woff2":
        return "woff2"
    if ext == ".otf":
        return "opentype"
    return "truetype"


def _dir_size(path: Path) -> int:
    total = 0
    try:
        for entry in path.iterdir():
            if entry.is_file():
                total += entry.stat().st_size
    except OSError:
        return 0
    return total


def _download_bytes(urls: tuple[str, ...], *, expected_sha256: str | None = None,
                    on_chunk: Any = None, timeout: tuple[int, int] = (10, 60)) -> bytes:
    last_exc: Exception | None = None
    for url in urls:
        try:
            with requests.get(
                url,
                stream=True,
                timeout=timeout,
                headers={"User-Agent": "GA-Hub-FontManager/1.0"},
            ) as resp:
                resp.raise_for_status()
                chunks: list[bytes] = []
                for chunk in resp.iter_content(chunk_size=65536):
                    if not chunk:
                        continue
                    chunks.append(chunk)
                    if on_chunk is not None:
                        on_chunk(len(chunk))
                blob = b"".join(chunks)
                if expected_sha256:
                    digest = hashlib.sha256(blob).hexdigest()
                    if digest != expected_sha256:
                        raise ValueError(f"Checksum mismatch for {url}: {digest}")
                return blob
        except Exception as exc:
            last_exc = exc
            log.warning("font asset fetch failed from %s: %s", url, exc)
    assert last_exc is not None
    raise last_exc


def _latin_faces_from_dir(target_dir: Path, progress: Any) -> list[dict[str, Any]]:
    faces: list[dict[str, Any]] = []
    for asset in LATIN_MONO_ASSETS:
        blob = _download_bytes(asset["urls"], expected_sha256=asset["sha256"], on_chunk=progress)
        _check_magic(blob)
        (target_dir / asset["file"]).write_bytes(blob)
        face: dict[str, Any] = {
            "family": asset["family"],
            "file": asset["file"],
            "weight": asset["weight"],
            "style": asset["style"],
            "format": _font_format(asset["file"]),
        }
        if "unicodeRange" in asset:
            face["unicodeRange"] = asset["unicodeRange"]
        faces.append(face)
    return faces


def _install_harmonyos(stage_dir: Path, progress: Any) -> dict[str, Any]:
    faces = _latin_faces_from_dir(stage_dir, progress)
    for asset in HARMONYOS_ASSETS:
        blob = _download_bytes(asset["urls"], expected_sha256=asset["sha256"], on_chunk=progress)
        _check_magic(blob)
        (stage_dir / asset["file"]).write_bytes(blob)
        faces.append({
            "family": asset["family"],
            "file": asset["file"],
            "weight": asset["weight"],
            "style": asset["style"],
            "format": "woff2",
        })
    return {
        "pack_id": "harmonyos-sans-sc",
        "name": CATALOG_BY_ID["harmonyos-sans-sc"].name,
        "mode": "enhanced",
        "faces": faces,
    }


def _install_noto_sc(stage_dir: Path, progress: Any) -> dict[str, Any]:
    faces = _latin_faces_from_dir(stage_dir, progress)
    tgz = _download_bytes(
        NOTO_SC_TARBALL["urls"],
        expected_sha256=NOTO_SC_TARBALL["sha256"],
        on_chunk=progress,
    )
    css_text = ""
    extracted: set[str] = set()
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tf:
        for member in tf.getmembers():
            if not member.isfile():
                continue
            if member.name == "package/wght.css":
                f = tf.extractfile(member)
                if f is not None:
                    css_text = f.read().decode("utf-8", errors="ignore")
            elif member.name.startswith("package/files/") and member.name.endswith(".woff2"):
                fname = Path(member.name).name
                if not FILENAME_RE.match(fname):
                    continue
                f = tf.extractfile(member)
                if f is None:
                    continue
                blob = f.read()
                _check_magic(blob)
                (stage_dir / fname).write_bytes(blob)
                extracted.add(fname)
    for match in CSS_FACE_RE.finditer(css_text):
        block = match.group(1)
        url_m = CSS_URL_RE.search(block)
        if not url_m:
            continue
        fname = Path(url_m.group(1)).name
        if fname not in extracted:
            continue
        face: dict[str, Any] = {
            "family": "GA CJK Sans",
            "file": fname,
            "weight": "100 900",
            "style": "normal",
            "format": "woff2",
        }
        ur_m = CSS_UNICODE_RE.search(block)
        if ur_m:
            face["unicodeRange"] = " ".join(ur_m.group(1).split())
        faces.append(face)
    if len(faces) <= len(LATIN_MONO_ASSETS):
        raise ValueError("Noto Sans SC package produced no valid font slices")
    return {
        "pack_id": "noto-sans-sc",
        "name": CATALOG_BY_ID["noto-sans-sc"].name,
        "mode": "enhanced",
        "faces": faces,
    }


def _install_misans(stage_dir: Path, progress: Any) -> dict[str, Any]:
    faces = _latin_faces_from_dir(stage_dir, progress)
    jobs: list[tuple[str, str, str | None]] = []
    for css_name, weight in MISANS_CSS_VARIANTS:
        css_urls = tuple(urljoin(base, css_name) for base in MISANS_BASE_URLS)
        css_text = _download_bytes(css_urls).decode("utf-8", errors="ignore")
        for match in CSS_FACE_RE.finditer(css_text):
            block = match.group(1)
            url_m = CSS_URL_RE.search(block)
            if not url_m:
                continue
            fname = Path(url_m.group(1)).name
            if not FILENAME_RE.match(fname):
                continue
            ur_m = CSS_UNICODE_RE.search(block)
            ur = " ".join(ur_m.group(1).split()) if ur_m else None
            jobs.append((fname, weight, ur))
    if not jobs:
        raise ValueError("MiSans CSS produced no valid font chunks")

    def fetch_one(fname: str) -> bytes:
        urls = tuple(urljoin(base, fname) for base in MISANS_BASE_URLS)
        blob = _download_bytes(urls, on_chunk=progress)
        _check_magic(blob)
        return blob

    unique_names = list(dict.fromkeys(fname for fname, _, _ in jobs))
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(fetch_one, unique_names))
    for fname, blob in zip(unique_names, results):
        (stage_dir / fname).write_bytes(blob)

    for fname, weight, ur in jobs:
        face: dict[str, Any] = {
            "family": "GA CJK Sans",
            "file": fname,
            "weight": weight,
            "style": "normal",
            "format": "woff2",
        }
        if ur:
            face["unicodeRange"] = ur
        faces.append(face)
    return {
        "pack_id": "misans",
        "name": CATALOG_BY_ID["misans"].name,
        "mode": "enhanced",
        "faces": faces,
    }


def _install_latin_only(stage_dir: Path, progress: Any) -> dict[str, Any]:
    faces = _latin_faces_from_dir(stage_dir, progress)
    return {
        "pack_id": "latin-only",
        "name": CATALOG_BY_ID["latin-only"].name,
        "mode": "latin-enhanced",
        "faces": faces,
    }


_INSTALLERS = {
    "harmonyos-sans-sc": _install_harmonyos,
    "noto-sans-sc": _install_noto_sc,
    "misans": _install_misans,
    "latin-only": _install_latin_only,
}


class FontManager:
    """Thread- and process-safe store for optional UI font packs."""

    def __init__(self, root: Path | None = None):
        self.root = (root or font_root()).resolve()
        self.packs_dir = self.root / "packs"
        self.prefs_path = self.root / "preferences.json"
        self.task_path = self.root / "download-task.json"

    def _ensure_dirs(self) -> None:
        self.packs_dir.mkdir(parents=True, exist_ok=True)

    def _prefs(self) -> dict[str, str]:
        data = _read_json(self.prefs_path)
        active = str(data.get("active_pack") or "system")
        bold = str(data.get("bold_style") or "restrained")
        if bold not in BOLD_STYLES:
            bold = "restrained"
        return {"active_pack": active, "bold_style": bold}

    def _save_prefs(self, prefs: dict[str, str]) -> dict[str, str]:
        self._ensure_dirs()
        atomic_json(self.prefs_path, prefs)
        return prefs

    def _installed_manifest(self, pack_id: str) -> dict[str, Any] | None:
        if not PACK_ID_RE.match(pack_id):
            return None
        pdir = self.packs_dir / pack_id
        manifest = _read_json(pdir / "manifest.json")
        faces = manifest.get("faces")
        if not isinstance(faces, list) or not faces:
            return None
        return manifest

    def download_status(self) -> dict[str, Any] | None:
        task = _read_json(self.task_path)
        if task.get("phase") == "downloading":
            try:
                with FileMutex(self.root / "download.lock", timeout=0):
                    task = _read_json(self.task_path)
                    if task.get("phase") == "downloading":
                        task.update(
                            phase="error",
                            updated_at=time.time(),
                            error="上次字体下载已中断，可重新下载；当前字体不受影响。",
                        )
                        atomic_json(self.task_path, task)
            except TimeoutError:
                pass
        return task or None

    def state(self) -> dict[str, Any]:
        prefs = self._prefs()
        active_pack = prefs["active_pack"]
        if active_pack != "system" and self._installed_manifest(active_pack) is None:
            active_pack = "system"
        packs: list[dict[str, Any]] = []
        for spec in CATALOG:
            manifest = self._installed_manifest(spec.id)
            pdir = self.packs_dir / spec.id
            installed = manifest is not None
            packs.append({
                "id": spec.id,
                "name": spec.name,
                "summary": spec.summary,
                "license": spec.license,
                "mode": spec.mode,
                "approx_bytes": spec.approx_bytes,
                "installed": installed,
                "installed_bytes": _dir_size(pdir) if installed else 0,
                "active": active_pack == spec.id,
                "removable": True,
            })
        custom_manifest = self._installed_manifest("custom")
        if custom_manifest is not None:
            cdir = self.packs_dir / "custom"
            packs.append({
                "id": "custom",
                "name": str(custom_manifest.get("name") or "本地导入字体"),
                "summary": "从本机导入的自定义字体文件。",
                "license": "Local",
                "mode": str(custom_manifest.get("mode") or "enhanced"),
                "approx_bytes": _dir_size(cdir),
                "installed": True,
                "installed_bytes": _dir_size(cdir),
                "active": active_pack == "custom",
                "removable": True,
            })
        return {
            "active_pack": active_pack,
            "bold_style": prefs["bold_style"],
            "packs": packs,
            "download": self.download_status(),
        }

    def start_download(self, pack_id: str) -> dict[str, Any]:
        if pack_id not in _INSTALLERS:
            raise ValueError(f"未知字体包: {pack_id}")
        self._ensure_dirs()
        spec = CATALOG_BY_ID[pack_id]
        with FileMutex(self.root / "download-start.lock", timeout=2):
            cur = self.download_status()
            if cur and cur.get("phase") == "downloading":
                return self.state()
            ready = threading.Event()

            def worker() -> None:
                try:
                    with FileMutex(self.root / "download.lock", timeout=0):
                        task: dict[str, Any] = {
                            "pack_id": pack_id,
                            "phase": "downloading",
                            "received_bytes": 0,
                            "total_bytes": spec.approx_bytes,
                            "updated_at": time.time(),
                            "error": None,
                        }
                        atomic_json(self.task_path, task)
                        ready.set()
                        last_flush = [0.0]

                        def on_chunk(n: int) -> None:
                            task["received_bytes"] += n
                            now = time.time()
                            if now - last_flush[0] >= 0.2:
                                task["updated_at"] = now
                                atomic_json(self.task_path, task)
                                last_flush[0] = now

                        with tempfile.TemporaryDirectory(prefix=f"{pack_id}-", dir=self.root) as tmp:
                            stage = Path(tmp)
                            manifest = _INSTALLERS[pack_id](stage, on_chunk)
                            atomic_json(stage / "manifest.json", manifest)
                            dest = self.packs_dir / pack_id
                            backup = self.root / f"{pack_id}.old"
                            if backup.exists():
                                shutil.rmtree(backup, ignore_errors=True)
                            if dest.exists():
                                os.replace(dest, backup)
                            try:
                                os.replace(stage, dest)
                            except Exception:
                                if backup.exists() and not dest.exists():
                                    os.replace(backup, dest)
                                raise
                            if backup.exists():
                                shutil.rmtree(backup, ignore_errors=True)

                        prefs = self._prefs()
                        prefs["active_pack"] = pack_id
                        self._save_prefs(prefs)
                        task.update(
                            phase="ready",
                            received_bytes=_dir_size(self.packs_dir / pack_id),
                            total_bytes=_dir_size(self.packs_dir / pack_id),
                            updated_at=time.time(),
                            error=None,
                        )
                        atomic_json(self.task_path, task)
                except Exception as exc:
                    log.warning("font pack download failed (%s): %s", pack_id, exc)
                    task = _read_json(self.task_path) or {"pack_id": pack_id}
                    task.update(
                        pack_id=pack_id,
                        phase="error",
                        updated_at=time.time(),
                        error=str(exc) or "下载失败，请检查网络或代理后重试。",
                    )
                    atomic_json(self.task_path, task)
                finally:
                    ready.set()

            threading.Thread(target=worker, daemon=True, name=f"font-dl-{pack_id}").start()
            ready.wait(timeout=2)
        return self.state()

    def activate(self, pack_id: str) -> dict[str, Any]:
        if pack_id != "system" and self._installed_manifest(pack_id) is None:
            raise FileNotFoundError(f"字体包尚未安装: {pack_id}")
        prefs = self._prefs()
        prefs["active_pack"] = pack_id
        self._save_prefs(prefs)
        return self.state()

    def set_preferences(self, *, bold_style: str | None = None) -> dict[str, Any]:
        prefs = self._prefs()
        if bold_style is not None:
            if bold_style not in BOLD_STYLES:
                raise ValueError("不支持的字重策略")
            prefs["bold_style"] = bold_style
        self._save_prefs(prefs)
        return self.state()

    def delete_pack(self, pack_id: str) -> dict[str, Any]:
        if not PACK_ID_RE.match(pack_id):
            raise ValueError("无效的字体包标识")
        pdir = self.packs_dir / pack_id
        if pdir.exists():
            shutil.rmtree(pdir, ignore_errors=True)
        prefs = self._prefs()
        if prefs["active_pack"] == pack_id:
            prefs["active_pack"] = "system"
            self._save_prefs(prefs)
        return self.state()

    def import_local(self, filename: str, blob: bytes) -> dict[str, Any]:
        clean_name = Path(filename or "custom.woff2").name
        ext = Path(clean_name).suffix.lower()
        if ext not in ALLOWED_LOCAL_EXTS:
            raise ValueError("仅支持导入 .woff2、.ttf 或 .otf 字体文件")
        if len(blob) > MAX_LOCAL_FONT_BYTES:
            raise ValueError("字体文件不能超过 40 MB")
        _check_magic(blob)
        safe_file = f"custom{ext}"
        self._ensure_dirs()
        with tempfile.TemporaryDirectory(prefix="custom-", dir=self.root) as tmp:
            stage = Path(tmp)
            (stage / safe_file).write_bytes(blob)
            manifest = {
                "pack_id": "custom",
                "name": f"本地导入：{clean_name}",
                "mode": "enhanced",
                "faces": [{
                    "family": "GA CJK Sans",
                    "file": safe_file,
                    "weight": "100 900",
                    "style": "normal",
                    "format": _font_format(safe_file),
                }],
            }
            atomic_json(stage / "manifest.json", manifest)
            dest = self.packs_dir / "custom"
            if dest.exists():
                shutil.rmtree(dest, ignore_errors=True)
            os.replace(stage, dest)
        prefs = self._prefs()
        prefs["active_pack"] = "custom"
        self._save_prefs(prefs)
        return self.state()

    def manifest(self, pack_id: str) -> dict[str, Any]:
        manifest = self._installed_manifest(pack_id)
        if manifest is None:
            raise FileNotFoundError(f"字体包不存在或未安装: {pack_id}")
        return manifest

    def resolve_file(self, pack_id: str, filename: str) -> Path:
        if not PACK_ID_RE.match(pack_id) or not FILENAME_RE.match(filename):
            raise ValueError("无效的字体文件路径")
        base = (self.packs_dir / pack_id).resolve()
        target = (base / filename).resolve()
        if target.parent != base or not target.is_file():
            raise FileNotFoundError("字体文件不存在")
        return target


def default_font_manager() -> FontManager:
    return FontManager()
