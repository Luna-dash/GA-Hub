"""Independent, bounded fingerprint sampling. Never uses a live Chat agent."""
from __future__ import annotations

import asyncio
import copy
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any

import requests

from .. import _paths

DEFAULT_URL = "https://fingerprint.lunadash.me"


class SamplingUnavailable(ValueError):
    """Only locally defined, safe diagnostics may be exposed to the UI."""



def scoring_settings() -> tuple[str, str]:
    url = os.environ.get("GA_FINGERPRINT_URL", DEFAULT_URL).rstrip("/")
    if not url.startswith("https://"):
        raise ValueError("scoring_https_required")
    token = os.environ.get("GA_FINGERPRINT_TOKEN", "")
    if not token:
        path = Path(os.environ.get("GA_FINGERPRINT_TOKEN_FILE", str(_paths.ADMIN_DATA / "fingerprint_token")))
        if path.is_file():
            token = path.read_text(encoding="utf-8").strip()
    if not token:
        raise ValueError("scoring_not_configured")
    return url, token


def model_snapshot(key: str) -> tuple[dict, dict]:
    from frontends.gahub.bridge.model import mykey_config_snapshot
    config = mykey_config_snapshot().get(key)
    if not isinstance(config, dict):
        raise ValueError("model_unavailable")
    if "mixin" in key.lower() or not any(x in key for x in ("oai", "claude")):
        raise ValueError("single_model_required")
    config = copy.deepcopy(config)
    # Remove GA-specific context while retaining endpoint, protocol and parameters.
    config.pop("extra_sys_prompt", None)
    config.pop("extra_sys_prompt_file", None)
    return config, {"llm_key": key, "model": str(config.get("model", "")),
                    "api_mode": str(config.get("api_mode", "default")),
                    "temperature": config.get("temperature", 1), "max_tokens": config.get("max_tokens", 8192)}


def sample(key: str, config: dict, prompt: str) -> str:
    from frontends.gahub.bridge.model import resolve_isolated_session
    isolated = copy.deepcopy(config)
    isolated.update(max_retries=0, connect_timeout=10, read_timeout=120)
    backend = resolve_isolated_session(key, isolated)
    if backend is None:
        raise ValueError("model_unavailable")
    backend.history = []
    backend.tools = None
    backend.system = ""
    backend.extra_sys_prompt = ""
    messages = [{"role": "user", "content": [{"type": "text", "text": prompt}]}]
    if hasattr(backend, "make_messages"):
        messages = backend.make_messages(messages)
    generator = backend.raw_ask(messages)
    received = 0
    try:
        while True:
            try:
                chunk = next(generator)
            except StopIteration as end:
                blocks = end.value or []
                text = "\n".join(b.get("text", "") for b in blocks if b.get("type") == "text")
                break
            received += len(chunk) if isinstance(chunk, str) else 0
            if received > 32000:
                raise ValueError("sample_too_large")
    finally:
        generator.close()
    if not text.strip() or "!!!Error:" in text or "[Error:" in text:
        if "active_main_conversation_limit_exceeded" in text:
            raise SamplingUnavailable("模型服务的活跃会话数已达上限，无法创建独立采样会话；请待额度释放后重试。未复用当前聊天会话，未自动重试。")
        raise ValueError("sampling_failed")
    # Keep only the longest number run. Never send model prose to the scorer.
    runs, current, previous = [], [], 0
    for match in re.finditer(r"[0-9]+", text):
        if current and any(c.isalpha() for c in text[previous:match.start()]):
            runs.append(current)
            current = []
        value = int(match.group())
        if 1 <= value <= 355:
            current.append(str(value))
        previous = match.end()
    runs.append(current)
    numbers = max(runs, key=len)
    if not numbers:
        raise ValueError("empty_sample")
    return " ".join(numbers)


class FingerprintService:
    """Process-local jobs; at most one paid sampler at once, no automatic retries."""
    def __init__(self):
        self.jobs: dict[str, dict[str, Any]] = {}
        self.tasks: set[asyncio.Task] = set()

    def start(self, session_id: str, key: str) -> dict:
        if any(j["status"] in ("queued", "sampling", "analyzing") for j in self.jobs.values()):
            raise ValueError("fingerprint_busy")
        url, token = scoring_settings()
        config, target = model_snapshot(key)
        # Bound result retention. Raw samples/configs are never placed in jobs.
        self.jobs = {k: v for k, v in self.jobs.items() if time.time() - v["created_at"] < 86400}
        while len(self.jobs) >= 50:
            self.jobs.pop(next(iter(self.jobs)))
        job = {"id": uuid.uuid4().hex, "session_id": session_id, "target": target,
               "status": "queued", "completed_samples": 0, "created_at": time.time()}
        self.jobs[job["id"]] = job
        task = asyncio.create_task(self._run(job, key, config, url, token))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return copy.deepcopy(job)

    async def _run(self, job: dict, key: str, config: dict, url: str, token: str):
        headers = {"Authorization": f"Bearer {token}"}
        def request(method: str, path: str, body=None):
            response = requests.request(method, url + path, headers=headers, json=body, timeout=(10, 120), allow_redirects=False)
            response.raise_for_status()
            return response.json()
        try:
            challenge_data = await asyncio.to_thread(request, "GET", "/v1/fingerprint/challenges")
            challenges = challenge_data["challenges"]
            if len(challenges) != 3:
                raise ValueError("invalid_challenges")
            job["status"] = "sampling"
            outputs = []
            for challenge in challenges:
                count = challenge["expected_count"]
                prompt = challenge["prompt"]
                if not isinstance(count, int) or not 292 <= count <= 332 or not isinstance(prompt, str) or len(prompt) > 16000:
                    raise ValueError("invalid_challenges")
                text = await asyncio.to_thread(sample, key, config, prompt)
                outputs.append({"text": text, "expected_count": count})
                job["completed_samples"] += 1
            job["status"] = "analyzing"
            result = await asyncio.to_thread(request, "POST", "/v1/fingerprint/analyze", {"outputs": outputs})
            job["result"] = result
            job["status"] = "completed"
        except SamplingUnavailable:
            job["status"] = "failed"
            job["error"] = "模型服务的活跃会话数已达上限，无法创建独立采样会话；请待额度释放后重试。未复用当前聊天会话，未自动重试。"
        except Exception:
            # Upstream exceptions may contain API URLs, headers or response text.
            job["status"] = "failed"
            job["error"] = "检测失败：采样或评分服务不可用，请检查后端配置；未自动重试。"
        finally:
            config.clear()
            job["finished_at"] = time.time()
