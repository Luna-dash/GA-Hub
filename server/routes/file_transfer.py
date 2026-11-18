"""The shared file index. Clearing it does not modify delivered files."""
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel

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


@router.get("")
def list_files() -> list[TransferredFile]:
    return [TransferredFile(**row) for row in FileTransfer().list()]


@router.delete("", status_code=204, response_class=Response)
def clear_files() -> Response:
    FileTransfer().clear()
    return Response(status_code=204)
