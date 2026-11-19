"""Exercise the bundled retry against the locked runner, without invoking official agy."""
import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


EMPTY_ID = {
    "event": "result", "result": {
        "status": "ERROR", "conversation_id": "",
        "error": "failed to start conversation: backend returned an empty conversation id",
    },
}
SUCCESS = {
    "event": "result", "result": {"status": "SUCCESS", "conversation_id": "test-id", "response": "OK"},
}
AUTH = {"event": "result", "result": {"status": "ERROR", "error": "authentication required"}}
INIT = {"event": "init", "session_id": "started"}


@pytest.fixture(scope="module")
def snapshot(tmp_path_factory):
    from desktop.anticli_component import stage_source
    hub = Path(__file__).resolve().parents[1]
    source = Path(os.environ.get("ANTICLI_TEST_SOURCE", str(hub.parent / "anticli")))
    if not (source / "src" / "anticli" / "core" / "runner.py").is_file():
        pytest.skip("Locked AntiCLI source not available; set ANTICLI_TEST_SOURCE")
    return stage_source(source, tmp_path_factory.mktemp("staged-anticli"))


def _exercise():
    from anticli.config import AppConfig
    from anticli.core import runner
    from anticli.schemas import RunRequest
    from unittest.mock import patch

    case = json.loads(sys.stdin.read())
    workspace = Path.cwd()
    cfg = AppConfig(data_dir=workspace / "data")
    cfg.data_dir.mkdir()
    cfg.runs_dir.mkdir()
    cfg.pacing.min_interval_seconds = 0
    engine = runner.GatewayEngine(cfg)
    original_spawn = asyncio.create_subprocess_exec
    commands = []
    published = []

    async def spawn(*cmd, **kwargs):
        attempt = len(commands)
        commands.append(cmd)
        events = case["attempts"][attempt]
        output = "\n".join(map(json.dumps, events))
        rc = int(events[-1]["result"]["status"] != "SUCCESS")
        return await original_spawn(sys.executable, "-I", "-S", "-c",
                                    f"print({output!r}); raise SystemExit({rc})", **kwargs)

    request = RunRequest(workspace=str(workspace), prompt="Reply OK", model="gemini-4-neon-high",
                         caller_id="ga-hub", disable_slash_commands=True, **case["options"])
    with (patch.object(type(cfg), "resolve_agy_binary", return_value=Path(sys.executable)),
          patch.object(runner, "agy_proxy_env", return_value=os.environ.copy()),
          patch.object(asyncio, "create_subprocess_exec", new=spawn)):
        result = asyncio.run(engine.execute(request, on_event=lambda evt: published.append(json.loads(evt.raw_json))))
    trace = Path(result.trace_path)
    retry_log = trace.with_name("startup-retry.ndjson")
    print(json.dumps({"status": result.status, "answer": result.answer, "events": published,
                      "retry": retry_log.read_text(encoding="utf-8") if retry_log.exists() else None,
                      "commands": commands}))


@pytest.mark.parametrize("attempts,options,expected_status", [
    ([[EMPTY_ID], [SUCCESS]], {}, "success"),
    ([[EMPTY_ID], [EMPTY_ID]], {}, "cli_error"),
    ([[EMPTY_ID]], {"conversation_id": "00000000-0000-0000-0000-000000000001"}, "cli_error"),
    ([[INIT, EMPTY_ID]], {}, "cli_error"),
    ([[AUTH]], {}, "cli_error"),
    ([[EMPTY_ID]], {"mode": "accept-edits"}, "cli_error"),
], ids=["recovers", "at-most-once", "resume", "already-started", "auth", "write-mode"])
def test_bundled_retry(snapshot, tmp_path, attempts, options, expected_status):
    run = subprocess.run([sys.executable, str(Path(__file__).resolve())], cwd=tmp_path,
                         env={**os.environ, "PYTHONPATH": str(snapshot), "PYTHONDONTWRITEBYTECODE": "1"},
                         input=json.dumps({"attempts": attempts, "options": options}),
                         capture_output=True, encoding="utf-8", timeout=20)
    assert run.returncode == 0, run.stderr
    result = json.loads(run.stdout)
    assert result["status"] == expected_status
    assert result["events"] == attempts[-1]
    assert len(result["commands"]) == len(attempts)
    if len(attempts) == 2:
        assert result["commands"][0] == result["commands"][1]
        assert json.loads(result["retry"]) == EMPTY_ID
    else:
        assert result["retry"] is None
    if expected_status == "success":
        assert result["answer"] == "OK"


if __name__ == "__main__":
    _exercise()
