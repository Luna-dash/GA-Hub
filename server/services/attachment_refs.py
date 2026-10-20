"""Hub-only reference preflight. Never copy, hash or parse file contents."""
from __future__ import annotations

from pathlib import Path


def validate_attachments(attachments: list[dict]) -> None:
    if len(attachments) > 256:
        raise ValueError("一次最多添加256个附件")
    for attachment in attachments:
        raw = attachment.get("path", "")
        name = attachment.get("name") or raw
        try:
            if not isinstance(raw, str) or not raw or any(c in raw for c in "\r\n\x00"):
                raise ValueError("无效路径")
            path = Path(raw)
            if not path.is_absolute() or not path.is_file():
                raise ValueError("文件不存在或不是绝对文件路径")
            # Open only: access under the actual Hub/GA execution identity.
            with path.open("rb"):
                pass
        except (OSError, ValueError) as exc:
            raise ValueError(f"附件不可用：{name}（{exc}）。请重新定位或移除附件。") from exc
