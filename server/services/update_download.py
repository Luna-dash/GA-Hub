"""Durable release-download progress, independent of the requesting page."""
from __future__ import annotations

import json
import threading
import time

import requests

from . import update_release
from .self_update import UpdateStore, atomic_json
from .update_lock import FileMutex

ACTIVE = {"checking", "checksums", "downloading", "verifying", "preparing"}


def failure(exc: Exception) -> dict:
    detail = str(exc)
    lower = detail.lower()
    if isinstance(exc, requests.Timeout):
        message = "下载连接超时，请检查网络或代理后重试。"
    elif isinstance(exc, requests.exceptions.ProxyError):
        message = "无法连接代理，请检查系统代理后重试。"
    elif isinstance(exc, requests.exceptions.SSLError):
        message = "下载连接的安全证书校验失败，请检查系统时间或代理。"
    elif isinstance(exc, requests.ConnectionError):
        message = "无法连接更新服务器，请检查网络或代理后重试。"
    elif isinstance(exc, requests.HTTPError):
        code = exc.response.status_code if exc.response is not None else None
        message = "更新服务器暂时限制了访问，请稍后重试。" if code in {403, 429} else "更新服务器暂时不可用，请稍后重试。"
    elif "lock busy" in lower:
        message = "另一个更新操作正在进行，请稍候，勿重复下载。"
    elif any(word in lower for word in ("checksum", "metadata", "corrupt", "zip", "hash")):
        message = "安装包校验未通过，未执行更新；请重新下载。"
    elif "no newer" in lower:
        message = "当前已是最新稳定版，无需下载。"
    elif isinstance(exc, PermissionError):
        message = "无法写入更新目录，请检查目录权限或安全软件。"
    else:
        message = "下载或校验未完成，请重试；若仍失败，可展开技术详情排查。"
    return {"message": message, "detail": detail}


def read_json(path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def status(store: UpdateStore) -> dict | None:
    path = store.root / "download-task.json"
    task = read_json(path)
    if task.get("phase") in ACTIVE:
        # A file's presence does not imply a lock. Only an OS lock detects an
        # actual owner, including a worker in another sidecar process.
        try:
            with FileMutex(store.root / "download-task.lock", timeout=0):
                task = read_json(path)
                if task.get("phase") in ACTIVE:
                    task.update(phase="interrupted", updated_at=time.time(), error={
                        "message": "上次下载已中断，可重新下载；当前运行版本未受影响。",
                        "detail": "Download worker is no longer running.",
                    })
                    atomic_json(path, task)
        except TimeoutError:
            pass
    return task or None


def start(store: UpdateStore) -> dict:
    """Start once across processes; return immediately after the worker owns its lock."""
    with FileMutex(store.root / "download-start.lock", timeout=2):
        current = status(store)
        if current and current.get("phase") in ACTIVE:
            return current
        if current and current.get("phase") == "succeeded":
            plan = store.read()
            if plan.get("id") == current.get("plan_id") and plan.get("state") == "prepared":
                return current
        ready = threading.Event()
        result: list[dict] = []

        def run() -> None:
            try:
                with FileMutex(store.root / "download-task.lock", timeout=0):
                    task = {"phase": "checking", "received_bytes": 0, "total_bytes": None,
                            "started_at": time.time(), "updated_at": time.time(), "error": None}
                    path = store.root / "download-task.json"
                    atomic_json(path, task)
                    result.append(dict(task))
                    ready.set()
                    last_write = 0.0

                    def progress(phase: str, **values) -> None:
                        nonlocal last_write
                        changed = phase != task["phase"]
                        task.update(phase=phase, updated_at=time.time(), **values)
                        now = time.monotonic()
                        if changed or now - last_write >= .25:
                            atomic_json(path, task)
                            last_write = now

                    try:
                        plan = update_release.prepare(store, progress=progress)
                        task.update(phase="succeeded", plan_id=plan["id"], updated_at=time.time())
                    except Exception as exc:
                        task.update(phase="failed", error=failure(exc), updated_at=time.time())
                    atomic_json(path, task)
            except Exception as exc:
                result.append({"phase": "failed", "error": failure(exc)})
                ready.set()

        threading.Thread(target=run, name="release-download", daemon=True).start()
        if not ready.wait(5):
            raise TimeoutError("Download worker did not start in time")
        return result[0]
