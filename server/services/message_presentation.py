"""Hub-owned message presentation. Gateways never interpret transcripts.

The Node adapter runs the same TypeScript semantics as MessageBubble. Responses
are request-correlated and cancellation retires the process before lock release.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import time
import uuid
import sys
from pathlib import Path

log = logging.getLogger(__name__)

_REQUEST_TIMEOUT_SECONDS = 15.0
_SLOW_LOG_THRESHOLD_MS = 250.0
_STDERR_CHUNK_BYTES = 8192


def node_executable() -> str:
    """Frozen apps must never depend on (or silently use) a machine's PATH."""
    if getattr(sys, 'frozen', False):
        root = Path(sys._MEIPASS)
        executable = root / 'runtime' / 'node' / ('node.exe' if sys.platform == 'win32' else 'node')
        if not executable.is_file():
            raise RuntimeError('Packaged Node runtime is missing; reinstall the complete GA-Hub release')
        return str(executable)
    executable = shutil.which('node')
    if not executable:
        raise RuntimeError('Message presentation requires Node in development mode')
    return executable


class MessagePresentation:
    def __init__(self, *, timeout_seconds: float = _REQUEST_TIMEOUT_SECONDS):
        self._lock = asyncio.Lock()
        self._worker = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._stderr_bytes = 0
        self._timeout_seconds = timeout_seconds
        self._requests = 0
        self._spawns = 0
        self._restarts = 0
        self._timeouts = 0
        self._errors = 0
        self._cancellations = 0
        self._queued_cancellations = 0
        self._active_cancellations = 0
        self._last_lock_wait_ms = 0.0
        self._last_exec_ms = 0.0
        self._max_lock_wait_ms = 0.0
        self._max_exec_ms = 0.0
        self._last_error: str | None = None

    def metrics(self) -> dict[str, object]:
        """Metadata-only observability snapshot (never includes message bodies)."""
        return {
            'requests': self._requests,
            'spawns': self._spawns,
            'restarts': self._restarts,
            'timeouts': self._timeouts,
            'errors': self._errors,
            'cancellations': self._cancellations,
            'queued_cancellations': self._queued_cancellations,
            'active_cancellations': self._active_cancellations,
            'last_lock_wait_ms': round(self._last_lock_wait_ms, 2),
            'last_exec_ms': round(self._last_exec_ms, 2),
            'max_lock_wait_ms': round(self._max_lock_wait_ms, 2),
            'max_exec_ms': round(self._max_exec_ms, 2),
            'last_error': self._last_error,
            'worker_alive': self._worker is not None and self._worker.returncode is None,
        }

    async def _drain_stderr(self, stream) -> None:
        try:
            # Keep draining even if stderr has no newlines; never retain its contents.
            while chunk := await stream.read(_STDERR_CHUNK_BYTES):
                self._stderr_bytes += len(chunk)
        except Exception:
            pass

    async def _stop_stderr_task(self) -> None:
        task, self._stderr_task = self._stderr_task, None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def close(self):
        worker, self._worker = self._worker, None
        try:
            if worker is not None:
                if worker.returncode is None:
                    try:
                        worker.kill()
                    except ProcessLookupError:
                        pass  # Exited between checking returncode and killing it.
                await worker.wait()
        finally:
            await self._stop_stderr_task()

    async def page(self, data, *, kind="history"):
        self._requests += 1
        wait_started = time.monotonic()
        try:
            await self._lock.acquire()
        except asyncio.CancelledError:
            lock_wait_ms = self._record_lock_wait(wait_started)
            self._cancellations += 1
            self._queued_cancellations += 1
            self._last_error = 'cancelled'
            log.debug("message_presentation cancelled while queued kind=%s lock_wait_ms=%.1f", kind, lock_wait_ms)
            raise

        try:
            lock_wait_ms = self._record_lock_wait(wait_started)
            return await self._page_locked(data, kind, lock_wait_ms)
        finally:
            self._lock.release()

    def _record_lock_wait(self, wait_started: float) -> float:
        elapsed = (time.monotonic() - wait_started) * 1000.0
        self._last_lock_wait_ms = elapsed
        self._max_lock_wait_ms = max(self._max_lock_wait_ms, elapsed)
        return elapsed

    async def _page_locked(self, data, kind: str, lock_wait_ms: float):
        spawn_ms: float | None = None
        exec_started = time.monotonic()
        try:
            try:
                worker = self._worker
                if worker is None or worker.returncode is not None:
                    was_restart = self._spawns > 0
                    prev_rc = worker.returncode if worker is not None else None
                    await self._stop_stderr_task()
                    self._stderr_bytes = 0
                    spawn_started = time.monotonic()
                    worker = self._worker = await asyncio.create_subprocess_exec(
                        node_executable(), str(Path(__file__).with_name('message-presentation-worker.cjs')),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE, limit=32 * 1024 * 1024,
                        **({'creationflags': 0x08000000} if sys.platform == 'win32' else {}),
                    )
                    if worker.stderr is not None:
                        self._stderr_task = asyncio.create_task(self._drain_stderr(worker.stderr))
                    spawn_ms = (time.monotonic() - spawn_started) * 1000.0
                    self._spawns += 1
                    if was_restart:
                        self._restarts += 1
                        log.warning(
                            "message_presentation worker restarted kind=%s prev_returncode=%s spawn_ms=%.1f restarts=%d",
                            kind, prev_rc, spawn_ms, self._restarts,
                        )
                    else:
                        log.info(
                            "message_presentation worker started kind=%s spawn_ms=%.1f",
                            kind, spawn_ms,
                        )
                request_id = uuid.uuid4().hex
                request = json.dumps({'id': request_id, 'kind': kind, 'data': data}, ensure_ascii=False)
                worker.stdin.write((request + '\n').encode('utf-8'))
                await worker.stdin.drain()
                raw = await asyncio.wait_for(worker.stdout.readline(), self._timeout_seconds)
                reply = json.loads(raw)
                if reply.get('id') != request_id or 'error' in reply or not isinstance(reply.get('data'), dict):
                    raise RuntimeError('Invalid message presentation response')
            finally:
                # Includes startup if needed, but not worker retirement on failure.
                exec_ms = (time.monotonic() - exec_started) * 1000.0
                self._last_exec_ms = exec_ms
                self._max_exec_ms = max(self._max_exec_ms, exec_ms)
        except asyncio.CancelledError:
            self._cancellations += 1
            self._active_cancellations += 1
            self._last_error = 'cancelled'
            log.warning(
                "message_presentation cancelled kind=%s lock_wait_ms=%.1f exec_ms=%.1f",
                kind, lock_wait_ms, exec_ms,
            )
            await self.close()
            raise
        except BaseException as exc:
            self._errors += 1
            self._last_error = type(exc).__name__
            worker = self._worker
            try:
                await self.close()
            finally:
                rc = worker.returncode if worker is not None else None
                if isinstance(exc, TimeoutError):
                    self._timeouts += 1
                    self._last_error = 'timeout'
                    log.warning(
                        "message_presentation timeout kind=%s timeout_s=%.1f returncode=%s lock_wait_ms=%.1f exec_ms=%.1f stderr_bytes=%d",
                        kind, self._timeout_seconds, rc, lock_wait_ms, exec_ms, self._stderr_bytes,
                    )
                else:
                    log.warning(
                        "message_presentation failed kind=%s error=%s returncode=%s lock_wait_ms=%.1f exec_ms=%.1f stderr_bytes=%d",
                        kind, type(exc).__name__, rc, lock_wait_ms, exec_ms, self._stderr_bytes,
                    )
            raise

        if lock_wait_ms >= _SLOW_LOG_THRESHOLD_MS or exec_ms >= _SLOW_LOG_THRESHOLD_MS:
            log.info(
                "message_presentation slow kind=%s lock_wait_ms=%.1f exec_ms=%.1f spawn_ms=%s",
                kind, lock_wait_ms, exec_ms, f"{spawn_ms:.1f}" if spawn_ms is not None else "none",
            )
        else:
            log.debug(
                "message_presentation ok kind=%s lock_wait_ms=%.1f exec_ms=%.1f",
                kind, lock_wait_ms, exec_ms,
            )
        return reply['data']

    async def progress(self, frame, session_id):
        """Project an authoritative snapshot using the desktop merge implementation."""
        if frame.get('session_id') != session_id:
            raise ValueError('Snapshot session mismatch')
        return await self.page(frame, kind='progress')


def presentation_of(app):
    service = getattr(app.state, 'message_presentation', None)
    if service is None:
        service = app.state.message_presentation = MessagePresentation()
    return service
