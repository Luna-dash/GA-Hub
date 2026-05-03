"""WeChat iLink bot client — extracted from frontends/wechatapp.py.

Pure transport layer: QR login, long-poll updates, send text/image/file/video,
download/decrypt incoming media. No agent integration here.

This module is the single source of truth for the WeChat protocol — both
frontends/wechatapp.py and server/services/wechat_service.py import from here.
For backward-compat, frontends/wechatapp.py keeps its own inlined copy as
fallback if this module is unavailable.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
import uuid
from io import BytesIO
from pathlib import Path
from urllib.parse import quote

import requests
from Crypto.Cipher import AES

# Strip any inherited proxy that breaks WeChat long-poll SSL
for _k in ("HTTPS_PROXY", "https_proxy"):
    os.environ.pop(_k, None)

API = "https://ilinkai.weixin.qq.com"
TOKEN_FILE_DEFAULT = Path.home() / ".wxbot" / "token.json"
TOKEN_FILE_DEFAULT.parent.mkdir(exist_ok=True)

VER = "2.1.10"
MSG_USER, MSG_BOT = 1, 2
ITEM_TEXT, ITEM_IMAGE, ITEM_FILE, ITEM_VIDEO = 1, 2, 4, 5
STATE_FINISH = 2
ILINK_APP_ID = "bot"
ILINK_APP_CLIENT_VERSION = (2 << 16) | (1 << 8) | 10
UA = f"openclaw-weixin/{VER}"
CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c"

MEDIA_KEYS = {"image_item": ".jpg", "video_item": ".mp4", "file_item": "", "voice_item": ".silk"}


def _uin() -> str:
    return base64.b64encode(str(struct.unpack(">I", os.urandom(4))[0]).encode()).decode()


class WxBotClient:
    def __init__(self, token: str | None = None, token_file: str | os.PathLike | None = None):
        self._tf = Path(token_file) if token_file else TOKEN_FILE_DEFAULT
        self.token = token
        self.bot_id: str | None = None
        self._buf = ""
        if not self.token:
            self._load()

    # ── token persistence ────────────────────────────────────────
    def _load(self) -> None:
        if self._tf.exists():
            d = json.loads(self._tf.read_text("utf-8"))
            self.token = d.get("bot_token", "")
            self.bot_id = d.get("ilink_bot_id", "")
            self._buf = d.get("updates_buf", "")

    def _save(self, **kw) -> None:
        d = {"bot_token": self.token or "", "ilink_bot_id": self.bot_id or "",
             "updates_buf": self._buf or "", **kw}
        self._tf.write_text(json.dumps(d, ensure_ascii=False, indent=2), "utf-8")

    def clear_token(self) -> None:
        self.token = None
        self.bot_id = None
        self._buf = ""
        try:
            if self._tf.exists():
                self._tf.unlink()
        except Exception:
            pass

    @property
    def has_token(self) -> bool:
        return bool(self.token)

    # ── transport ────────────────────────────────────────────────
    def _post(self, ep: str, body: dict, timeout: int = 15):
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        h = {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "Content-Length": str(len(data)),
            "X-WECHAT-UIN": _uin(),
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": str(ILINK_APP_CLIENT_VERSION),
            "User-Agent": UA,
        }
        tok = (self.token or "").strip()
        if tok:
            h["Authorization"] = f"Bearer {tok}"
        r = requests.post(f"{API}/{ep}", data=data, headers=h, timeout=timeout)
        r.raise_for_status()
        return r.json()

    # ── QR login ─────────────────────────────────────────────────
    def request_qrcode(self) -> tuple[str, str]:
        """Return (qrcode_id, qrcode_url). Caller renders the QR for user to scan."""
        r = requests.get(
            f"{API}/ilink/bot/get_bot_qrcode",
            params={"bot_type": 3},
            headers={"User-Agent": UA},
            timeout=10,
        )
        r.raise_for_status()
        d = r.json()
        return d["qrcode"], d.get("qrcode_img_content", "")

    def poll_qrcode_status(self, qrcode_id: str) -> dict:
        """Poll once. Returns the status dict (status: scanning|confirmed|expired|...)."""
        try:
            return requests.get(
                f"{API}/ilink/bot/get_qrcode_status",
                params={"qrcode": qrcode_id},
                headers={"User-Agent": UA},
                timeout=60,
            ).json()
        except requests.exceptions.ReadTimeout:
            return {"status": "timeout"}

    def login_qr(self, poll_interval: int = 2, on_status=None):
        """Blocking login flow that opens a QR PNG. Used by CLI/legacy wechatapp.py."""
        qr_id, url = self.request_qrcode()
        if on_status:
            on_status({"status": "waiting_scan", "qrcode_id": qr_id, "url": url})
        if url:
            try:
                import qrcode  # type: ignore
                img = self._tf.parent / "wx_qr.png"
                qrcode.make(url).save(str(img))
                subprocess.Popen(["open", str(img)])
            except Exception:
                pass
        last = ""
        while True:
            time.sleep(poll_interval)
            s = self.poll_qrcode_status(qr_id)
            st = s.get("status", "")
            if st != last:
                if on_status:
                    on_status({**s, "qrcode_id": qr_id})
                last = st
            if st == "confirmed":
                self.token = s.get("bot_token", "")
                self.bot_id = s.get("ilink_bot_id", "")
                self._save(login_time=time.strftime("%Y-%m-%d %H:%M:%S"))
                return s
            if st == "expired":
                raise RuntimeError("二维码过期")

    # ── long poll ────────────────────────────────────────────────
    def get_updates(self, timeout: int = 30) -> list[dict]:
        try:
            resp = self._post(
                "ilink/bot/getupdates",
                {"get_updates_buf": self._buf or "", "base_info": {"channel_version": VER}},
                timeout=timeout + 5,
            )
        except requests.exceptions.ReadTimeout:
            return []
        if resp.get("errcode"):
            if resp["errcode"] == -14:
                self._buf = ""
                self._save()
            return []
        nb = resp.get("get_updates_buf", "")
        if nb:
            self._buf = nb
            self._save()
        return resp.get("msgs") or []

    # ── send ─────────────────────────────────────────────────────
    def send_text(self, to_user_id: str, text: str, context_token: str = "") -> dict:
        msg = {
            "from_user_id": "", "to_user_id": to_user_id,
            "client_id": f"pyclient-{uuid.uuid4().hex[:16]}",
            "message_type": MSG_BOT, "message_state": STATE_FINISH,
            "item_list": [{"type": ITEM_TEXT, "text_item": {"text": text}}],
        }
        if context_token:
            msg["context_token"] = context_token
        return self._post("ilink/bot/sendmessage", {"msg": msg, "base_info": {"channel_version": VER}})

    def send_typing(self, to_user_id: str, typing_ticket: str = "", cancel: bool = False) -> dict:
        return self._post("ilink/bot/sendtyping", {
            "ilink_user_id": to_user_id, "typing_ticket": typing_ticket,
            "status": 2 if cancel else 1,
            "base_info": {"channel_version": VER},
        })

    def send_image(self, to_user_id: str, file_path: str, context_token: str = "") -> dict:
        return self._send_media(to_user_id, file_path, 1, ITEM_IMAGE, "image_item", context_token)

    def send_video(self, to_user_id: str, file_path: str, context_token: str = "") -> dict:
        return self._send_media(to_user_id, file_path, 2, ITEM_VIDEO, "video_item", context_token)

    def send_file(self, to_user_id: str, file_path: str, context_token: str = "") -> dict:
        return self._send_media(to_user_id, file_path, 3, ITEM_FILE, "file_item", context_token)

    # ── media internals ──────────────────────────────────────────
    @staticmethod
    def _enc(raw: bytes, aes_key: bytes) -> bytes:
        pad = 16 - (len(raw) % 16)
        return AES.new(aes_key, AES.MODE_ECB).encrypt(raw + bytes([pad] * pad))

    def _upload(self, filekey: str, upload_param: str, raw: bytes, aes_key: bytes,
                timeout: int = 120, upload_url: str = "") -> dict:
        url = upload_url.strip() if upload_url else (
            f"{CDN_BASE}/upload?encrypted_query_param={quote(upload_param)}&filekey={filekey}"
        )
        data = self._enc(raw, aes_key)
        last_err = None
        for attempt in range(1, 4):
            try:
                r = requests.post(
                    url, data=data,
                    headers={"Content-Type": "application/octet-stream", "User-Agent": UA},
                    timeout=timeout,
                )
                if 400 <= r.status_code < 500:
                    msg = r.headers.get("x-error-message") or r.text[:300]
                    raise RuntimeError(f"CDN upload client error {r.status_code}: {msg}")
                if r.status_code != 200:
                    msg = r.headers.get("x-error-message") or f"status {r.status_code}"
                    raise RuntimeError(f"CDN upload server error: {msg}")
                eq = r.headers.get("x-encrypted-param", "")
                if not eq:
                    raise RuntimeError("CDN upload response missing x-encrypted-param header")
                return {
                    "encrypt_query_param": eq,
                    "aes_key": base64.b64encode(aes_key.hex().encode()).decode(),
                    "encrypt_type": 1,
                }
            except Exception as e:
                last_err = e
                if "client error" in str(e) or attempt >= 3:
                    break
        raise last_err  # type: ignore[misc]

    def _send_media(self, to_user_id: str, file_path: str, media_type: int,
                    item_type: int, item_key: str, context_token: str = "") -> dict:
        fp = Path(file_path)
        raw = fp.read_bytes()
        filekey = uuid.uuid4().hex
        aes_key = os.urandom(16)
        ciphertext_size = ((len(raw) // 16) + 1) * 16
        thumb_raw = b""; thumb_w = thumb_h = 0; thumb_ciphertext_size = 0
        if item_key == "image_item":
            from PIL import Image  # lazy
            im = Image.open(fp)
            im.thumbnail((240, 240))
            thumb_w, thumb_h = im.size
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            bio = BytesIO()
            im.save(bio, format="JPEG", quality=85)
            thumb_raw = bio.getvalue()
            thumb_ciphertext_size = ((len(thumb_raw) // 16) + 1) * 16
        body = {
            "filekey": filekey, "media_type": media_type, "to_user_id": to_user_id,
            "rawsize": len(raw), "rawfilemd5": hashlib.md5(raw).hexdigest(),
            "filesize": ciphertext_size,
            "no_need_thumb": item_key not in ("image_item", "video_item"),
            "aeskey": aes_key.hex(),
            "base_info": {"channel_version": VER},
        }
        if thumb_raw:
            body.update({
                "thumb_rawsize": len(thumb_raw),
                "thumb_rawfilemd5": hashlib.md5(thumb_raw).hexdigest(),
                "thumb_filesize": thumb_ciphertext_size,
            })
        resp = self._post("ilink/bot/getuploadurl", body)
        upload_param = resp.get("upload_param", "")
        upload_url = resp.get("upload_full_url", "")
        if not (upload_param or upload_url):
            raise RuntimeError(f"getuploadurl failed: {resp}")
        media = self._upload(filekey, upload_param, raw, aes_key=aes_key, upload_url=upload_url)
        item: dict = {"media": media}
        if item_key == "file_item":
            item.update({"file_name": fp.name, "len": str(len(raw))})
        elif item_key == "image_item":
            thumb_param = resp.get("thumb_upload_param", "")
            thumb_url = resp.get("thumb_upload_full_url", "")
            if thumb_param or thumb_url:
                thumb_media = self._upload(filekey, thumb_param, thumb_raw, aes_key=aes_key, upload_url=thumb_url)
                thumb_size = thumb_ciphertext_size
            else:
                thumb_media = media
                thumb_size = ciphertext_size
            item.update({
                "mid_size": ciphertext_size, "thumb_media": thumb_media,
                "thumb_size": thumb_size,
                "thumb_width": thumb_w, "thumb_height": thumb_h,
            })
        elif item_key == "video_item":
            item.update({"video_size": ciphertext_size})
        msg = {
            "from_user_id": "", "to_user_id": to_user_id,
            "client_id": f"pyclient-{uuid.uuid4().hex[:16]}",
            "message_type": MSG_BOT, "message_state": STATE_FINISH,
            "item_list": [{"type": item_type, item_key: item}],
        }
        if context_token:
            msg["context_token"] = context_token
        return self._post("ilink/bot/sendmessage", {"msg": msg, "base_info": {"channel_version": VER}})

    # ── parsing helpers ──────────────────────────────────────────
    @staticmethod
    def extract_text(msg: dict) -> str:
        return "\n".join(
            it["text_item"].get("text", "")
            for it in msg.get("item_list", [])
            if it.get("type") == ITEM_TEXT and it.get("text_item")
        )

    @staticmethod
    def is_user_msg(msg: dict) -> bool:
        return msg.get("message_type") == MSG_USER

    # ── runner ───────────────────────────────────────────────────
    def run_loop(self, on_message, poll_timeout: int = 30, stop_flag=None) -> None:
        seen: set = set()
        while True:
            if stop_flag and stop_flag():
                return
            try:
                for msg in self.get_updates(poll_timeout):
                    mid = msg.get("message_id", 0)
                    if not self.is_user_msg(msg) or mid in seen:
                        continue
                    seen.add(mid)
                    if len(seen) > 5000:
                        seen = set(list(seen)[-2000:])
                    try:
                        on_message(self, msg)
                    except Exception as e:
                        print(f"[Bot] on_message error: {e}", file=sys.__stderr__)
            except KeyboardInterrupt:
                return
            except Exception as e:
                print(f"[Bot] loop error: {e}; retry 5s", file=sys.__stderr__)
                time.sleep(5)


def download_media(items: list[dict], dest_dir: str) -> list[str]:
    """Download & decrypt all media items in a message into ``dest_dir``.

    Returns list of saved local file paths.
    """
    paths: list[str] = []
    os.makedirs(dest_dir, exist_ok=True)
    for item in items:
        for key, ext in MEDIA_KEYS.items():
            sub = item.get(key)
            if not sub:
                continue
            eq = (sub.get("media") or {}).get("encrypt_query_param")
            if not eq:
                continue
            ak = (sub.get("media") or {}).get("aes_key", "") or sub.get("aeskey", "")
            if not ak:
                continue
            try:
                aes_key = (
                    bytes.fromhex(base64.b64decode(ak).decode())
                    if sub.get("media", {}).get("aes_key")
                    else bytes.fromhex(ak)
                )
                ct = requests.get(
                    f"{CDN_BASE}/download?encrypted_query_param={quote(eq)}",
                    headers={"User-Agent": UA},
                    timeout=60,
                ).content
                pt = AES.new(aes_key, AES.MODE_ECB).decrypt(ct)
                pt = pt[: -pt[-1]]
                fname = sub.get("file_name") or f"{uuid.uuid4().hex[:8]}{ext or '.bin'}"
                p = os.path.join(dest_dir, fname)
                with open(p, "wb") as f:
                    f.write(pt)
                paths.append(p)
            except Exception as e:
                print(f"[WX] media dl err ({key}): {e}", file=sys.__stderr__)
            break
    return paths
