"""Node packaging and compact presentation work without a machine Node install."""
from __future__ import annotations

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
        import asyncio
        from server import desktop_sidecar
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, 'frozen', True, create=True), patch.object(
            sys, '_MEIPASS', tmp, create=True,
        ), patch.object(desktop_sidecar, 'selftest_modules', return_value=()), patch.object(desktop_sidecar, '_diagnostic') as diagnostic:
            # run_selftest owns its event loop, just as the real CLI does.
            result = await asyncio.to_thread(desktop_sidecar.run_selftest)
            self.assertEqual(result, 1)
            self.assertIn('Packaged Node runtime is missing', diagnostic.call_args.args[0])
