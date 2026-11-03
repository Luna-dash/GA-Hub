"""Run with python assets/remote_access/test_gateway.py; no real GA commands."""
import asyncio
import importlib.util
import json
import unittest
from pathlib import Path
from aiohttp import web, ClientSession, FormData
from aiohttp.test_utils import TestClient, TestServer

spec = importlib.util.spec_from_file_location('remote_gateway', Path(__file__).with_name('gateway.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.calls = []
        async def backend(request):
            data = await request.json()
            self.calls.append((request.path, data, request.headers.get('Origin')))
            await asyncio.sleep(.05)
            return web.json_response({'session_id': 'test', 'status': 'running', 'run_id': 'test-run'}, status=202)
        app = web.Application()
        self.created = 0
        self.bind_fail = False
        async def projects(request):
            return web.json_response({'items':[
                {'name':'demo','display_name':'示例项目','path':'D:/demo','memory_path':'private'},
                {'name':'gone','path':'D:/gone','dangling':True}]})
        async def create(request):
            self.created += 1
            self.calls.append((request.path,await request.json(),request.headers.get('Origin')))
            await asyncio.sleep(.05)
            return web.json_response({'id':'new-session','title':'新会话'},status=201)
        async def bind(request):
            self.calls.append((request.path,await request.json(),request.headers.get('Origin')))
            if self.bind_fail:return web.json_response({'detail':'busy'},status=409)
            return web.json_response({'id':'new-session','title':'新会话','project_name':'demo'})
        app.router.add_get('/api/projects',projects)
        app.router.add_post('/api/sessions',create)
        app.router.add_put('/api/sessions/new-session/project',bind)
        app.router.add_post('/api/sessions/test/runs', backend)
        async def upload(request):
            reader=await request.multipart();part=await reader.next()
            self.upload_content=bytes(await part.read())
            return web.json_response({'path':'C:/managed/upload.txt','name':part.filename,'size':len(self.upload_content)})
        async def abort(request):
            self.calls.append((request.path,{},request.headers.get('Origin')))
            return web.json_response({'status':'aborting'})
        app.router.add_post('/api/upload',upload)
        app.router.add_post('/api/sessions/test/abort',abort)
        self.runtime_status = 'idle'
        async def catalog(request):
            return web.json_response({'llms':[{'key':'test-model','name':'Test Model','api_key_masked':'secret','api_base':'private'}]})
        async def runtime(request):
            return web.json_response({'status':self.runtime_status})
        async def model(request):
            data=await request.json(); self.calls.append((request.path,data,request.headers.get('Origin')))
            return web.json_response({'id':'test',**data})
        async def messages(request):
            self.message_query=dict(request.query)
            return web.json_response({'items':[
                {'role':'user','content':'保留问题','ordinal':0},
                {'role':'assistant','content':'正文\n🛠️ Tool: `shell`\n````json\n{"secret":"tool-args"}\n````\n````text\ntool-output\n````\n最终答案',
                 'ordinal':1,'turn_segs':[{'start':0}]}],
                'has_more':True,'next_before':0,'total':2})
        self.snapshot = {'type':'snapshot','runtime':{'status':'running','run_id':'run-live'},'streams':[]}
        self.sockets = set()
        self.ws_connections = 0
        async def snapshot(request):
            ws=web.WebSocketResponse();await ws.prepare(request)
            self.ws_connections += 1
            self.sockets.add(ws)
            await ws.send_json(self.snapshot)
            try:
                async for _ in ws:pass
            finally:self.sockets.discard(ws)
            return ws
        app.router.add_get('/ws/sessions/test',snapshot)
        app.router.add_get('/api/sessions/test/messages',messages)
        app.router.add_get('/api/llms',catalog)
        app.router.add_get('/api/sessions/test/runtime',runtime)
        async def runtimes(request):
            return web.json_response({'test':{'session_id':'test','status':self.runtime_status}})
        app.router.add_get('/api/session-runtimes',runtimes)
        app.router.add_put('/api/sessions/test/model',model)
        self.up = TestServer(app)
        await self.up.start_server()
        self.g = m.Gateway.__new__(m.Gateway)
        self.g.signing = b'test-signing-key'
        self.g.submissions = {}
        self.g.uploads = {}
        self.g.artifacts = m.ArtifactStore()
        self.g.upload_slots = asyncio.Semaphore(2)
        self.g.http = ClientSession()
        self.g.progress_hub = m.ProgressHub(self.g)
        async def discover():
            await asyncio.sleep(.01)
            return str(self.up.make_url('')).rstrip('/')
        self.g.backend = discover
        app = web.Application(middlewares=[m.security], client_max_size=32768)
        app.router.add_route('*', '/{tail:.*}', self.g.handle)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()
        self.headers = {'Origin': 'https://' + m.PUBLIC, 'Cookie': m.COOKIE + '=' + self.g.token()}
        self.path = '/api/sessions/test/runs'
        self.payload = {'text': 'test instruction', 'request_id': 'a' * 32}

    async def asyncTearDown(self):
        await self.client.close()
        await self.g.close()
        await self.up.close()
        worker=getattr(self.g,'_compact_worker',None)
        if worker and worker.returncode is None:
            worker.stdin.close()
            await asyncio.wait_for(worker.wait(),5)

    async def test_upload_and_attachment_submit(self):
        form=FormData();form.add_field('file',b'x'*70000,filename='hello.txt')
        r=await self.client.post('/api/upload',data=form,headers=self.headers)
        self.assertEqual(r.status,200,await r.text());data=await r.json()
        self.assertNotIn('path',data);self.assertEqual(len(self.upload_content),70000)
        payload={**self.payload,'text':'','upload_ids':[data['upload_id']]}
        for _ in range(2):
            r=await self.client.post(self.path,json=payload,headers=self.headers)
            self.assertEqual(r.status,202,await r.text())
        self.assertEqual(len(self.calls),1)
        ref=self.calls[0][1]['attachments'][0]
        self.assertEqual(ref,{'path':'C:/managed/upload.txt','name':'hello.txt','size':70000,'source':'managed_upload'})
        self.assertEqual(self.calls[0][1]['text'],'请查看附件')
        other={**self.headers,'Cookie':m.COOKIE+'='+self.g.token()+'x'}
        r=await self.client.post(self.path,json=payload,headers=other)
        self.assertEqual(r.status,401)

    async def test_attachment_validation(self):
        for extra in [{'upload_ids':['unknown']},{'attachments':[{'path':'C:/secret'}]},{'upload_ids':['a']*2},{'upload_ids':list(map(str,range(9)))}]:
            r=await self.client.post(self.path,json={**self.payload,**extra},headers=self.headers)
            self.assertEqual(r.status,400)
        form=FormData();form.add_field('file',b'hello',filename='hello.txt')
        r=await self.client.post('/api/upload',data=form,headers={'Cookie':self.headers['Cookie']})
        self.assertEqual(r.status,403)
        r=await self.client.get('/api/upload',headers=self.headers)
        self.assertIn(r.status,(403,404,405))

    async def test_abort_proxy(self):
        path='/api/sessions/test/abort'
        r=await self.client.post(path,headers=self.headers)
        self.assertEqual(r.status,200);self.assertEqual((await r.json())['status'],'aborting')
        self.assertEqual(self.calls[0][2],str(self.up.make_url('')).rstrip('/'))
        r=await self.client.post(path,headers={'Cookie':self.headers['Cookie']})
        self.assertEqual(r.status,403)
        r=await self.client.post(path+'?x=1',headers=self.headers)
        self.assertEqual(r.status,400)

    async def test_runtime_catalog_proxy(self):
        self.runtime_status = 'running'
        r = await self.client.get('/api/session-runtimes', headers=self.headers)
        self.assertEqual(r.status, 200)
        self.assertEqual(await r.json(), {'test': {'session_id':'test', 'status':'running'}})

    async def test_runtime_catalog_path_is_exact(self):
        r = await self.client.get('/api/session-runtimes-extra', headers=self.headers)
        self.assertEqual(r.status, 403)

    async def test_account_login_and_cookie(self):
        self.g.username = 'test-account'
        self.g.salt = b'test-login-salt'
        self.g.digest = m.hashlib.scrypt(b'test-password',salt=self.g.salt,n=16384,r=8,p=1)
        self.g.failures = m.defaultdict(m.deque)
        path = '/_gateway/login'
        r = await self.client.get(path)
        page = await r.text()
        self.assertIn('name="username" autocomplete="username"',page)
        self.assertIn('autocomplete="current-password"',page)
        for data in [
            {'password':'test-password'},
            {'username':'wrong-account','password':'test-password'},
            {'username':'test-account','password':'wrong-password'},
            {'username':'测试','password':'test-password'},
        ]:
            r = await self.client.post(path,data=data,headers={'Origin':'https://'+m.PUBLIC},allow_redirects=False)
            self.assertEqual(r.status,401)
            self.assertEqual(await r.text(),'Invalid username or password')
            self.assertNotIn(m.COOKIE,r.cookies)
        r = await self.client.post(path,data={'username':'test-account','password':'test-password'},headers={'Origin':'https://'+m.PUBLIC},allow_redirects=False)
        self.assertEqual(r.status,303)
        self.assertEqual(r.headers['Location'],'/chat')
        cookie = r.cookies[m.COOKIE]
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'],'Strict')
        self.assertEqual(cookie['max-age'],'43200')
        h = {'Cookie':m.COOKIE+'='+cookie.value,'Origin':'https://'+m.PUBLIC}
        r = await self.client.get('/api/session-runtimes',headers=h)
        self.assertEqual(r.status,200)
        self.assertFalse(self.g.failures[next(iter(self.g.failures))])
        r = await self.client.post('/_gateway/logout',headers=h,allow_redirects=False)
        self.assertEqual(r.status,303)
        self.assertEqual(r.cookies[m.COOKIE]['max-age'],'0')

    async def test_login_origin_and_throttle(self):
        self.g.username = 'test-account'
        self.g.salt = b'test-login-salt'
        self.g.digest = m.hashlib.scrypt(b'test-password',salt=self.g.salt,n=16384,r=8,p=1)
        self.g.failures = m.defaultdict(m.deque)
        path = '/_gateway/login'
        data = {'username':'test-account','password':'test-password'}
        r = await self.client.post(path,data=data,headers={'Origin':'https://evil.example'},allow_redirects=False)
        self.assertEqual(r.status,403)
        for _ in range(6):
            r = await self.client.post(path,data={**data,'username':'wrong-account'},allow_redirects=False)
            self.assertEqual(r.status,401)
        r = await self.client.post(path,data=data,allow_redirects=False)
        self.assertEqual(r.status,429)

    async def test_no_login(self):
        r = await self.client.post(self.path, json=self.payload, headers={'Origin': 'https://' + m.PUBLIC})
        self.assertEqual(r.status, 401)
        self.assertFalse(self.calls)

    async def test_origin_required(self):
        for origin in [None, 'null', 'https://evil.example']:
            h = dict(self.headers)
            if origin is None: h.pop('Origin')
            else: h['Origin'] = origin
            r = await self.client.post(self.path, json=self.payload, headers=h)
            self.assertEqual(r.status, 403)
        self.assertFalse(self.calls)

    async def test_only_text_submission(self):
        for path in ['/api/settings', '/api/sessions', '/api/sessions/test/cancel', '/api/sessions/test/messages', '/api/sessions/test/rewind', '/_admin']:
            r = await self.client.post(path, json=self.payload, headers=self.headers)
            self.assertEqual(r.status, 404 if path == '/_admin' else 400 if path == '/api/sessions' else 403, path)
        self.assertFalse(self.calls)

    async def test_payload_validation(self):
        for payload in [[], {}, {'text': '', 'request_id': 'a'*32}, {'text':'a'*6001, 'request_id':'a'*32}, {'text':'ok', 'request_id':'short'}, {**self.payload, 'images':[]}, {**self.payload, 'source':'evil'}, {'text':3,'request_id':'a'*32}]:
            r = await self.client.post(self.path, json=payload, headers=self.headers)
            self.assertEqual(r.status, 400, str(payload)[:100])
        self.assertFalse(self.calls)

    async def test_query_and_content_type(self):
        r = await self.client.post(self.path + '?x=1', json=self.payload, headers=self.headers)
        self.assertEqual(r.status, 400)
        r = await self.client.post(self.path, data=json.dumps(self.payload), headers=self.headers)
        self.assertEqual(r.status, 400)

    async def test_concurrent_idempotency(self):
        responses = await asyncio.gather(*[self.client.post(self.path, json=self.payload, headers=self.headers) for _ in range(5)])
        self.assertEqual([r.status for r in responses], [202]*5)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0][1], {'text':'test instruction', 'source':'remote-webui'})
        r = await self.client.post(self.path, json={**self.payload,'text':'different'}, headers=self.headers)
        self.assertEqual(r.status, 409)
        self.assertEqual(len(self.calls), 1)

    async def test_unicode_max(self):
        r = await self.client.post(self.path, data=json.dumps({**self.payload, 'text':'\u4e2d'*6000}, ensure_ascii=False).encode(), headers={**self.headers,'Content-Type':'application/json'})
        self.assertEqual(r.status, 202)
        self.assertEqual(len(self.calls[0][1]['text']), 6000)

    async def test_backend_409_preserved(self):
        async def busy(*args):
            return 409, b'{"detail":{"code":"session_busy"}}'
        self.g.forward_submit = busy
        r = await self.client.post(self.path, json=self.payload, headers=self.headers)
        self.assertEqual(r.status, 409)
        self.assertEqual((await r.json())['detail']['code'], 'session_busy')

    async def test_model_catalog_sanitized(self):
        r=await self.client.get('/api/llms',headers=self.headers)
        self.assertEqual(r.status,200)
        self.assertEqual(await r.json(),{'llms':[{'key':'test-model','name':'Test Model'}]})
        r=await self.client.get('/api/llms')
        self.assertEqual(r.status,401)

    async def test_model_save_and_busy(self):
        path='/api/sessions/test/model'
        r=await self.client.put(path,json={'llm_key':'test-model'},headers=self.headers)
        self.assertEqual(r.status,200)
        self.assertEqual((await r.json())['llm_key'],'test-model')
        self.assertEqual(len(self.calls),1)
        for state in ['running','starting','stopping','unknown']:
            self.runtime_status=state
            r=await self.client.put(path,json={'llm_key':'test-model'},headers=self.headers)
            self.assertEqual(r.status,409)
        self.assertEqual(len(self.calls),1)

    async def test_project_catalog_and_free_create(self):
        r=await self.client.get('/api/projects',headers=self.headers)
        self.assertEqual(r.status,200)
        catalog=await r.json()
        self.assertEqual(len(catalog['items']),1)
        self.assertEqual(set(catalog['items'][0]),{'id','name'})
        body={'request_id':'free-request-12345','project_id':None}
        a,b=await asyncio.gather(*[self.client.post('/api/sessions',json=body,headers=self.headers) for _ in range(2)])
        self.assertEqual(a.status,201);self.assertEqual(b.status,201)
        self.assertEqual((await a.json())['id'],'new-session')
        self.assertEqual(self.created,1)
        self.assertEqual(self.calls[0][1],{'title':''})

    async def test_project_create_and_retry_bind(self):
        catalog=await (await self.client.get('/api/projects',headers=self.headers)).json()
        body={'request_id':'project-request-123','project_id':catalog['items'][0]['id']}
        self.bind_fail=True
        r=await self.client.post('/api/sessions',json=body,headers=self.headers)
        self.assertEqual(r.status,409)
        self.assertIn('new-session',await r.text())
        self.bind_fail=False
        r=await self.client.post('/api/sessions',json=body,headers=self.headers)
        self.assertEqual(r.status,201)
        self.assertEqual((await r.json())['project_name'],'demo')
        self.assertEqual(self.created,1)
        self.assertEqual(self.calls[-1][1],{'name':'demo','path':'D:/demo'})
        r=await self.client.post('/api/sessions',json={**body,'project_id':None},headers=self.headers)
        self.assertEqual(r.status,409)

    async def test_create_security(self):
        body={'request_id':'secure-request-123','project_id':None}
        for origin in [None,'null','https://evil.example']:
            h=dict(self.headers)
            if origin is None:h.pop('Origin')
            else:h['Origin']=origin
            r=await self.client.post('/api/sessions',json=body,headers=h)
            self.assertEqual(r.status,403)
        r=await self.client.post('/api/sessions',json=body,headers={'Origin':'https://'+m.PUBLIC})
        self.assertEqual(r.status,401)
        for data in [{},{**body,'path':'D:/arbitrary'},{**body,'project_id':'unknown'}, {**body,'project_id':{}},{**body,'request_id':'bad'}]:
            r=await self.client.post('/api/sessions',json=data,headers=self.headers)
            self.assertIn(r.status,[400,409])
        r=await self.client.post('/api/sessions?x=1',json=body,headers=self.headers)
        self.assertEqual(r.status,400)
        self.assertEqual(self.created,0)

    async def test_model_rejects_invalid_requests(self):
        path='/api/sessions/test/model'
        for body in [{},{'llm_key':None},{'llm_key':123},{'llm_key':''},{'llm_key':'test-model','text':'bad'}]:
            r=await self.client.put(path,json=body,headers=self.headers)
            self.assertEqual(r.status,400)
        r=await self.client.put(path,json={'llm_key':'missing'},headers=self.headers)
        self.assertEqual(r.status,409)
        for origin in [None,'null','https://evil.example']:
            h=dict(self.headers)
            if origin is None:h.pop('Origin')
            else:h['Origin']=origin
            r=await self.client.put(path,json={'llm_key':'test-model'},headers=h)
            self.assertEqual(r.status,403)
        r=await self.client.put(path,json={'llm_key':'test-model'},headers={'Origin':'https://'+m.PUBLIC})
        self.assertEqual(r.status,401)
        self.assertFalse(self.calls)

    async def test_compact_history_preserves_pagination_and_text(self):
        r=await self.client.get('/api/sessions/test/messages?view=compact&limit=40&before=5',headers=self.headers)
        self.assertEqual(r.status,200)
        data=await r.json()
        self.assertEqual(self.message_query,{'limit':'40','before':'5'})
        self.assertEqual(data['has_more'],True)
        self.assertEqual(data['next_before'],0)
        self.assertEqual(data['items'][0]['content'],'保留问题')
        item=data['items'][1]
        self.assertEqual(item['ordinal'],1)
        self.assertTrue(item['compact'])
        self.assertNotIn('turn_segs',item)
        self.assertIn('最终答案',item['content'])
        self.assertNotIn('tool-args',str(data))
        self.assertNotIn('tool-output',str(data))
        r=await self.client.get('/api/sessions/test/messages',headers=self.headers)
        self.assertIn('tool-output',await r.text())

    async def test_compact_scanner_preserves_code_and_streaming(self):
        contents=[
            '正文\n```js\nconst literal = "<thinking>保留代码</thinking>";\n```\n<summary>隐藏摘要</summary><thinking>隐藏思考</thinking>\n结束',
            '进行中\n🛠️ Tool: `shell`\n````json\n{"unfinished":',
            '🛠️ shell({"x":1})\n````text\n工具结果\n````\n保留回复',
            '只有正文',
        ]
        data=await self.g.compact_messages({'items':[{'role':'assistant','content':c,'ordinal':i} for i,c in enumerate(contents)]})
        text=[i['content'] for i in data['items']]
        self.assertIn('<thinking>保留代码</thinking>',text[0])
        self.assertNotIn('隐藏',text[0])
        self.assertEqual(text[1],'进行中')
        self.assertEqual(text[2],'保留回复')
        self.assertEqual(text[3],'只有正文')

    async def test_compact_preserves_questions(self):
        raw='🛠️ Tool: `functions.ask_user`\n````json\n{"question":"请选择方案", "candidates":["方案一","方案二"]}\n````\n'
        data=await self.g.compact_messages({'items':[{'role':'assistant','content':raw}]})
        text=data['items'][0]['content']
        self.assertIn('请选择方案',text)
        self.assertIn('方案一',text)
        self.assertIn('方案二',text)
        self.assertNotIn('🛠️',text)
        self.assertNotIn('candidates',text)

    async def test_live_progress_grows_before_completion(self):
        first='<summary>正在查证</summary>第一轮正文\n🛠️ Tool: `shell`\n````json\n{"secret":"tool-args"}\n````\n````text\ntool-output\n````\n'
        second='<summary>继续核对</summary>第二轮正文'
        async def read(parts,done=False):
            self.snapshot['active_message']={'run_id':'run-live','stream_id':'stream-live','content':''.join(parts),'turn_segs':parts,'done':done}
            channel = self.g.progress_hub.channels.get((str(self.up.make_url('')).rstrip('/'), 'test'))
            if channel:
                revision = channel.revision
                for ws in self.sockets:await ws.send_json(self.snapshot)
                async with asyncio.timeout(3):
                    while channel.revision == revision:await asyncio.sleep(.01)
            r=await self.client.get('/api/sessions/test/progress',headers=self.headers)
            self.assertEqual(r.status,200)
            data=await r.json()
            self.assertNotIn('tool-args',str(data));self.assertNotIn('tool-output',str(data))
            return data['items'][-1]
        one=await read([first])
        self.assertTrue(one['streaming'])
        self.assertEqual(one['progress']['turn_count'],1)
        self.assertEqual(one['progress']['turns'][0]['summary'],'正在查证')
        two=await read([first,second])
        self.assertTrue(two['streaming'])
        self.assertEqual(two['progress']['turn_count'],2)
        self.assertEqual(two['progress']['turns'][1]['summary'],'继续核对')
        self.snapshot['runtime']={'status':'idle','completed_run_id':'run-live'}
        done=await read([first,second],True)
        self.assertFalse(done['streaming'])
        self.assertEqual(done['progress']['turn_count'],2)

    async def test_progress_merges_continuations_and_filters_foreign(self):
        self.snapshot['streams']=[
            {'session_id':'test','run_id':'run-live','stream_id':'first','query':'问题','content':'<summary>首轮</summary>首段','turn_segs':['<summary>首轮</summary>首段'],'done':True,'started_at':1},
            {'session_id':'foreign','run_id':'run-live','stream_id':'foreign','content':'不可见','done':False},
            {'session_id':'foreign','run_id':'other-run','stream_id':'other','content':'旧任务不可见','done':True},
        ]
        self.snapshot['active_message']={'session_id':'test','run_id':'run-live','stream_id':'last','query':'重复问题','content':'<summary>续跑</summary>当前段','turn_segs':['<summary>续跑</summary>当前段'],'done':False,'ts':2}
        r=await self.client.get('/api/sessions/test/progress',headers=self.headers)
        data=await r.json()
        self.assertEqual(len(data['items']),2)
        reply=data['items'][1]
        self.assertTrue(reply['streaming'])
        self.assertEqual(reply['progress']['turn_count'],2)
        self.assertEqual([t['turn'] for t in reply['progress']['turns']],[1,2])
        self.assertNotIn('不可见',str(data))
        self.assertEqual(reply['progress']['final_body'],'当前段')

    async def test_progress_separates_user_interactions(self):
        self.snapshot['streams'] = [
            {'session_id':'test','run_id':'old-run','stream_id':'s1','logical_id':'s00000001','query':'第一个提问','content':'<summary>第一轮</summary>答一','turn_segs':['<summary>第一轮</summary>答一'],'done':True,'started_at':1},
            {'session_id':'test','run_id':'run-live','stream_id':'s2','logical_id':'s00000001','query':'第二个提问','content':'<summary>新任务首轮</summary>答二','turn_segs':['<summary>新任务首轮</summary>答二'],'done':False,'started_at':2},
        ]
        r = await self.client.get('/api/sessions/test/progress', headers=self.headers)
        data = await r.json()
        self.assertEqual([m['role'] for m in data['items']], ['user','assistant','user','assistant'])
        self.assertEqual([m['content'] for m in data['items'] if m['role']=='user'], ['第一个提问','第二个提问'])
        self.assertEqual([m['progress']['turn_count'] for m in data['items'] if m['role']=='assistant'], [1,1])
        self.assertEqual([m['run_id'] for m in data['items']], ['old-run','old-run','run-live','run-live'])

    async def test_progress_authenticated_read_only(self):
        path='/api/sessions/test/progress'
        r=await self.client.get(path);self.assertEqual(r.status,401)
        r=await self.client.post(path,json={},headers=self.headers);self.assertEqual(r.status,403)

    async def test_native_count_ignores_embedded_turn_markers(self):
        parts=['<summary>原生首轮</summary>代码示例\n```text\nLLM Running (Turn 99) ...\n```\n', '<summary>原生次轮</summary>最终结果']
        data=await self.g.compact_messages({'items':[{'role':'assistant','content':''.join(parts),'turn_segs':parts}]})
        p=data['items'][0]['progress']
        self.assertEqual(p['turn_count'],2)
        self.assertEqual([t['turn'] for t in p['turns']],[1,2])
        self.assertEqual(p['turns'][1]['summary'],'原生次轮')

    async def test_live_shared_push_and_ping(self):
        ws=await self.client.ws_connect('/api/sessions/test/live',headers=self.headers)
        initial=await ws.receive_json(timeout=3)
        self.assertEqual(initial['runtime']['status'],'running')
        self.assertEqual(initial['runtime']['status'],'running')
        r=await self.client.get('/api/sessions/test/progress',headers=self.headers)
        self.assertEqual(r.status,200)
        self.assertEqual(self.ws_connections,1)
        self.snapshot['streams']=[{'session_id':'test','run_id':'run-live','stream_id':'live',
            'content':'<thinking>PRIVATE</thinking>更新正文','done':True}]
        self.snapshot['runtime']={'status':'idle','completed_run_id':'run-live'}
        self.snapshot['streams'][0]['done']=True
        for upstream in self.sockets:await upstream.send_json(self.snapshot)
        update=await ws.receive_json(timeout=3)
        self.assertIn('更新正文',json.dumps(update,ensure_ascii=False))
        self.assertNotIn('PRIVATE',json.dumps(update))
        self.assertFalse(update['items'][0]['streaming'])
        await ws.send_json({'type':'ping'})
        self.assertEqual((await ws.receive_json(timeout=3))['type'],'pong')
        self.assertEqual(self.ws_connections,1)
        await ws.close()
        channel=next(iter(self.g.progress_hub.channels.values()))
        async with asyncio.timeout(2):
            while channel.listeners:await asyncio.sleep(.01)

    async def test_live_reconnects_after_backend_disconnect(self):
        ws=await self.client.ws_connect('/api/sessions/test/live',headers=self.headers)
        await ws.receive_json(timeout=3)
        for upstream in list(self.sockets):await upstream.close()
        async with asyncio.timeout(3):
            while not ws.closed:
                msg=await ws.receive()
                if msg.type in (m.aiohttp.WSMsgType.CLOSE,m.aiohttp.WSMsgType.CLOSED):break
        await ws.close()
        ws2=await self.client.ws_connect('/api/sessions/test/live',headers=self.headers)
        self.assertEqual((await ws2.receive_json(timeout=3))['runtime']['status'],'running')
        self.assertEqual(self.ws_connections,2)
        await ws2.close()

    async def test_live_requires_valid_origin(self):
        r=await self.client.get('/api/sessions/test/live',headers={**self.headers,'Origin':'https://evil.test'})
        self.assertEqual(r.status,403)

if __name__ == '__main__':
    unittest.main(verbosity=2)
