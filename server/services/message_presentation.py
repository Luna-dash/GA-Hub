"""Hub-owned message presentation. Gateways never interpret transcripts.

The Node adapter runs the same TypeScript semantics as MessageBubble. Responses
are request-correlated and cancellation retires the process before lock release.
"""
from __future__ import annotations

import asyncio
import json
import shutil
import uuid
import sys
from pathlib import Path


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
    def __init__(self):
        self._lock = asyncio.Lock()
        self._worker = None

    async def close(self):
        worker, self._worker = self._worker, None
        if worker is not None:
            if worker.returncode is None:
                worker.kill()
            await worker.wait()

    async def page(self, data, *, kind="history"):
        async with self._lock:
            try:
                worker = self._worker
                if worker is None or worker.returncode is not None:
                    worker = self._worker = await asyncio.create_subprocess_exec(
                        node_executable(), str(Path(__file__).with_name('message-presentation-worker.cjs')),
                        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL, limit=32 * 1024 * 1024,
                        **({'creationflags': 0x08000000} if sys.platform == 'win32' else {}),
                    )
                request_id = uuid.uuid4().hex
                request = json.dumps({'id': request_id, 'kind': kind, 'data': data}, ensure_ascii=False)
                worker.stdin.write((request + '\n').encode('utf-8'))
                await worker.stdin.drain()
                raw = await asyncio.wait_for(worker.stdout.readline(), 15)
                reply = json.loads(raw)
                if reply.get('id') != request_id or 'error' in reply or not isinstance(reply.get('data'), dict):
                    raise RuntimeError('Invalid message presentation response')
                return reply['data']
            except BaseException:
                await self.close()
                raise

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
