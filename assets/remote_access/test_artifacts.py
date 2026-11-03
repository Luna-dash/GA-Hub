"""Isolated artifact capabilities; no credentials or real sessions."""
import copy
import os
from pathlib import Path
import tempfile
import unittest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer
import artifacts as m

class ArtifactTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        parent = m.HUB / 'temp' / 'artifact-tests'
        parent.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(dir=parent)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'temp'
        self.root.mkdir()
        self.file = self.root / '结果 report.txt'
        self.body = 'artifact download ✓'.encode('utf-8')
        self.file.write_bytes(self.body)
        self.store = m.ArtifactStore((self.root,))
        async def handler(request):
            return await self.store.download(request, request.match_info['sid'], request.match_info['token'], request.headers.get('X-Test-Owner'))
        app = web.Application()
        app.router.add_route('*', '/api/sessions/{sid}/artifacts/{token}', handler)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.tmp.cleanup()

    def publish(self, path=None, owner='owner-a', sid='test'):
        data = {'items':[{'role':'assistant', 'compact':True, 'progress':{'final_body':'交付 [FILE:' + str(path or self.file) + ']'}}]}
        return self.store.decorate(data, sid, owner)['items'][0].get('artifacts', [])

    async def test_download_bytes_headers_and_head(self):
        file = self.publish()[0]
        self.assertNotIn(str(self.root), str(file))
        response = await self.client.get(file['url'], headers={'X-Test-Owner':'owner-a'})
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), self.body)
        self.assertEqual(response.headers['Content-Type'], 'application/octet-stream')
        self.assertIn('attachment;', response.headers['Content-Disposition'])
        self.assertEqual(response.headers['Cache-Control'], 'no-store')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        response = await self.client.head(file['url'], headers={'X-Test-Owner':'owner-a'})
        self.assertEqual(response.status, 200)
        self.assertEqual(await response.read(), b'')
        self.assertEqual(int(response.headers['Content-Length']), len(self.body))

    async def test_owner_session_and_unknown_token_rejected(self):
        file = self.publish()[0]
        for owner, url in [('owner-b',file['url']), ('owner-a',file['url'].replace('/test/', '/other/')), ('owner-a',file['url'][:-43] + 'z'*43)]:
            response = await self.client.get(url, headers={'X-Test-Owner':owner})
            self.assertEqual(response.status, 404)

    async def test_expiry_refresh_and_stable_polling(self):
        a = self.publish()[0]
        self.assertEqual(a['url'], self.publish()[0]['url'])
        self.store.entries[a['url'].split('/')[-1]]['created'] -= m.TTL + 1
        response = await self.client.get(a['url'], headers={'X-Test-Owner':'owner-a'})
        self.assertEqual(response.status, 404)
        self.assertNotEqual(a['url'], self.publish()[0]['url'])

    async def test_changed_and_removed_files_rejected(self):
        file = self.publish()[0]
        self.file.write_bytes(b'changed longer data')
        response = await self.client.get(file['url'], headers={'X-Test-Owner':'owner-a'})
        self.assertEqual(response.status, 410)
        self.file.unlink()
        self.assertEqual(self.publish(), [])

    async def test_only_compact_assistant_final_prose_publishes(self):
        reference = '[FILE:' + str(self.file) + ']'
        for message in [
            {'role':'user','compact':True,'progress':{'final_body':reference}},
            {'role':'assistant','content':reference},
            {'role':'assistant','compact':True,'progress':{'final_body':'safe', 'turns':[{'content':reference}]}},
        ]:
            message['artifacts'] = [{'url':'https://evil.test/'}]
            output = self.store.decorate({'items':[copy.deepcopy(message)]}, 'test','owner-a')
            self.assertNotIn('artifacts', output['items'][0])
        self.assertEqual(len(self.publish()), 1)

    async def test_traversal_sensitive_and_outside_paths_rejected(self):
        outside = self.base / 'outside.txt'
        outside.write_text('public test', encoding='utf-8')
        for name in ['.env', 'password.txt', 'secret.json', 'id_rsa', 'capture.har', 'config/report.txt', '.hidden/report.txt']:
            candidate = self.root / name
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_text('test-only', encoding='utf-8')
            self.assertIsNone(self.store.resolve(str(candidate)), name)
        for path in [str(outside), 'temp/../outside.txt', '//host/share/file.txt', str(self.file)+':ads', 'C:relative', '', None]:
            self.assertIsNone(self.store.resolve(path), path)
        self.assertIsNotNone(self.store.resolve('temp/' + self.file.name))

    async def test_ambiguous_relative_paths_rejected(self):
        second = self.base / 'another' / 'temp'
        second.mkdir(parents=True)
        (second / self.file.name).write_bytes(self.body)
        store = m.ArtifactStore((self.root,second))
        self.assertIsNone(store.resolve('temp/' + self.file.name))
        self.assertIsNotNone(store.resolve(str(self.file)))

    async def test_hardlinks_and_size_limit_rejected(self):
        link = self.root / 'duplicate.txt'
        os.link(self.file, link)
        self.assertIsNone(self.store.resolve(str(self.file)))
        link.unlink()
        large = self.root / 'too-large.bin'
        with large.open('wb') as handle:
            handle.truncate(m.MAX_FILE + 1)
        self.assertIsNone(self.store.resolve(str(large)))

    async def test_eight_artifacts_limit_and_duplicates(self):
        references = []
        for index in range(10):
            path = self.root / (str(index)+'.txt')
            path.write_bytes(b'test')
            references.extend(['[FILE:'+str(path)+']']*2)
        data = {'items':[{'role':'assistant','compact':True,'progress':{'final_body':' '.join(references)}}]}
        files = self.store.decorate(data,'test','owner-a')['items'][0]['artifacts']
        self.assertEqual(len(files), 8)
        self.assertEqual(len({f['url'] for f in files}), 8)

if __name__ == '__main__':
    unittest.main()
