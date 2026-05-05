"""WeChatService — agent-integrated WeChat bot for the web admin UI.

Wraps the transport-only :class:`WxBotClient` with:
  * QR login flow that emits status events on the EventBus
  * Per-user contacts + message log (in-memory, capped) for UI display
  * Persistent log on disk (``ADMIN_DATA/wechat_log.jsonl``) so message
    history survives restarts. Contacts are reconstructed from the log.
  * Allowlist enforcement (sourced from mykey.wechat_allowed_users)
  * Inbound message → GeneraticAgent.put_task → streamed reply
  * Outbound media auto-detection ([FILE:path] markers)

Mirrors the behavior of frontends/wechatapp.py ``on_message`` but routes
all output through the EventBus so the React UI sees live updates.
"""
from __future__ import annotations

import json
import logging
import os
import queue as _q
import re
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .. import _paths

# Path-resolution: GA_ROOT must already be set when this module imports
if _paths.GA_ROOT is None:
    raise RuntimeError("WeChatService imported before GA_ROOT is configured")

from frontends.chatapp_common import public_access, to_allowed_set  # noqa: E402

from .agent_service import AgentService  # noqa: E402
from .event_bus import bus  # noqa: E402
from .wx_bot_client import WxBotClient, download_media  # noqa: E402

log = logging.getLogger(__name__)

WX_MEDIA_DIR = str(_paths.temp_dir() / "wechat_media")
os.makedirs(WX_MEDIA_DIR, exist_ok=True)

# ── reply-formatting helpers (verbatim from wechatapp.py) ────────
_TAG_PATS = [r"<" + t + r">.*?</" + t + r">" for t in ("thinking", "tool_use")]
_TAG_PATS.append(r"<file_content>.*?</file_content>")


def _strip_md(t: str) -> str:
    def _trunc_code(m):
        body = m.group().strip("`")
        if "\n" not in body:
            return body
        lines = body.split("\n", 1)[-1].split("\n")
        if len(lines) > 10:
            return "\n".join(lines[:10]) + "\n..."
        return "\n".join(lines)
    t = re.sub(r"(`{3,})[\s\S]*?\1", _trunc_code, t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    t = re.sub(r"!\[.*?\]\(.*?\)", "", t)
    t = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", t)
    t = re.sub(r"^#{1,6}\s+", "", t, flags=re.M)
    t = re.sub(r"(\*{1,3})(.*?)\1", r"\2", t)
    t = re.sub(r"^\s*[-*+]\s+", "• ", t, flags=re.M)
    t = re.sub(r"^\s*\d+\.\s+", "", t, flags=re.M)
    t = re.sub(r"^\s*>\s?", "", t, flags=re.M)
    t = re.sub(r"^---+$", "", t, flags=re.M)
    return re.sub(r"\n{3,}", "\n\n", t).strip()


def _clean(t: str) -> str:
    t = re.sub(r"^\s*LLM Running \(Turn \d+\) \.{3}\s*$", "", t, flags=re.M)
    t = re.sub(r"^\s*🛠️\s*[A-Za-z_][A-Za-z0-9_]*\(.*$", "", t, flags=re.M)
    for p in _TAG_PATS:
        t = re.sub(p, "", t, flags=re.DOTALL)
    t = re.sub(r"</?summary>", "", t)
    return re.sub(r"\n{3,}", "\n\n", _strip_md(t)).strip() or "..."


def _turn_parts(t: str) -> tuple[list[str], str]:
    _ph: list[str] = []
    safe = re.sub(
        r"`{4,}.*?`{4,}",
        lambda m: (_ph.append(m.group(0)), f"\x00PH{len(_ph)-1}\x00")[1],
        t,
        flags=re.DOTALL,
    )
    parts = re.split(r"(\**LLM Running \(Turn \d+\) \.\.\.\**)", safe)
    parts = [re.sub(r"\x00PH(\d+)\x00", lambda m: _ph[int(m.group(1))], p) for p in parts]
    if len(parts) < 4:
        return [], t
    turns = [parts[i] + (parts[i + 1] if i + 1 < len(parts) else "") for i in range(1, len(parts), 2)]
    return ([parts[0]] if parts[0].strip() else []) + turns[:-1], turns[-1]


# ── data shapes ──────────────────────────────────────────────────
@dataclass
class WxContact:
    uid: str
    last_text: str = ""
    last_ts: int = 0
    msg_count: int = 0
    nickname: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class WxLogEntry:
    ts: int
    direction: str  # "in" | "out"
    uid: str
    text: str
    media: list[str] = field(default_factory=list)
    context_token: str = ""
    nickname: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


# ── persistence ──────────────────────────────────────────────────
WX_LOG_FILE = _paths.ADMIN_DATA / "wechat_log.jsonl"
# Compact the on-disk log when it exceeds this size — we only keep the
# most recent ``log_capacity`` entries in memory anyway, so a multi-MB
# tail of churned-out lines wastes space without any user benefit.
WX_LOG_COMPACT_BYTES = 10 * 1024 * 1024


def _load_log_tail(file: Path, n: int) -> list[WxLogEntry]:
    if not file.is_file():
        return []
    try:
        size = file.stat().st_size
        if size <= 5 * 1024 * 1024:
            text = file.read_text("utf-8", errors="replace")
        else:
            # Seek-tail to avoid loading huge files. Drop the (likely
            # truncated) first line.
            with file.open("rb") as f:
                f.seek(-2 * 1024 * 1024, os.SEEK_END)
                text = f.read().decode("utf-8", errors="replace")
            text = text.split("\n", 1)[1] if "\n" in text else text
        lines = text.splitlines()
        out: list[WxLogEntry] = []
        for line in lines[-n:]:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
                out.append(WxLogEntry(
                    ts=int(d.get("ts", 0)),
                    direction=str(d.get("direction", "")),
                    uid=str(d.get("uid", "")),
                    text=str(d.get("text", "")),
                    media=list(d.get("media", []) or []),
                    context_token=str(d.get("context_token", "")),
                    nickname=str(d.get("nickname", "")),
                ))
            except Exception:
                continue
        return out
    except Exception as e:
        log.warning("wechat log load failed: %s", e)
        return []


def _compact_log(file: Path, entries: list[WxLogEntry]) -> None:
    try:
        file.parent.mkdir(parents=True, exist_ok=True)
        tmp = file.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e.to_dict(), ensure_ascii=False) + "\n")
        tmp.replace(file)
    except Exception as e:
        log.warning("wechat log compact failed: %s", e)


# ── service ──────────────────────────────────────────────────────
class WeChatService:
    _instance: "WeChatService | None" = None

    def __init__(self, agent_service: AgentService, *, allowlist: list[str] | None = None,
                 log_capacity: int = 2000):
        self.agent_service = agent_service
        self.bot = WxBotClient()
        self.contacts: dict[str, WxContact] = {}
        self.allowlist = to_allowed_set(allowlist if allowlist is not None else ["*"])
        self._poll_thread: threading.Thread | None = None
        self._stop_flag = False
        self._qr_thread: threading.Thread | None = None
        self._qr_state: dict = {"status": "idle"}
        self._qr_lock = threading.Lock()

        # Persistence: load tail of the on-disk JSONL into the in-memory
        # deque, then compact the file if it has grown unboundedly large.
        self._log_lock = threading.Lock()
        loaded = _load_log_tail(WX_LOG_FILE, log_capacity)
        self.log: deque[WxLogEntry] = deque(loaded, maxlen=log_capacity)
        for e in loaded:
            c = self.contacts.setdefault(e.uid, WxContact(uid=e.uid))
            if e.nickname and not c.nickname:
                c.nickname = e.nickname
            if e.ts > c.last_ts:
                c.last_text = (e.text or ("[media]" if e.media else ""))[:200]
                c.last_ts = e.ts
            if e.direction == "in":
                c.msg_count += 1
        try:
            if WX_LOG_FILE.is_file() and WX_LOG_FILE.stat().st_size > WX_LOG_COMPACT_BYTES:
                _compact_log(WX_LOG_FILE, list(self.log))
        except Exception as ex:
            log.warning("wechat log size probe failed: %s", ex)

    def _persist_entry(self, entry: WxLogEntry) -> None:
        try:
            WX_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
            with self._log_lock:
                with WX_LOG_FILE.open("a", encoding="utf-8") as f:
                    f.write(json.dumps(entry.to_dict(), ensure_ascii=False) + "\n")
        except Exception as e:
            log.warning("wechat persist failed: %s", e)

    def clear_log(self) -> None:
        """Wipe both in-memory and on-disk wechat history.

        Contacts are also cleared because they're a reduction of the log;
        rebuilding them from a now-empty deque would zero them anyway.
        """
        with self._log_lock:
            self.log.clear()
            self.contacts.clear()
            try:
                if WX_LOG_FILE.is_file():
                    WX_LOG_FILE.unlink()
            except Exception as e:
                log.warning("wechat clear failed: %s", e)
        bus.publish("wechat:log_cleared", {})

    @classmethod
    def instance(cls, agent_service: AgentService | None = None) -> "WeChatService":
        if cls._instance is None:
            assert agent_service is not None, "first call must pass agent_service"
            cls._instance = cls(agent_service)
        return cls._instance

    # ── status ───────────────────────────────────────────────────
    def status(self) -> dict:
        with self._qr_lock:
            qr = dict(self._qr_state)
        return {
            "logged_in": self.bot.has_token,
            "bot_id": self.bot.bot_id or "",
            "polling": bool(self._poll_thread and self._poll_thread.is_alive()),
            "qr": qr,
            "contacts": len(self.contacts),
            "allowlist": sorted(self.allowlist) if not public_access(self.allowlist) else ["*"],
            "log_count": len(self.log),
        }

    def set_allowlist(self, allowed: list[str]) -> None:
        self.allowlist = to_allowed_set(allowed)
        bus.publish("wechat:allowlist", {"allowlist": sorted(self.allowlist)})

    def is_allowed(self, uid: str) -> bool:
        if public_access(self.allowlist):
            return True
        return uid in self.allowlist

    # ── login ────────────────────────────────────────────────────
    def start_qr_login(self) -> dict:
        """Begin QR login flow in a background thread; return initial state immediately."""
        with self._qr_lock:
            if self._qr_thread and self._qr_thread.is_alive():
                return dict(self._qr_state)
        self._qr_thread = threading.Thread(target=self._qr_login_run, daemon=True, name="wx-qr")
        self._qr_thread.start()
        time.sleep(0.4)  # give it a moment to fetch the QR
        with self._qr_lock:
            return dict(self._qr_state)

    def _qr_login_run(self) -> None:
        def _on_status(s: dict):
            with self._qr_lock:
                self._qr_state = {**s}
            bus.publish("wechat:qr_status", s)

        try:
            self.bot.login_qr(on_status=_on_status)
            with self._qr_lock:
                self._qr_state = {"status": "confirmed", "bot_id": self.bot.bot_id}
            bus.publish("wechat:qr_status", {"status": "confirmed", "bot_id": self.bot.bot_id})
            self.start_polling()
        except Exception as e:
            with self._qr_lock:
                self._qr_state = {"status": "error", "error": str(e)}
            bus.publish("wechat:qr_status", {"status": "error", "error": str(e)})

    def logout(self) -> None:
        self.stop_polling()
        self.bot.clear_token()
        with self._qr_lock:
            self._qr_state = {"status": "idle"}
        bus.publish("wechat:logout", {})

    # ── polling ──────────────────────────────────────────────────
    def start_polling(self) -> bool:
        if not self.bot.has_token:
            return False
        if self._poll_thread and self._poll_thread.is_alive():
            return True
        self._stop_flag = False
        self._poll_thread = threading.Thread(target=self._poll_run, daemon=True, name="wx-poll")
        self._poll_thread.start()
        bus.publish("wechat:polling", {"running": True, "bot_id": self.bot.bot_id})
        return True

    def stop_polling(self) -> None:
        self._stop_flag = True
        bus.publish("wechat:polling", {"running": False})

    def _poll_run(self) -> None:
        try:
            self.bot.run_loop(self._on_message, stop_flag=lambda: self._stop_flag)
        except Exception as e:
            log.exception("wx poll loop crashed: %s", e)
            bus.publish("wechat:error", {"error": str(e)})

    # ── inbound ──────────────────────────────────────────────────
    def _on_message(self, bot: WxBotClient, msg: dict) -> None:
        uid = msg.get("from_user_id", "")
        ctx = msg.get("context_token", "")
        text = bot.extract_text(msg).strip()
        media = download_media(msg.get("item_list", []), WX_MEDIA_DIR)

        if not text and not media:
            return

        if not self.is_allowed(uid):
            log.info("[wx] blocked uid=%s (not in allowlist)", uid[:20])
            bus.publish("wechat:blocked", {"uid": uid, "preview": text[:80]})
            return

        # update contact
        c = self.contacts.setdefault(uid, WxContact(uid=uid))
        c.last_text = (text or ("[media]" if media else ""))[:200]
        c.last_ts = int(time.time())
        c.msg_count += 1

        entry = WxLogEntry(
            ts=int(time.time()), direction="in", uid=uid,
            text=text, media=list(media), context_token=ctx,
            nickname=c.nickname,
        )
        self.log.append(entry)
        self._persist_entry(entry)
        bus.publish("wechat:message_in", entry.to_dict())

        # commands (compatibility with frontends/wechatapp.py)
        if text in ("/stop", "/abort"):
            self.agent_service.abort()
            self._send_text(uid, "已停止", ctx)
            return
        if text.startswith("/llm"):
            args = text.split()
            if len(args) > 1:
                try:
                    n = int(args[1])
                    self.agent_service.switch_llm(n)
                    self._send_text(uid, f"切换到 [{self.agent_service.agent.llm_no}] {self.agent_service.agent.get_llm_name()}", ctx)
                except (ValueError, IndexError):
                    self._send_text(uid, f"用法: /llm <0-{len(self.agent_service.list_llms())-1}>", ctx)
            else:
                lines = [f"{'→' if cur else '  '} [{i}] {name}"
                         for i, name, cur in self.agent_service.agent.list_llms()]
                self._send_text(uid, "LLMs:\n" + "\n".join(lines), ctx)
            return

        # forward to agent in a worker thread
        prompt_text = text
        if media:
            prompt_text = (text + "\n" if text else "") + "\n".join(f"[用户发送文件: {p}]" for p in media)
        prompt = f"If you need to show files to user, use [FILE:filepath] in your response.\n\n{prompt_text}"

        def _handle():
            handle = self.agent_service.submit(prompt, source="wechat")
            try:
                self.bot.send_typing(uid)
            except Exception:
                pass

            sent = 0
            mi = 0
            last_send = 0.0
            result = ""
            try:
                while True:
                    item = handle.display_queue.get(timeout=300)
                    if "done" in item:
                        result = item["done"]
                        break
                    raw = item.get("next", "")
                    done, _partial = _turn_parts(raw)
                    if len(done) > sent:
                        merged = _clean("\n\n".join(done[sent:]))
                        now = time.time()
                        if mi < 9 and merged.strip():
                            if mi and (now - last_send) < 6 * mi:
                                continue
                            try:
                                self._send_text(uid, merged[:2000], ctx)
                                mi += 1
                                last_send = time.time()
                                sent = len(done)
                            except Exception as e:
                                log.warning("wx mid send err: %s", e)
            except _q.Empty:
                result = "[超时]"

            done_segs, partial = _turn_parts(result)
            rest = "\n\n".join(done_segs[sent:] + [partial] + ["\n\n[任务已完成]"])
            if rest.strip():
                try:
                    self._send_text(uid, _clean(rest)[-2000:], ctx)
                except Exception as e:
                    log.warning("wx final send err: %s", e)

            files = re.findall(r"\[FILE:([^\]]+)\]", result)
            bad = {"filepath", "<filepath>", "path", "<path>", "file_path", "<file_path>", "..."}
            files = [
                f for f in files
                if f.strip().lower() not in bad
                and (f if os.path.isabs(f) else os.path.join(str(_paths.temp_dir()), f)) not in media
            ]
            for fpath in set(files):
                if not os.path.isabs(fpath):
                    fpath = os.path.join(str(_paths.temp_dir()), fpath)
                try:
                    if not os.path.exists(fpath):
                        raise FileNotFoundError(fpath)
                    self._send_file_smart(uid, fpath, ctx)
                except Exception as e:
                    log.warning("wx send media err: %s", e)

        threading.Thread(target=_handle, daemon=True, name="wx-handle").start()

    # ── outbound ─────────────────────────────────────────────────
    def _record_outbound(self, uid: str, text: str, media: list[str], ctx: str) -> None:
        nick = self.contacts.get(uid).nickname if uid in self.contacts else ""
        entry = WxLogEntry(
            ts=int(time.time()), direction="out", uid=uid,
            text=text, media=media, context_token=ctx,
            nickname=nick,
        )
        self.log.append(entry)
        self._persist_entry(entry)
        bus.publish("wechat:message_out", entry.to_dict())

    def _send_text(self, uid: str, text: str, ctx: str = "") -> dict:
        r = self.bot.send_text(uid, text, context_token=ctx)
        self._record_outbound(uid, text, [], ctx)
        return r

    def _send_file_smart(self, uid: str, path: str, ctx: str = "") -> dict:
        ext = os.path.splitext(path)[1].lower()
        if ext in {".mp4", ".mov", ".m4v", ".webm"}:
            r = self.bot.send_video(uid, path, context_token=ctx)
        elif ext in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}:
            r = self.bot.send_image(uid, path, context_token=ctx)
        else:
            r = self.bot.send_file(uid, path, context_token=ctx)
        self._record_outbound(uid, f"[file:{os.path.basename(path)}]", [path], ctx)
        return r

    # public send API (for /api/wechat/send manual dispatch)
    def send_text(self, uid: str, text: str, ctx: str = "") -> dict:
        return self._send_text(uid, text, ctx)

    def send_file(self, uid: str, path: str, ctx: str = "") -> dict:
        return self._send_file_smart(uid, path, ctx)

    # ── inspection ───────────────────────────────────────────────
    def list_contacts(self) -> list[dict]:
        return [c.to_dict() for c in sorted(
            self.contacts.values(), key=lambda x: x.last_ts, reverse=True
        )]

    def get_messages(self, uid: str | None = None, limit: int = 200) -> list[dict]:
        items = list(self.log)
        if uid:
            items = [e for e in items if e.uid == uid]
        return [e.to_dict() for e in items[-limit:]]
