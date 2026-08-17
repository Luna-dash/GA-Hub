"""Concurrency contracts for Feishu's blocking service adapters."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest import mock

import httpx
from fastapi import FastAPI

from server.routes import feishu


def test_slow_feishu_check_does_not_block_other_window_requests() -> None:
    service = SimpleNamespace()

    def slow_check(*, init_agent: bool = False) -> dict[str, bool]:
        time.sleep(0.3)
        return {"ready": not init_agent, "ok": True}

    service.check = slow_check
    app = FastAPI()
    app.include_router(feishu.router)

    @app.get("/probe")
    async def probe() -> dict[str, bool]:
        return {"ok": True}

    async def scenario() -> tuple[float, httpx.Response, httpx.Response]:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            started = time.perf_counter()
            check_task = asyncio.create_task(client.post("/api/feishu/check"))
            await asyncio.sleep(0.02)
            probe_response = await client.get("/probe")
            probe_elapsed = time.perf_counter() - started
            check_response = await check_task
            return probe_elapsed, probe_response, check_response

    with mock.patch.object(feishu, "svc", return_value=service):
        elapsed, probe_response, check_response = asyncio.run(scenario())

    assert elapsed < 0.15
    assert probe_response.json() == {"ok": True}
    assert check_response.status_code == 200
