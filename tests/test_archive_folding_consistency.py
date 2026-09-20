"""The public archive bridge must project paths and text identically.

Hub uses text projection for bounded archive pages and path projection for full
reads. This paired-repo test protects that public contract, including GA's
auto-continuation folding semantics.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from server import _paths
from server.services.archive_messages import _extract_ui_messages_from_text

pytestmark = pytest.mark.skipif(
    not _paths.GA_ROOT, reason="requires a discoverable GA checkout"
)


def _round(index: int) -> str:
    return (
        f"=== Prompt === 2026-08-05 09:10:{index:02d}\n"
        f'{{"role":"user","content":[{{"type":"text","text":"question {index}"}}]}}\n'
        f"=== Response === 2026-08-05 09:11:{index:02d}\n"
        f"[{{'type': 'text', 'text': 'answer {index}'}}]\n"
    )


def _continuation(index: int) -> str:
    """A prompt that yields no user text — drives the auto-continuation
    branch of the folding loop (Turn N marker accumulation)."""
    return (
        f"=== Prompt === 2026-08-05 09:12:{index:02d}\n"
        f'{{"role":"user","content":[]}}\n'
        f"=== Response === 2026-08-05 09:13:{index:02d}\n"
        f"[{{'type': 'text', 'text': 'continuation {index}'}}]\n"
    )


def test_hub_text_projection_matches_public_path_projection(tmp_path: Path) -> None:
    _paths.bootstrap_sys_path()
    from frontends.gahub.bridge.archive import project_archive_path

    content = "".join(_round(i) + _continuation(i) for i in range(3))
    archive = tmp_path / "archive.txt"
    archive.write_text(content, encoding="utf-8")

    path_messages = project_archive_path(str(archive))
    assert path_messages, "fixture should produce messages"
    assert any(
        "LLM Running (Turn 2)" in str(m.get("content")) for m in path_messages
    ), "fixture should exercise the auto-continuation branch"

    assert _extract_ui_messages_from_text(content) == path_messages
