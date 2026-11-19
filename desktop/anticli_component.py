"""Build-time only: verify and freeze the reviewed AntiCLI source snapshot."""
from __future__ import annotations

import hashlib
from pathlib import Path
import subprocess
import sys

from .runtime_dependencies import runtime_binary_args

SOURCE_VERSION = "0.1.0"
SOURCE_SHA256 = "9f077937c8f9d952015bea5e8eda76698172dacce49768661083ff6899a3bfe1"

# AntiCLI's model lookup runs in both the daemon and the standalone command.
# Hiding the outer CLI process does not hide this Windows console subprocess.
_MODEL_PROBE = b'''        proc = await asyncio.create_subprocess_exec(
            str(agy_bin),
            "models",
            env=agy_proxy_env(),
'''
_QUIET_MODEL_PROBE = _MODEL_PROBE + (
    b'            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,\n'
)


def _replace_once(content: bytes, old: bytes, new: bytes, label: str) -> bytes:
    if content.count(old) != 1:
        raise RuntimeError(f"Cannot apply AntiCLI {label} fix to the pinned source")
    return content.replace(old, new, 1)


def _retry_empty_conversation(content: bytes) -> bytes:
    """Patch only the reviewed snapshot. Keep the existing spawn/reap and slot logic."""
    start = b"                spawn = asyncio.create_task(asyncio.create_subprocess_exec(\n"
    end = b"                    cleanup.result()\n                    raise\n"
    if content.count(start) != 1 or content.count(end) != 1:
        raise RuntimeError("Cannot locate the pinned AntiCLI execution block")
    first = content.index(start)
    last = content.index(end, first) + len(end)
    block = content[first:last]
    emit = b'''                            if evt is not None:
                                self.ledger.append_event(evt)
                                self.coordinator.publish(run_id, evt.model_dump())
                                if on_event is not None:
                                    on_event(evt)
'''
    buffered = b'''                            if evt is None:
                                continue
                            if pending is not None:
                                emit_event(pending)
                                pending = None
                            if (attempt == 0 and retry_enabled and len(state.events) == 1
                                    and evt.event_type == "result" and not state.conversation_id
                                    and state.result_status == "ERROR" and not state.final_answer
                                    and state.result_error == empty_conversation_error):
                                pending = evt
                            else:
                                emit_event(evt)
'''
    block = _replace_once(block, emit, buffered, "startup event buffering")
    block = _replace_once(block, b"                    assert proc.stdout is not None\n",
                          b"                    nonlocal pending\n                    assert proc.stdout is not None\n",
                          "startup event buffering")
    block = _replace_once(block, b"                        timeout=float(validated.timeout_seconds) + 5.0,\n",
                          b"                        timeout=max(0.0, deadline - time.monotonic()),\n",
                          "startup retry deadline")
    setup = b'''                # Retry only a fresh read-only Hub turn, when the CLI explicitly reports
                # that it could not create a conversation and no other event was seen.
                retry_enabled = (validated.caller_id == "ga-hub" and validated.mode == "plan"
                                 and validated.disable_slash_commands and not validated.conversation_id)
                empty_conversation_error = (
                    "failed to start conversation: backend returned an empty conversation id"
                )
                deadline = started_mono + float(validated.timeout_seconds) + 5.0

                def emit_event(evt):
                    self.ledger.append_event(evt)
                    self.coordinator.publish(run_id, evt.model_dump())
                    if on_event is not None:
                        on_event(evt)

                for attempt in range(2):
                    pending = None
'''
    finish = b'''                    if pending is None:
                        break
                    outcome = classify_outcome(exit_code, timed_out, "".join(stderr_chunks), state)
                    if (outcome[:2] != ("cli_error", "CLI_ERROR")
                            or deadline - time.monotonic() < 1.0):
                        emit_event(pending)
                        break
                    # Child has exited and both readers drained; preserve the first failure
                    # without publishing a terminal result to the Hub under the same run ID.
                    trace_path.replace(run_dir / "startup-retry.ndjson")
                    await asyncio.sleep(0.25)
                    if deadline <= time.monotonic():
                        (run_dir / "startup-retry.ndjson").replace(trace_path)
                        emit_event(pending)
                        break
                    state = StreamParseState(run_id=run_id, model=target_model)
                    stderr_chunks.clear()
'''
    return content[:first] + setup + b"".join(
        b"    " + line if line.strip() else line for line in block.splitlines(keepends=True)
    ) + finish + content[last:]


def stage_source(source: Path, destination: Path) -> Path:
    root = source / "src"
    files = sorted(p for p in (root / "anticli").rglob("*")
                   if p.is_file() and p.suffix in (".py", ".html"))
    snapshot = [(p.relative_to(root), p.read_bytes().replace(b"\r\n", b"\n")) for p in files]
    digest = hashlib.sha256(b"".join(path.as_posix().encode() + b"\0" + hashlib.sha256(data).digest()
                                     for path, data in snapshot)).hexdigest()
    if digest != SOURCE_SHA256:
        raise RuntimeError(f"AntiCLI {SOURCE_VERSION} source checksum mismatch: {digest}")
    for name, content in snapshot:
        if name.as_posix() == "anticli/core/runner.py":
            content = _replace_once(content, _MODEL_PROBE, _QUIET_MODEL_PROBE, "model probe window")
            content = _retry_empty_conversation(content)
            compile(content, name.as_posix(), "exec")
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return destination


def build_anticli(source: Path, workspace: Path, *, python: str = sys.executable,
                  windows: bool = sys.platform == "win32") -> Path:
    from tempfile import TemporaryDirectory

    name = "anticli.exe" if windows else "anticli"
    workspace.mkdir(parents=True, exist_ok=True)
    built = workspace / "dist" / name
    built.unlink(missing_ok=True)
    binaries = []
    if windows:
        prefix = subprocess.check_output([python, "-c", "import sys; print(sys.prefix)"],
                                         encoding="utf-8").strip()
        binaries = runtime_binary_args(Path(prefix))
    with TemporaryDirectory(prefix="source-", dir=workspace) as snapshot:
        staged = stage_source(source, Path(snapshot))
        subprocess.run([python, "-m", "PyInstaller", "--clean", "--noconfirm", "--onefile",
                        "--name", "anticli", "--paths", str(staged),
                        "--workpath", str(workspace / "work"), "--specpath", str(workspace),
                        "--distpath", str(built.parent), "--collect-data", "anticli", *binaries,
                        str(Path(__file__).with_name("anticli_entry.py"))], check=True, cwd=staged)
    if not built.is_file() or not built.stat().st_size:
        raise RuntimeError("AntiCLI component build did not produce an executable")
    return built
