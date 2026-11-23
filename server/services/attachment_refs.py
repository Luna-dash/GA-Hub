"""Hub-only reference preflight. Never copy, hash or parse file contents."""
from __future__ import annotations

from pathlib import Path
import stat as stat_mod

from .. import _paths


def validate_attachments(attachments: list[dict]) -> None:
    if len(attachments) > 256:
        raise ValueError("一次最多添加256个附件")
    uploads_root = _paths.admin_uploads_dir().resolve()
    for attachment in attachments:
        raw = attachment.get("path", "")
        name = attachment.get("name") or raw
        source = attachment.get("source")
        try:
            if not isinstance(raw, str) or not raw or any(c in raw for c in "\r\n\x00"):
                raise ValueError("无效路径")
            if raw.startswith(("//", "\\\\")):
                raise ValueError("不支持网络共享或设备路径")
            path = Path(raw)
            if not path.is_absolute():
                raise ValueError("文件不存在或不是绝对文件路径")
            lstat = path.lstat()
            if stat_mod.S_ISLNK(lstat.st_mode) or not stat_mod.S_ISREG(lstat.st_mode):
                raise ValueError("不支持符号链接或非普通文件")
            if source == "managed_upload":
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(uploads_root):
                    raise ValueError("上传附件路径不在受管目录内")
            # Open only: access under the actual Hub/GA execution identity.
            with path.open("rb"):
                pass
        except (OSError, ValueError) as exc:
            raise ValueError(f"附件不可用：{name}（{exc}）。请重新定位或移除附件。") from exc
