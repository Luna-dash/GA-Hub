"""Node packaging and compact presentation work without a machine Node install."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

from desktop.node_runtime import stage_node
from server.services import message_presentation as presentation


class NodeStageTests(unittest.TestCase):
    def test_stage_records_runtime_and_license(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node = root / 'node.exe'
            node.write_bytes(b'runtime')
            license_path = root / 'LICENSE'
            license_path.write_text('Node.js Permission license', encoding='utf8')
            info = {'version': 'v24.13.0', 'arch': 'x64', 'platform': 'win32'}
            with patch('desktop.node_runtime.shutil.which', return_value=str(node)), patch(
                'desktop.node_runtime.subprocess.run', return_value=Mock(stdout=json.dumps(info)),
            ), patch.dict(os.environ, {'GA_HUB_NODE_LICENSE': str(license_path)}):
                staged = stage_node(root / 'stage', 'x86_64-pc-windows-msvc')
            self.assertEqual((staged / 'node.exe').read_bytes(), b'runtime')
            self.assertEqual((staged / 'LICENSE').read_text(), 'Node.js Permission license')
            manifest = json.loads((staged / 'runtime.json').read_text())
            self.assertEqual(manifest['version'], info['version'])
            self.assertEqual(len(manifest['sha256']), 64)

    def test_missing_node_fails(self):
        with patch('desktop.node_runtime.shutil.which', return_value=None):
            with self.assertRaisesRegex(RuntimeError, 'Node 20'):
                stage_node(Path('unused'), 'x86_64-pc-windows-msvc')

    def test_old_or_wrong_target_fails_before_staging(self):
        for version, arch, platform in [('v18.0.0', 'x64', 'win32'), ('v24.0.0', 'arm64', 'win32'), ('v24.0.0', 'x64', 'linux')]:
            info = dict(version=version, arch=arch, platform=platform)
            with self.subTest(info=info), patch('desktop.node_runtime.shutil.which', return_value='node'), patch(
                'desktop.node_runtime.subprocess.run', return_value=Mock(stdout=json.dumps(info)),
            ):
                with self.assertRaises(RuntimeError):
                    stage_node(Path('unused'), 'x86_64-pc-windows-msvc')

    def test_frozen_missing_runtime_does_not_fallback(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, 'frozen', True, create=True), patch.object(
            sys, '_MEIPASS', tmp, create=True,
        ), patch.object(presentation.shutil, 'which') as which:
            with self.assertRaisesRegex(RuntimeError, 'Packaged Node runtime is missing'):
                presentation.node_executable()
            which.assert_not_called()

    def test_development_uses_path(self):
        with patch.object(sys, 'frozen', False, create=True), patch.object(presentation.shutil, 'which', return_value='dev-node'):
            self.assertEqual(presentation.node_executable(), 'dev-node')


class BundledPresentationTests(unittest.IsolatedAsyncioTestCase):
    async def test_history_and_progress_with_empty_path(self):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'Node is required for the real compact protocol regression')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runtime = root / 'runtime' / 'node'
            runtime.mkdir(parents=True)
            shutil.copy2(node, runtime / ('node.exe' if sys.platform == 'win32' else 'node'))
            with patch.object(sys, 'frozen', True, create=True), patch.object(sys, '_MEIPASS', tmp, create=True), patch.dict(os.environ, {'PATH': ''}):
                service = presentation.MessagePresentation()
                try:
                    page = await service.page({'items': [{'id': 'm', 'role': 'user', 'content': '跨机消息'}]})
                    self.assertEqual(page['presentation_version'], 1)
                    self.assertEqual(page['items'][0]['content'], '跨机消息')
                    progress = await service.progress({'type': 'snapshot', 'session_id': 's', 'runtime': {'status': 'idle'}, 'streams': []}, 's')
                    self.assertEqual(progress['type'], 'progress')
                    self.assertEqual(progress['session_id'], 's')
                    self.assertEqual(progress['presentation_version'], 1)
                finally:
                    await service.close()
                self.assertIsNone(service._worker)

    async def test_frozen_selftest_rejects_missing_runtime(self):
        from server import desktop_sidecar
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, 'frozen', True, create=True), patch.object(
            sys, '_MEIPASS', tmp, create=True,
        ), patch.object(desktop_sidecar, 'selftest_modules', return_value=()), patch.object(desktop_sidecar, '_diagnostic') as diagnostic:
            # run_selftest owns its event loop, just as the real CLI does.
            result = await asyncio.to_thread(desktop_sidecar.run_selftest)
            self.assertEqual(result, 1)
            self.assertIn('Packaged Node runtime is missing', diagnostic.call_args.args[0])

    async def test_observability_tracks_metrics_restarts_and_never_logs_body(self):
        secret = 'TOP_SECRET_MESSAGE_BODY_999'
        service = presentation.MessagePresentation()
        try:
            with self.assertLogs('server.services.message_presentation', level='DEBUG') as captured:
                page = await service.page({'items': [{'id': 'm1', 'role': 'user', 'content': secret}]})
                self.assertEqual(page['items'][0]['content'], secret)
                # Force a worker death and verify restart accounting.
                assert service._worker is not None
                service._worker.kill()
                await service._worker.wait()
                page2 = await service.page({'items': [{'id': 'm2', 'role': 'user', 'content': secret}]})
                self.assertEqual(page2['items'][0]['content'], secret)

            stats = service.metrics()
            self.assertEqual(stats['requests'], 2)
            self.assertEqual(stats['spawns'], 2)
            self.assertEqual(stats['restarts'], 1)
            self.assertEqual(stats['errors'], 0)
            self.assertEqual(stats['timeouts'], 0)
            self.assertTrue(stats['worker_alive'])
            joined_logs = '\n'.join(captured.output)
            self.assertIn('worker started', joined_logs)
            self.assertIn('worker restarted', joined_logs)
            self.assertNotIn(secret, joined_logs)
        finally:
            await service.close()
        self.assertFalse(service.metrics()['worker_alive'])

    def _use_python_worker(self, program, *, stream_limit=1024):
        spawn = asyncio.create_subprocess_exec

        async def spawn_test_worker(*_args, **kwargs):
            kwargs['limit'] = stream_limit
            return await spawn(sys.executable, '-u', '-c', program, **kwargs)

        return patch.object(asyncio, 'create_subprocess_exec', side_effect=spawn_test_worker)

    async def test_observability_records_timeout_without_stderr_contents(self):
        secret = 'SECRET_NEVER_LOG'
        program = """import json, sys, time
request = json.loads(sys.stdin.buffer.readline())
print(request['data']['content'], file=sys.stderr, flush=True)
time.sleep(30)
"""
        service = presentation.MessagePresentation(timeout_seconds=1)
        try:
            with self._use_python_worker(program), self.assertLogs(presentation.__name__, level='WARNING') as captured:
                with self.assertRaises(TimeoutError):
                    await service.page({'content': secret})
            stats = service.metrics()
            self.assertEqual(stats['requests'], 1)
            self.assertEqual(stats['timeouts'], 1)
            self.assertEqual(stats['errors'], 1)
            self.assertEqual(stats['last_error'], 'timeout')
            self.assertGreaterEqual(stats['last_exec_ms'], 900)
            self.assertEqual(stats['max_exec_ms'], stats['last_exec_ms'])
            self.assertFalse(stats['worker_alive'])
            self.assertIsNone(service._stderr_task)
            joined_logs = '\n'.join(captured.output)
            self.assertIn('message_presentation timeout', joined_logs)
            self.assertRegex(joined_logs, r'returncode=-?\d+')
            self.assertRegex(joined_logs, r'stderr_bytes=[1-9]\d*')
            self.assertNotIn(secret, joined_logs)
        finally:
            await service.close()

    async def test_oversize_stderr_does_not_block_worker_and_is_not_logged_on_failure(self):
        secret = 'PRIVATE_STDERR_CONTENT'
        program = """import json, sys
request = json.loads(sys.stdin.buffer.readline())
marker = request['data']['content'].encode('utf-8')
sys.stderr.buffer.write(marker * 65536)
sys.stderr.buffer.flush()
print('not a JSON response', flush=True)
"""
        service = presentation.MessagePresentation(timeout_seconds=5)
        try:
            with self._use_python_worker(program), self.assertLogs(presentation.__name__, level='WARNING') as captured:
                with self.assertRaises(json.JSONDecodeError):
                    await service.page({'content': secret})
            stats = service.metrics()
            self.assertEqual(stats['errors'], 1)
            self.assertEqual(stats['timeouts'], 0)
            self.assertEqual(stats['last_error'], 'JSONDecodeError')
            self.assertGreater(stats['last_exec_ms'], 0)
            self.assertFalse(stats['worker_alive'])
            joined_logs = '\n'.join(captured.output)
            self.assertIn('message_presentation failed', joined_logs)
            self.assertIn('stderr_bytes=', joined_logs)
            self.assertNotIn(secret, joined_logs)
        finally:
            await service.close()

    async def test_queued_and_active_cancellation_are_counted_separately(self):
        waiting_for_reply = asyncio.Event()

        class HangingStdout:
            async def readline(self):
                waiting_for_reply.set()
                await asyncio.Future()

        class Stdin:
            def write(self, _data):
                pass

            async def drain(self):
                pass

        class Worker:
            returncode = None
            stderr = None
            stdin = Stdin()
            stdout = HangingStdout()

            def kill(self):
                self.returncode = -9

            async def wait(self):
                return self.returncode

        service = presentation.MessagePresentation()
        worker = Worker()
        active = queued = None
        now = 100.0
        try:
            with (
                patch.object(presentation, 'time', Mock(monotonic=lambda: now)),
                patch.object(presentation, 'node_executable', return_value='test-node'),
                patch.object(asyncio, 'create_subprocess_exec', return_value=worker) as spawn,
            ):
                active = asyncio.create_task(service.page({}))
                await asyncio.wait_for(waiting_for_reply.wait(), 2)
                queued = asyncio.create_task(service.page({}))
                await asyncio.sleep(0)  # Let the queued call reach the held lock.
                now += 0.025
                queued.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await queued
                stats = service.metrics()
                self.assertEqual(stats['requests'], 2)
                self.assertEqual(stats['cancellations'], 1)
                self.assertEqual(stats['queued_cancellations'], 1)
                self.assertEqual(stats['active_cancellations'], 0)
                self.assertEqual(stats['last_exec_ms'], 0)
                self.assertEqual(stats['last_lock_wait_ms'], 25)
                self.assertTrue(stats['worker_alive'])
                self.assertFalse(active.done())

                active.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await active
                spawn.assert_awaited_once()
            stats = service.metrics()
            self.assertEqual(stats['requests'], 2)
            self.assertEqual(stats['cancellations'], 2)
            self.assertEqual(stats['queued_cancellations'], 1)
            self.assertEqual(stats['active_cancellations'], 1)
            self.assertEqual(stats['errors'], 0)
            self.assertEqual(stats['last_error'], 'cancelled')
            self.assertEqual(stats['last_exec_ms'], 25)
            self.assertEqual(stats['last_exec_ms'], stats['max_exec_ms'])
            self.assertFalse(stats['worker_alive'])
            self.assertFalse(service._lock.locked())
        finally:
            tasks = [task for task in (active, queued) if task is not None]
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await service.close()
