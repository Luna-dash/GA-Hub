"""SMTP email delivery for scheduled task notifications."""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Any

from .email_config_store import _STORE

log = logging.getLogger(__name__)

def load_config(*, public: bool = False) -> dict[str, Any]:
    return _STORE.read(public=public)


def save_config(payload: dict[str, Any]) -> dict[str, Any]:
    return _STORE.update(payload)


def _validate_send_config(cfg: dict[str, Any], to: str) -> tuple[str, str, str]:
    host = str(cfg.get("host") or "").strip()
    if not host:
        raise ValueError("SMTP host 未配置")
    from_addr = str(cfg.get("from_addr") or cfg.get("username") or "").strip()
    if not from_addr:
        raise ValueError("发件人未配置")
    final_to = (to or str(cfg.get("default_to") or "")).strip()
    if not final_to:
        raise ValueError("收件人未配置")
    return host, from_addr, final_to


def send_email(to: str, subject: str, body: str) -> dict[str, Any]:
    cfg = load_config(public=False)
    host, from_addr, final_to = _validate_send_config(cfg, to)
    port = int(cfg.get("port") or (465 if cfg.get("use_ssl") else 587))

    msg = EmailMessage()
    msg["From"] = from_addr
    msg["To"] = final_to
    msg["Subject"] = subject or "GenericAgent 通知"
    msg.set_content(body or "")

    try:
        if cfg.get("use_ssl"):
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=20)
        else:
            smtp = smtplib.SMTP(host, port, timeout=20)
        with smtp:
            if cfg.get("use_tls") and not cfg.get("use_ssl"):
                smtp.starttls()
            username = str(cfg.get("username") or "").strip()
            password = str(cfg.get("password") or "")
            if username:
                smtp.login(username, password)
            smtp.send_message(msg)
        return {"ok": True, "to": final_to}
    except Exception as e:
        log.warning("email send failed: %s", e)
        return {"ok": False, "to": final_to, "error": str(e)}


def test_email(to: str = "", subject: str = "GenericAgent 邮件测试", body: str = "") -> dict[str, Any]:
    return send_email(to, subject, body or "这是一封来自 GA-Hub 的测试邮件。")
