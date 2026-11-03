"""Shared loopback subscriptions. Raw events never leave this module's state."""
import asyncio
import copy
import time
import aiohttp


class ProgressChannel:
    def __init__(self, gateway, base, sid):
        self.gateway, self.base, self.sid = gateway, base, sid
        self.upstream = None
        self.frame = None
        self.latest = None
        self.listeners = set()
        self.ready = asyncio.Event()
        self.dirty = asyncio.Event()
        self.last_used = time.monotonic()
        self.revision = 0
        self.history_revision = 0
        self.task = asyncio.create_task(self.run())

    def apply(self, event):
        kind = event.get('type')
        if kind == 'snapshot':
            self.frame = copy.deepcopy(event)
            self.history_revision += 1  # reconnect must calibrate archived history
        elif self.frame is None:
            return
        elif kind == 'session_runtime':
            self.frame['runtime'] = event
            if event.get('status') == 'idle':
                for stream in self.frame.get('streams', []):
                    if stream.get('run_id') == event.get('completed_run_id'):
                        stream['done'] = True
                active = self.frame.get('active_message')
                if active and active.get('run_id') == event.get('completed_run_id'):
                    active['done'] = True
                self.history_revision += 1
        elif kind in ('started', 'next', 'done'):
            streams = self.frame.setdefault('streams', [])
            stream = next((s for s in streams if s.get('stream_id') == event.get('stream_id')), None)
            active = self.frame.get('active_message')
            if active and active.get('stream_id') == event.get('stream_id'):
                stream = active
            if stream is None:
                stream = {'started_at': event.get('ts') or time.time()}
                streams.append(stream)
            stream.update({k: v for k, v in event.items() if k not in ('type', 'event_id', 'epoch')})
            if kind == 'started':
                stream.update(content='', done=False)
            elif kind == 'done':
                stream['done'] = True
                self.history_revision += 1
            # Completed physical streams may belong to a still-running logical run.
            # The runtime event, not `done`, owns logical termination.
        elif kind == 'aborted':
            for stream in self.frame.get('streams', []):
                stream['done'] = True
            if self.frame.get('active_message'):
                self.frame['active_message']['done'] = True
            self.history_revision += 1
        elif kind in ('reset', 'rewound'):
            if kind == 'reset':
                self.frame['streams'] = []
                self.frame['active_message'] = None
            else:
                removed = set(event.get('removed_sids', []))
                self.frame['streams'] = [s for s in self.frame.get('streams', []) if s.get('stream_id') not in removed]
                if (self.frame.get('active_message') or {}).get('stream_id') in removed:
                    self.frame['active_message'] = None
            self.history_revision += 1
        else:
            return
        # Bound retained raw streams: only recent runs are needed beside archive.
        self.frame['streams'] = self.frame.get('streams', [])[-64:]
        self.dirty.set()

    async def publish(self):
        while True:
            await self.dirty.wait()
            await asyncio.sleep(.08)  # coalesce cumulative token events, not a queue
            self.dirty.clear()
            result = await self.gateway.project_progress(copy.deepcopy(self.frame), self.sid)
            self.revision += 1
            self.latest = {**result, 'revision': self.revision, 'history_revision': self.history_revision}
            self.ready.set()
            for queue in tuple(self.listeners):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(self.latest)

    async def run(self):
        publisher = asyncio.create_task(self.publish())
        def projection_finished(task):
            if not task.cancelled() and task.exception() is not None and self.upstream is not None:
                asyncio.create_task(self.upstream.close())
        publisher.add_done_callback(projection_finished)
        try:
            url = self.base.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws/sessions/' + self.sid
            async with self.gateway.http.ws_connect(url, headers={'Origin': self.base}, heartbeat=20,
                                                     max_msg_size=64*1024*1024, timeout=8) as upstream:
                self.upstream = upstream
                async for message in upstream:
                    if message.type == aiohttp.WSMsgType.TEXT:
                        self.apply(message.json())
                    elif message.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                        break
        finally:
            publisher.cancel()
            await asyncio.gather(publisher, return_exceptions=True)
            self.upstream = None
            self.ready.set()
            for queue in tuple(self.listeners):
                if queue.full():
                    queue.get_nowait()
                queue.put_nowait(None)

    async def close(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class ProgressHub:
    def __init__(self, gateway):
        self.gateway = gateway
        self.channels = {}
        self.sweeper = None

    async def get(self, base, sid):
        if self.sweeper is None:
            self.sweeper = asyncio.create_task(self.sweep())
        key = (base, sid)
        channel = self.channels.get(key)
        if channel is None or channel.task.done():
            if channel:
                await channel.close()
            # Prevent unauthenticated ids / many tabs from creating unbounded subscriptions.
            if len(self.channels) >= 64 and key not in self.channels:
                idle = [k for k, c in self.channels.items() if not c.listeners]
                if not idle:
                    raise RuntimeError('Too many active subscriptions')
                victim = min(idle, key=lambda k: self.channels[k].last_used)
                await self.channels.pop(victim).close()
            channel = self.channels[key] = ProgressChannel(self.gateway, base, sid)
        channel.last_used = time.monotonic()
        await asyncio.wait_for(channel.ready.wait(), 10)
        if channel.task.done() or channel.latest is None:
            # Retrieve upstream exceptions; do not leave unobserved task warnings.
            if channel.task.done() and not channel.task.cancelled():
                channel.task.exception()
            raise RuntimeError('Progress subscription unavailable')
        return channel

    async def sweep(self):
        while True:
            await asyncio.sleep(10)
            for key, channel in list(self.channels.items()):
                if not channel.listeners and time.monotonic() - channel.last_used > 30:
                    self.channels.pop(key, None)
                    await channel.close()

    async def close(self):
        if self.sweeper:
            self.sweeper.cancel()
            await asyncio.gather(self.sweeper, return_exceptions=True)
        await asyncio.gather(*(c.close() for c in self.channels.values()))
        self.channels.clear()
