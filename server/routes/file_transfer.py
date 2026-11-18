"""The shared file index. Clearing it does not modify delivered files."""
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


class AddTransferredFile(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    engine: Literal["chat", "anti"]
    session_id: str = Field(min_length=1, max_length=256)
    project: str | None = Field(default=None, max_length=1024)


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
