"""Fan-out of Hub compact views; no event or transcript interpretation."""
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
        if event.get('type') != 'progress':
            return
        if event.get('session_id') != self.sid or event.get('presentation_version') != 1:
            raise ValueError('Hub progress session or version mismatch')
        previous = (self.frame or {}).get('runtime') or {}
        runtime = event.get('runtime') or {}
        if self.frame is None or runtime.get('status') == 'idle' and previous.get('status') != 'idle':
            self.history_revision += 1
        self.frame = copy.deepcopy(event)
        self.dirty.set()

    async def publish(self):
        while True:
            await self.dirty.wait()
            await asyncio.sleep(.08)  # coalesce cumulative token events, not a queue
            self.dirty.clear()
            result = copy.deepcopy(self.frame)
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
            url = self.base.replace('http://', 'ws://').replace('https://', 'wss://') + '/ws/sessions/' + self.sid + '?view=compact'
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
