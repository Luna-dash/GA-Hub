"""Optional downloadable / local font pack endpoints (stored under ADMIN_DATA/fonts)."""
from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..services import font_service
from ..services.font_service import MAX_LOCAL_FONT_BYTES

router = APIRouter(prefix="/api/appearance/fonts", tags=["appearance"])

FONT_MEDIA_TYPES = {
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}


class FontPackInfoResp(BaseModel):
    id: str
    name: str
    summary: str
    license: str
    mode: str
    approx_bytes: int
    installed: bool
    installed_bytes: int
    active: bool
    removable: bool


class FontDownloadResp(BaseModel):
    pack_id: str
    phase: str
    received_bytes: int = 0
    total_bytes: int | None = None
    updated_at: float | None = None
    error: str | None = None


class FontSettingsResp(BaseModel):
    active_pack: str
    bold_style: str
    packs: list[FontPackInfoResp]
    download: FontDownloadResp | None = None


class FontFaceEntryResp(BaseModel):
    family: str
    file: str
    weight: str
    style: str
    format: str
    unicodeRange: str | None = None


class FontPackManifestResp(BaseModel):
    pack_id: str
    name: str
    mode: str
    faces: list[FontFaceEntryResp]


class FontPackSelectReq(BaseModel):
    pack_id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$")


class FontPreferencesReq(BaseModel):
    bold_style: str | None = Field(default=None, pattern=r"^(?:restrained|standard)$")


def _manager():
    return font_service.default_font_manager()


@router.get("", response_model=FontSettingsResp)
def get_font_settings():
    return _manager().state()


@router.post("/download", response_model=FontSettingsResp)
def download_font_pack(body: FontPackSelectReq):
    try:
        return _manager().start_download(body.pack_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except TimeoutError as exc:
        raise HTTPException(409, "已有字体下载任务正在进行，请稍候") from exc


@router.post("/activate", response_model=FontSettingsResp)
def activate_font_pack(body: FontPackSelectReq):
    try:
        return _manager().activate(body.pack_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.put("/preferences", response_model=FontSettingsResp)
def update_font_preferences(body: FontPreferencesReq):
    try:
        return _manager().set_preferences(bold_style=body.bold_style)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.post("/import", response_model=FontSettingsResp)
async def import_local_font(file: UploadFile = File(...)):
    data = await file.read(MAX_LOCAL_FONT_BYTES + 1)
    if len(data) > MAX_LOCAL_FONT_BYTES:
        raise HTTPException(413, "字体文件不能超过 40 MB")
    try:
        return _manager().import_local(file.filename or "custom.woff2", data)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.delete("/{pack_id}", response_model=FontSettingsResp)
def delete_font_pack(pack_id: str):
    try:
        return _manager().delete_pack(pack_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/packs/{pack_id}/manifest", response_model=FontPackManifestResp)
def get_font_pack_manifest(pack_id: str):
    try:
        return _manager().manifest(pack_id)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc


@router.get("/packs/{pack_id}/files/{filename}")
def get_font_pack_file(pack_id: str, filename: str):
    try:
        path = _manager().resolve_file(pack_id, filename)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    media_type = FONT_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    return FileResponse(
        path,
        media_type=media_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )
