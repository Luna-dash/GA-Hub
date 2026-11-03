"""Loopback-only, authenticated, allowlisted gateway to GA-Hub desktop."""
import asyncio, hashlib, hmac, html, re, secrets, time, json, shutil
from pathlib import Path
from collections import defaultdict, deque
import tempfile
import copy
from remote_progress import ProgressHub
import aiohttp
from aiohttp import web
import psutil, win32cred
from artifacts import ArtifactStore
PUBLIC='gahub.lunadash.me'
PORT,ADMIN_PORT=47831,47832
CRED='GA-Hub/remote-access/password'
COOKIE='__Host-gahub_session'
SAFE=re.compile(r'^/api/(?:session-runtimes|sessions(?:/[A-Za-z0-9_-]+(?:/(?:messages|runtime|progress|live))?)?)$')
HOP={'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','content-length','content-encoding','set-cookie','access-control-allow-origin','access-control-allow-credentials'}
LOGIN='''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GA-Hub Login</title><style>body{font:18px system-ui;background:#101827;color:#eee;max-width:420px;margin:15vh auto;padding:24px}input,button{font:inherit;padding:12px;box-sizing:border-box;width:100%;margin-top:16px}</style><h1>GA-Hub</h1><p>远程会话 · 可发送指令</p><form method="post" action="/_gateway/login" autocomplete="on"><label for="username">用户名</label><input id="username" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required><label for="password">密码</label><input id="password" type="password" name="password" autocomplete="current-password" required><button type="submit">登录</button></form>'''

class Gateway:
    def __init__(self):
        try:
            credential=win32cred.CredRead(CRED,1)
            self.username=credential.get('UserName') or 'gahub'
            self.password=credential['CredentialBlob'].decode('utf-16-le')
        except Exception:
            self.username='gahub'
            self.password=secrets.token_urlsafe(24)
            win32cred.CredWrite({'Type':1,'TargetName':CRED,'CredentialBlob':self.password,'Persist':2,'UserName':self.username},0)
        self.salt=secrets.token_bytes(16)
        self.digest=hashlib.scrypt(self.password.encode(),salt=self.salt,n=16384,r=8,p=1)
        self.signing=secrets.token_bytes(32)
        self.failures=defaultdict(deque)
        self.target=None;self.checked=0;self.http=None
        self.submissions={}
        self.uploads={}
        self.artifacts=ArtifactStore()
        self.progress_hub=ProgressHub(self)
        self.upload_slots=asyncio.Semaphore(2)
    def token(self):
        body=str(int(time.time())+43200)+'.'+secrets.token_hex(16)
        return body+'.'+hmac.new(self.signing,body.encode(),hashlib.sha256).hexdigest()
    def authenticated(self,r):
        try:
            body,sig=r.cookies.get(COOKIE,'').rsplit('.',1)
            return int(body.split('.')[0])>time.time() and hmac.compare_digest(sig,hmac.new(self.signing,body.encode(),hashlib.sha256).hexdigest())
        except Exception:return False
    async def backend(self):
        if self.target and time.monotonic()-self.checked<8:return self.target
        self.checked=time.monotonic()
        def discover():
            ports=[]
            for p in psutil.process_iter(['name']):
                if 'ga-hub-sidecar' not in (p.info['name'] or '').lower():continue
                try:
                    ports.extend(c.laddr.port for c in p.net_connections('tcp') if c.status=='LISTEN' and c.laddr.ip=='127.0.0.1')
                except (psutil.Error,OSError):pass
            return ports
        for port in await asyncio.to_thread(discover):
            try:
                async with self.http.get(f'http://127.0.0.1:{port}/api/sessions',timeout=aiohttp.ClientTimeout(total=3)) as up:
                    if up.status==200 and 'items' in await up.json():
                        self.target=f'http://127.0.0.1:{port}';return self.target
            except Exception:pass
        self.target=None
        raise web.HTTPServiceUnavailable(text='Open GA-Hub on the host computer, then retry.')
    def origin_ok(self,r):return r.headers.get('Origin') in (None,'https://'+PUBLIC,'https://gahub.lunadash.cc.cd')
    async def model_catalog(self):
        base=await self.backend()
        try:
            async with self.http.get(base+'/api/llms',headers={'Origin':base}) as up:
                if up.status!=200:raise web.HTTPBadGateway(text='Model list unavailable')
                data=await up.json()
            return [{'key':row['key'],'name':row.get('name') or row['key']} for row in data['llms'] if row.get('key')]
        except (aiohttp.ClientError,asyncio.TimeoutError,ValueError,KeyError,RuntimeError):
            raise web.HTTPBadGateway(text='Model list unavailable')
    async def change_model(self,r):
        if r.headers.get('Origin')!='https://'+PUBLIC:raise web.HTTPForbidden(text='Origin required')
        if r.query_string or r.content_type!='application/json':raise web.HTTPBadRequest(text='JSON without query required')
        try:data=await r.json()
        except (ValueError,UnicodeError):raise web.HTTPBadRequest(text='Invalid JSON')
        if not isinstance(data,dict) or set(data)!={'llm_key'}:raise web.HTTPBadRequest(text='Only llm_key allowed')
        key=data['llm_key']
        if not isinstance(key,str) or not key or len(key)>256:raise web.HTTPBadRequest(text='Invalid model key')
        if key not in {row['key'] for row in await self.model_catalog()}:raise web.HTTPConflict(text='Model unavailable; refresh the model list')
        base=await self.backend()
        try:
            async with self.http.get(base+r.path.removesuffix('/model')+'/runtime',headers={'Origin':base}) as up:
                if up.status!=200: return web.Response(status=up.status,body=await up.read(),content_type='application/json')
                runtime=await up.json()
            if runtime.get('status') not in ('idle','error'):raise web.HTTPConflict(text='Wait for the current run to finish')
            async with self.http.put(base+r.path,json={'llm_key':key},headers={'Origin':base},allow_redirects=False) as up:
                return web.Response(status=up.status,body=await up.read(),content_type='application/json')
        except (aiohttp.ClientError,asyncio.TimeoutError):raise web.HTTPBadGateway(text='Model update uncertain; refresh the session')
    async def abort(self,r):
        if r.headers.get('Origin')!='https://'+PUBLIC:raise web.HTTPForbidden(text='Origin required')
        if r.query_string or await r.read():raise web.HTTPBadRequest(text='Empty body without query required')
        base=await self.backend()
        try:
            async with self.http.post(base+r.path,headers={'Origin':base},allow_redirects=False) as up:
                return web.Response(status=up.status,body=await up.read(),content_type='application/json')
        except (aiohttp.ClientError,asyncio.TimeoutError):raise web.HTTPBadGateway(text='Stop result uncertain; refresh runtime before retrying')
    async def upload(self,r):
        if r.headers.get('Origin')!='https://'+PUBLIC:raise web.HTTPForbidden(text='Origin required')
        if r.query_string or r.content_type!='multipart/form-data':raise web.HTTPBadRequest(text='Multipart file required')
        now=time.monotonic()
        self.uploads={k:v for k,v in self.uploads.items() if now-v[0]<43200}
        if len(self.uploads)>=256:raise web.HTTPTooManyRequests(text='Upload cache full')
        async with self.upload_slots:
            try:
                reader=await r.multipart();part=await reader.next()
                if part is None or part.name!='file' or not part.filename:raise web.HTTPBadRequest(text='One file required')
                name=part.filename.replace('\\','/').rsplit('/',1)[-1][:255]
                size=0
                with tempfile.SpooledTemporaryFile(max_size=1024*1024) as spool:
                    while True:
                        chunk=await part.read_chunk(65536)
                        if not chunk:break
                        size+=len(chunk)
                        if size>20*1024*1024:raise web.HTTPRequestEntityTooLarge(max_size=20*1024*1024,actual_size=size)
                        spool.write(chunk)
                    if await reader.next() is not None:raise web.HTTPBadRequest(text='One file per upload required')
                    spool.seek(0);form=aiohttp.FormData()
                    form.add_field('file',spool,filename=name,content_type='application/octet-stream')
                    base=await self.backend()
                    async with self.http.post(base+'/api/upload',data=form,headers={'Origin':base},allow_redirects=False,timeout=aiohttp.ClientTimeout(total=120)) as up:
                        if up.status!=200:return web.Response(status=up.status,text='Upload rejected by GA-Hub')
                        data=await up.json()
                ref={'path':data['path'],'name':data['name'],'size':data['size'],'source':'managed_upload'}
                uid=secrets.token_urlsafe(24)
                self.uploads[uid]=(time.monotonic(),r.cookies.get(COOKIE),ref)
                return web.json_response({'upload_id':uid,'name':ref['name'],'size':ref['size']})
            except (ValueError,KeyError,AssertionError):raise web.HTTPBadRequest(text='Invalid upload')
            except (aiohttp.ClientError,asyncio.TimeoutError):raise web.HTTPBadGateway(text='Upload failed; retry before sending')
    async def project_catalog(self):
        base=await self.backend()
        async with self.http.get(base+'/api/projects',headers={'Origin':base},allow_redirects=False) as up:
            if up.status!=200:raise web.HTTPBadGateway(text='项目列表读取失败，请重试')
            data=await up.json()
        result={}
        for item in data.get('items',[]):
            if not isinstance(item,dict) or item.get('dangling'):continue
            name,path=item.get('name'),item.get('path')
            if not isinstance(name,str) or not name or not isinstance(path,str) or not path:continue
            key=hmac.new(self.signing,json.dumps([name,path],ensure_ascii=True).encode(),hashlib.sha256).hexdigest()
            result[key]={'name':name,'path':path,'label':item.get('display_name') or name}
        return result
    async def create_session(self,r):
        if r.headers.get('Origin')!='https://'+PUBLIC:raise web.HTTPForbidden(text='Origin required')
        if r.query_string or r.content_type!='application/json':raise web.HTTPBadRequest(text='JSON without query required')
        try:data=await r.json()
        except (ValueError,UnicodeError):raise web.HTTPBadRequest(text='Invalid JSON')
        if not isinstance(data,dict) or set(data)!={'request_id','project_id'}:raise web.HTTPBadRequest(text='Only request_id and project_id allowed')
        rid,pid=data['request_id'],data['project_id']
        if not isinstance(rid,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,80}',rid):raise web.HTTPBadRequest(text='Invalid request_id')
        if pid is not None and (not isinstance(pid,str) or not re.fullmatch(r'[a-f0-9]{64}',pid)):raise web.HTTPBadRequest(text='Invalid project_id')
        if not hasattr(self,'creations'):self.creations={}
        now=time.monotonic()
        self.creations={k:v for k,v in self.creations.items() if now-v['time']<43200 or v['lock'].locked()}
        key=(r.cookies.get(COOKIE),rid)
        entry=self.creations.get(key)
        if entry and entry['project_id']!=pid:raise web.HTTPConflict(text='request_id already used with a different project')
        if entry is None:
            if len(self.creations)>=256:raise web.HTTPTooManyRequests(text='Create cache full')
            entry={'time':now,'project_id':pid,'lock':asyncio.Lock(),'session':None,'attempted':False,'done':False}
            self.creations[key]=entry
        async def perform():
            async with entry['lock']:
                if entry['done']:return web.json_response(entry['session'],status=201)
                base=await self.backend();project=None
                if pid is not None:
                    project=(await self.project_catalog()).get(pid)
                    if project is None:raise web.HTTPConflict(text='项目已不可用，请重新选择')
                if entry['session'] is None:
                    if entry['attempted']:raise web.HTTPConflict(text='创建结果未确认，请刷新列表检查后再新建，勿重复提交')
                    entry['attempted']=True
                    async with self.http.post(base+'/api/sessions',json={'title':''},headers={'Origin':base},allow_redirects=False) as up:
                        if up.status!=201:
                            entry['attempted']=False
                            return web.Response(status=up.status,text='GA-Hub 拒绝创建会话')
                        session=await up.json()
                    if not isinstance(session.get('id'),str) or not re.fullmatch(r'[A-Za-z0-9_-]+',session['id']):raise ValueError('Invalid session')
                    entry['session']=session
                if project:
                    sid=entry['session']['id']
                    async with self.http.put(base+'/api/sessions/'+sid+'/project',json={'name':project['name'],'path':project['path']},headers={'Origin':base},allow_redirects=False) as up:
                        if up.status!=200:return web.Response(status=up.status,text='会话 '+sid+' 已创建，但项目绑定失败；点击重试继续绑定，不会重复创建。')
                        entry['session']=await up.json()
                entry['done']=True
                return web.json_response(entry['session'],status=201)
        try:return await asyncio.shield(perform())
        except (aiohttp.ClientError,asyncio.TimeoutError,ValueError,KeyError,RuntimeError):
            raise web.HTTPBadGateway(text='创建或绑定结果未确认，请重试；若仍失败，请刷新列表检查已有会话。')
    async def submit(self,r):
        if r.headers.get('Origin')!='https://'+PUBLIC:raise web.HTTPForbidden(text='Origin required')
        if r.query_string or r.content_type!='application/json':raise web.HTTPBadRequest(text='JSON without query required')
        try:data=await r.json()
        except (ValueError,UnicodeError):raise web.HTTPBadRequest(text='Invalid JSON')
        if not isinstance(data,dict) or not {'text','request_id'}<=set(data) or set(data)-{'text','request_id','upload_ids'}:raise web.HTTPBadRequest(text='Only text, request_id and upload_ids allowed')
        text,rid=data['text'],data['request_id'];ids=data.get('upload_ids',[])
        if not isinstance(ids,list) or len(ids)>8 or any(not isinstance(x,str) for x in ids) or len(set(ids))!=len(ids):raise web.HTTPBadRequest(text='Invalid upload_ids')
        if not isinstance(text,str) or len(text)>6000 or not (text.strip() or ids):raise web.HTTPBadRequest(text='Text or attachment required; maximum 6000 characters')
        if not isinstance(rid,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,80}',rid):raise web.HTTPBadRequest(text='Invalid request_id')
        now=time.monotonic();attachments=[]
        for uid in ids:
            entry=self.uploads.get(uid)
            if not entry or now-entry[0]>=43200 or entry[1]!=r.cookies.get(COOKIE):raise web.HTTPBadRequest(text='Attachment expired or not owned by this login; upload again')
            attachments.append(entry[2])
        self.submissions={k:v for k,v in self.submissions.items() if not v[2].done() or now-v[0]<43200}
        key=(r.cookies.get(COOKIE),r.path,rid);fingerprint=hashlib.sha256(json.dumps([text,ids]).encode()).hexdigest()
        entry=self.submissions.get(key)
        if not entry:
            if len(self.submissions)>=1024:raise web.HTTPTooManyRequests(text='Submission cache full')
            base=await self.backend()
            entry=self.submissions.get(key)
            if not entry:
                args=(base,r.path,text,attachments) if attachments else (base,r.path,text)
                entry=(now,fingerprint,asyncio.create_task(self.forward_submit(*args)))
                self.submissions[key]=entry
        if entry[1]!=fingerprint:raise web.HTTPConflict(text='request_id reused for different content')
        status,body=await asyncio.shield(entry[2])
        return web.Response(status=status,body=body,content_type='application/json')
    async def forward_submit(self,base,path,text,attachments=None):
        payload={'text':text if text.strip() else '请查看附件','source':'remote-webui'}
        if attachments:payload['attachments']=attachments
        try:
            async with self.http.post(base+path,json=payload,headers={'Origin':base},timeout=aiohttp.ClientTimeout(total=65),allow_redirects=False) as resp:
                return resp.status,await resp.read()
        except (aiohttp.ClientError,asyncio.TimeoutError):
            return 504,json.dumps({'detail':'发送结果不确定，请先查看会话和运行状态，不要重复发送。'}).encode()
    async def progress_snapshot(self, base, sid):
        channel=await self.progress_hub.get(base,sid)
        return copy.deepcopy(channel.latest)

    async def project_progress(self, frame, sid):
        state=frame.get('runtime') or frame
        runtime={k:state[k] for k in ('session_id','status','run_id','stream_id','completed_run_id','outcome','error') if k in state}
        active=frame.get('active_message')
        streams=list(frame.get('streams') or [])
        if active:
            streams=[s for s in streams if s.get('stream_id')!=active.get('stream_id')]
            streams.append({**active,'run_id':active.get('run_id') or runtime.get('run_id')})
        streams.sort(key=lambda s:s.get('started_at') or s.get('ts') or 0)
        items=[]
        seen_users=set()
        for stream in streams:
            if not stream.get('run_id'):continue
            if stream.get('session_id') not in (None,sid):continue
            identity={k:stream.get(k) for k in ('run_id','logical_id','stream_id')}
            run_id=stream['run_id']
            if stream.get('query') and run_id not in seen_users:
                items.append({**identity,'role':'user','content':stream['query'],'ordinal':10**12+len(items)})
                seen_users.add(run_id)
            items.append({**identity,'role':'assistant','content':stream.get('content',''),
                'turn_segs':stream.get('turn_segs'),'streaming':not stream.get('done',False) or (runtime.get('status')=='running' and runtime.get('run_id')==run_id),
                'ordinal':10**12+len(items)})
        projected=await self.compact_messages({'items':items}, lane='progress')
        # Retries/continuations are physical streams of one logical reply.
        merged=[]
        for item in projected['items']:
            if item['role']!='assistant':
                merged.append(item);continue
            previous=next((i for i in merged if i['role']=='assistant' and i.get('run_id')==item.get('run_id')),None)
            if previous is None:
                merged.append(item);continue
            offset=previous['progress']['turn_count']
            previous['progress']['turns'].extend({**t,'turn':offset+n+1} for n,t in enumerate(item['progress']['turns']))
            previous['progress']['turn_count']+=item['progress']['turn_count']
            previous['progress']['final_body']=item['progress']['final_body']
            previous['progress']['question']=item['progress']['question']
            previous['content']+='\n'+item['content']
            previous['streaming']=previous['streaming'] or item['streaming']
        return {'runtime':runtime,'items':merged}
    async def handle(self,r):
        if r.host.split(':')[0] not in (PUBLIC,'127.0.0.1','localhost'):raise web.HTTPMisdirectedRequest()
        if r.path=='/_gateway/login':
            if r.method=='GET':return web.Response(text=LOGIN,content_type='text/html')
            if r.method!='POST' or not self.origin_ok(r):raise web.HTTPForbidden()
            key=r.headers.get('CF-Connecting-IP',r.remote);q=self.failures[key];now=time.monotonic()
            while q and now-q[0]>600:q.popleft()
            if len(q)>=6:raise web.HTTPTooManyRequests(text='Retry in 10 minutes.')
            data=await r.post();v=str(data.get('password',''));u=str(data.get('username',''))
            password_ok=await asyncio.to_thread(lambda:hmac.compare_digest(hashlib.scrypt(v.encode(),salt=self.salt,n=16384,r=8,p=1),self.digest))
            username_ok=hmac.compare_digest(u.encode('utf-8'),self.username.encode('utf-8'))
            if not (password_ok and username_ok):q.append(now);raise web.HTTPUnauthorized(text='Invalid username or password')
            q.clear();out=web.HTTPSeeOther('/chat')
            out.set_cookie(COOKIE,self.token(),secure=True,httponly=True,samesite='Strict',max_age=43200,path='/');return out
        if not self.authenticated(r):
            if r.path.startswith(('/api/','/ws/')) or r.headers.get('Upgrade','').lower()=='websocket':raise web.HTTPUnauthorized(text='Login required')
            raise web.HTTPSeeOther('/_gateway/login')
        if r.path=='/_gateway/logout':
            if r.method!='POST' or not self.origin_ok(r):raise web.HTTPForbidden()
            out=web.HTTPSeeOther('/_gateway/login');out.del_cookie(COOKIE,path='/',secure=True,httponly=True,samesite='Strict');return out
        if r.path.startswith('/_'):raise web.HTTPNotFound()
        if r.method=='POST' and re.fullmatch(r'/api/sessions/[A-Za-z0-9_-]+/runs',r.path):return await self.submit(r)
        if r.method=='POST' and re.fullmatch(r'/api/sessions/[A-Za-z0-9_-]+/abort',r.path):return await self.abort(r)
        if r.method=='POST' and r.path=='/api/upload':return await self.upload(r)
        if r.method=='POST' and r.path=='/api/sessions':return await self.create_session(r)
        if r.path=='/api/projects' and r.method=='GET':
            if not self.origin_ok(r):raise web.HTTPForbidden()
            if r.query_string:raise web.HTTPBadRequest(text='Query not allowed')
            try:catalog=await self.project_catalog()
            except (aiohttp.ClientError,asyncio.TimeoutError,ValueError):raise web.HTTPBadGateway(text='项目列表读取失败，请重试')
            return web.json_response({'items':[{'id':key,'name':item['label']} for key,item in catalog.items()]})
        if r.method=='PUT' and re.fullmatch(r'/api/sessions/[A-Za-z0-9_-]+/model',r.path):return await self.change_model(r)
        if r.path=='/api/llms' and r.method=='GET':
            if not self.origin_ok(r):raise web.HTTPForbidden()
            if r.query_string:raise web.HTTPBadRequest(text='Query not allowed')
            return web.json_response({'llms':await self.model_catalog()})
        if r.method not in ('GET','HEAD'):raise web.HTTPForbidden(text='API not available remotely.')
        if not self.origin_ok(r):raise web.HTTPForbidden()
        artifact=re.fullmatch(r'/api/sessions/([A-Za-z0-9_-]+)/artifacts/([A-Za-z0-9_-]{43})',r.path)
        if artifact:
            if r.query_string:raise web.HTTPBadRequest(text='Query not allowed')
            return await self.artifacts.download(r,artifact[1],artifact[2],r.cookies.get(COOKIE))
        if r.path.startswith('/api/') and not SAFE.fullmatch(r.path):raise web.HTTPForbidden(text='API not available remotely.')
        pages={'/':'remote.html','/chat':'remote.html','/sessions':'remote.html','/remote.js':'remote.js','/remote.css':'remote.css'}
        if r.path in pages:
            mime='text/javascript' if r.path.endswith('.js') else 'text/css' if r.path.endswith('.css') else 'text/html'
            return web.Response(body=(Path(__file__).parent/pages[r.path]).read_bytes(),content_type=mime,headers={'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"})
        live=re.fullmatch(r'/api/sessions/([A-Za-z0-9_-]+)/live',r.path)
        if live:
            if r.method!='GET' or r.query_string:raise web.HTTPBadRequest()
            try:channel=await self.progress_hub.get(await self.backend(),live[1])
            except (aiohttp.ClientError,asyncio.TimeoutError,ValueError,RuntimeError):
                raise web.HTTPBadGateway(text='Progress temporarily unavailable')
            down=web.WebSocketResponse(heartbeat=20,max_msg_size=1024)
            await down.prepare(r)
            queue=asyncio.Queue(maxsize=1);channel.listeners.add(queue)
            async def send(data):
                data=copy.deepcopy(data)
                self.artifacts.decorate(data,live[1],r.cookies.get(COOKIE))
                await asyncio.wait_for(down.send_json(data),10)
            async def outbound():
                await send(channel.latest)
                while True:
                    update=await queue.get()
                    if update is None or not self.authenticated(r):break
                    await send(update)
            sender=asyncio.create_task(outbound())
            async def inbound():
                async for message in down:
                    if not self.authenticated(r):break
                    if message.type == aiohttp.WSMsgType.TEXT:
                        if message.json().get('type') == 'ping':
                            await down.send_json({'type':'pong'})
            receiver=asyncio.create_task(inbound())
            try:
                await asyncio.wait([sender,receiver],return_when=asyncio.FIRST_COMPLETED)
            finally:
                channel.listeners.discard(queue);channel.last_used=time.monotonic()
                sender.cancel();receiver.cancel()
                await asyncio.gather(sender,receiver,return_exceptions=True)
                await down.close()
            return down
        progress=re.fullmatch(r'/api/sessions/([A-Za-z0-9_-]+)/progress',r.path)
        if progress:
            if r.method!='GET':raise web.HTTPForbidden()
            try:
                data=await self.progress_snapshot(await self.backend(),progress[1])
            except (aiohttp.ClientError,asyncio.TimeoutError,ValueError,KeyError,RuntimeError):
                raise web.HTTPBadGateway(text='实时进度读取失败，请稍后重试。')
            self.artifacts.decorate(data,progress[1],r.cookies.get(COOKIE))
            response=web.json_response(data);response.enable_compression();return response
        if not (SAFE.fullmatch(r.path) or re.fullmatch(r'/ws/sessions/[A-Za-z0-9_-]+',r.path)):raise web.HTTPNotFound()
        base=await self.backend()
        if r.path.endswith('/messages') and r.query.get('view')=='compact':
            query=[(k,v) for k,v in r.query.items() if k!='view']
            try:
                async with self.http.get(base+r.path,params=query,headers={'Origin':base}) as up:
                    if up.status!=200:
                        return web.Response(status=up.status,body=await up.read(),content_type=up.content_type)
                    data=await up.json()
                projected=await self.compact_messages(data)
                self.artifacts.decorate(projected,r.path.split('/')[3],r.cookies.get(COOKIE))
                out=web.json_response(projected)
                out.enable_compression()
                return out
            except (aiohttp.ClientError,asyncio.TimeoutError):
                self.target=None;raise web.HTTPBadGateway(text='Backend disconnected. Retry shortly.')
        if r.headers.get('Upgrade','').lower()=='websocket':
            if not re.fullmatch(r'/ws/sessions/[^/]+',r.path):raise web.HTTPForbidden()
            try:up=await self.http.ws_connect(base.replace('http:','ws:')+r.rel_url.path_qs,headers={'Origin':base},heartbeat=25,max_msg_size=16777216)
            except Exception:raise web.HTTPBadGateway(text='Backend websocket unavailable')
            down=web.WebSocketResponse(heartbeat=25,max_msg_size=8192);await down.prepare(r)
            async def inbound():
                async for msg in down:
                    if msg.type==aiohttp.WSMsgType.TEXT:await down.send_json({'type':'remote_read_only','message':'Remote access is read-only.'})
                await up.close()
            async def outbound():
                async for msg in up:
                    if msg.type==aiohttp.WSMsgType.TEXT:await down.send_str(msg.data)
                    elif msg.type==aiohttp.WSMsgType.BINARY:await down.send_bytes(msg.data)
                await down.close()
            tasks=[asyncio.create_task(inbound()),asyncio.create_task(outbound())]
            await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True);await up.close();await down.close();return down
        headers={k:v for k,v in r.headers.items() if k.lower() not in HOP|{'host','cookie','authorization','origin','x-forwarded-host','x-forwarded-proto'}}
        headers['Origin']=base
        try:
            async with self.http.request(r.method,base+r.rel_url.path_qs,headers=headers,allow_redirects=False) as up:
                out=web.StreamResponse(status=up.status,headers={k:v for k,v in up.headers.items() if k.lower() not in HOP})
                out.headers.update({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY'})
                await out.prepare(r)
                async for chunk in up.content.iter_any():await out.write(chunk)
                await out.write_eof();return out
        except (aiohttp.ClientError,asyncio.TimeoutError):self.target=None;raise web.HTTPBadGateway(text='Backend disconnected. Retry shortly.')
    async def compact_messages(self, data, lane='history'):
        if lane == 'progress':
            if not hasattr(self, '_progress_projector'):
                self._progress_projector=object.__new__(Gateway)
            return await self._progress_projector.compact_messages(data)
        # One persistent worker reuses the canonical WebUI transcript scanner.
        if not hasattr(self, '_compact_lock'):
            self._compact_lock=asyncio.Lock();self._compact_worker=None
        async with self._compact_lock:
            worker=self._compact_worker
            try:
                if worker is None or worker.returncode is not None:
                    node=shutil.which('node')
                    if not node:raise RuntimeError('Node runtime unavailable')
                    worker=await asyncio.create_subprocess_exec(node,str(Path(__file__).with_name('compact-worker.cjs')),
                        stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.DEVNULL,limit=32*1024*1024)
                    self._compact_worker=worker
                async def project():
                    worker.stdin.write(json.dumps(data,ensure_ascii=True).encode()+b'\n')
                    await worker.stdin.drain()
                    result=json.loads(await worker.stdout.readline())
                    if not isinstance(result.get('items'),list):raise ValueError('Invalid projection')
                    return result
                return await asyncio.wait_for(project(),timeout=20)
            except Exception:
                if worker and worker.returncode is None:
                    worker.kill();await worker.wait()
                self._compact_worker=None
                raise web.HTTPBadGateway(text='Lightweight history unavailable. Retry shortly.')

    async def close(self):
        await self.progress_hub.close()
        for owner in (self, getattr(self, '_progress_projector', None)):
            worker=getattr(owner, '_compact_worker', None)
            if worker and worker.returncode is None:
                worker.kill();await worker.wait()
        await self.http.close()

    async def admin(self,r):
        if r.host not in ('127.0.0.1:'+str(ADMIN_PORT),'localhost:'+str(ADMIN_PORT)) or r.remote!='127.0.0.1':raise web.HTTPForbidden()
        if r.headers.get('Origin') not in (None,'http://'+r.host):raise web.HTTPForbidden()
        return web.Response(text='<!doctype html><meta charset="utf-8"><title>GA-Hub Remote Access</title><h1>GA-Hub 远程入口</h1><p><a href="https://'+PUBLIC+'">https://'+PUBLIC+'</a></p><p>访问口令（仅本机可见，请保存到密码管理器）：</p><code style="font-size:24px">'+html.escape(self.password)+'</code><p>支持向已有会话发送文本指令；12小时登录有效期。本机和桌面 GA-Hub 需要保持运行。</p>',content_type='text/html',headers={'Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"})

@web.middleware
async def security(r,handler):
    try:out=await handler(r)
    except web.HTTPException as exc:out=exc
    if not out.prepared:out.headers.update({'Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'})
    return out
async def main():
    g=Gateway();g.http=aiohttp.ClientSession(trust_env=False,timeout=aiohttp.ClientTimeout(total=None,sock_connect=10,sock_read=180))
    runners=[]
    try:
        for port,handler in [(PORT,g.handle),(ADMIN_PORT,g.admin)]:
            app=web.Application(middlewares=[security],client_max_size=25*1024*1024);app.router.add_route('*','/{tail:.*}',handler)
            runner=web.AppRunner(app,access_log=None);await runner.setup();await web.TCPSite(runner,'127.0.0.1',port).start()
            runners.append(runner)
        print('Gateway ready; local credential panel on port',ADMIN_PORT,flush=True)
        await asyncio.Event().wait()
    finally:
        await g.close()
        for runner in runners:await runner.cleanup()
if __name__=='__main__':asyncio.run(main())
