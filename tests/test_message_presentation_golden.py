"""Shared TS/Python golden contract & runtime tests for pure-Python MessagePresentation."""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from server.services.message_presentation import MessagePresentation
from server.services.transcript_protocol import remote_message_page, remote_progress

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_PATH = ROOT / "tests" / "fixtures" / "message_presentation_golden.json"


def _run_ts_reference() -> dict[str, object] | None:
    node = shutil.which("node")
    esbuild = ROOT / "webui" / "node_modules" / "esbuild"
    if node is None or not esbuild.is_dir():
        return None
    script = (
        "const fs = require('node:fs');"
        "const path = require('node:path');"
        "const vm = require('node:vm');"
        "const root = process.cwd();"
        "const esbuild = require(path.join(root, 'webui/node_modules/esbuild'));"
        "const built = esbuild.buildSync({"
        "  absWorkingDir: root,"
        "  entryPoints: [path.join(root, 'webui/src/utils/messagePresentation.ts')],"
        "  bundle: true, platform: 'node', format: 'cjs', target: ['node18'], write: false,"
        "});"
        "const mod = { exports: {} };"
        "const fn = new Function('require', 'module', 'exports', Buffer.from(built.outputFiles[0].contents).toString('utf8'));"
        "fn(require, mod, mod.exports);"
        "const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/message_presentation_golden.json'), 'utf8'));"
        "const out = {"
        "  pages: Object.fromEntries(fixture.pages.map(tc => [tc.name, mod.exports.remoteMessagePage(tc.input)])),"
        "  progress: Object.fromEntries(fixture.progress.map(tc => [tc.name, mod.exports.remoteProgress(tc.input)])),"
        "};"
        "process.stdout.write(JSON.stringify(out));"
    )
    proc = subprocess.run(
        [node, "-e", script],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
        check=True,
    )
    return json.loads(proc.stdout)


def test_python_matches_typescript_reference_bit_for_bit() -> None:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    ts_ref = _run_ts_reference()
    if ts_ref is None:
        pytest.skip("node / esbuild not available in test environment")

    for tc in fixture["pages"]:
        py_out = remote_message_page(tc["input"])
        assert py_out == ts_ref["pages"][tc["name"]], f"page mismatch on {tc['name']}"

    for tc in fixture["progress"]:
        py_out = remote_progress(tc["input"])
        assert py_out == ts_ref["progress"][tc["name"]], f"progress mismatch on {tc['name']}"


def test_pure_python_presentation_works_without_path_or_node() -> None:
    async def _run() -> None:
        with patch.dict(os.environ, {"PATH": ""}):
            service = MessagePresentation()
            try:
                page = await service.page({"items": [{"id": "m", "role": "user", "content": "跨机消息"}]})
                assert page["presentation_version"] == 1
                assert page["items"][0]["content"] == "跨机消息"
                progress = await service.progress(
                    {"type": "snapshot", "session_id": "s", "runtime": {"status": "idle"}, "streams": []},
                    "s",
                )
                assert progress["type"] == "progress"
                assert progress["session_id"] == "s"
                assert progress["presentation_version"] == 1
                stats = service.metrics()
                assert stats["requests"] == 2
                assert stats["spawns"] == 0
                assert stats["errors"] == 0
                assert stats["worker_alive"] is False
                assert stats["mode"] == "python"
            finally:
                await service.close()

    asyncio.run(_run())


def test_observability_never_logs_message_body(caplog: pytest.LogCaptureFixture) -> None:
    secret = "TOP_SECRET_MESSAGE_BODY_999"

    async def _run() -> None:
        service = MessagePresentation()
        with caplog.at_level("DEBUG", logger="server.services.message_presentation"):
            page = await service.page({"items": [{"id": "m1", "role": "user", "content": secret}]})
            assert page["items"][0]["content"] == secret

    asyncio.run(_run())
    assert secret not in caplog.text
