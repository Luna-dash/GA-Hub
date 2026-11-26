"""The shared file index. Clearing it does not modify delivered files."""
from sqlite3 import Error as DatabaseError
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from ..services.file_transfer import FileTransfer

router = APIRouter(prefix="/api/file-transfer", tags=["file-transfer"])


class TransferredFile(BaseModel):
    id: int
    path: str
    name: str
    engine: Literal["chat", "anti"]
    session_id: str
    project: str | None
    available: bool
    size: int


class TransferSource(BaseModel):
    engine: Literal["chat", "anti"]
    session_id: str = Field(min_length=1, max_length=256)
    project: str | None = Field(default=None, max_length=1024)


class AddTransferredFile(TransferSource):
    path: str = Field(min_length=1, max_length=4096)


class SaveReplyDocument(TransferSource):
    text: str = Field(min_length=1, max_length=1_000_000)


class ClearTransferDocumentsResp(BaseModel):
    deleted: int


@router.post("/reply", status_code=204, response_class=Response)
def save_reply(body: SaveReplyDocument) -> Response:
    try:
        FileTransfer().save_reply(body.text, body.engine, body.session_id, body.project)
    except ValueError as exc:
        raise HTTPException(422, "回复内容为空或格式无效") from exc
    except (OSError, DatabaseError, RuntimeError) as exc:
        raise HTTPException(500, "无法保存回复文档") from exc
    return Response(status_code=204)


@router.post("", status_code=204, response_class=Response)
def add_file(body: AddTransferredFile) -> Response:
    try:
        FileTransfer().add(body.path, body.engine, body.session_id, body.project)
    except (ValueError, OSError, RuntimeError) as exc:
        raise HTTPException(422, "文件不存在或不是本地文件") from exc
    return Response(status_code=204)


@router.get("")
def list_files() -> list[TransferredFile]:
    return [TransferredFile(**row) for row in FileTransfer().list()]


@router.delete("", status_code=204, response_class=Response)
def clear_files() -> Response:
    FileTransfer().clear()
    return Response(status_code=204)


@router.delete("/documents", response_model=ClearTransferDocumentsResp)
def clear_documents() -> ClearTransferDocumentsResp:
    try:
        deleted = FileTransfer().clear_documents()
    except (OSError, DatabaseError, RuntimeError) as exc:
        raise HTTPException(500, "无法清空暂存文档") from exc
    return ClearTransferDocumentsResp(deleted=deleted)
