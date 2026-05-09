"""SMTP email delivery for scheduled task notifications."""
from __future__ import annotations

import json
import logging
import smtplib
from email.message import EmailMessage
from pathlib import Path
from typing import Any

from .. import _paths

log = logging.getLogger(__name__)

_DEFAULT_CFG = {
    "host": "",
    "port": 587,
    "username": "",
    "password": "",
    "from_addr": "",
    "default_to": "",
    "use_tls": True,
    "use_ssl": False,
}


def _config_path() -> Path:
    return _paths.email_config_file()


def load_config(*, public: bool = False) -> dict[str, Any]:
    cfg = dict(_DEFAULT_CFG)
    path = _config_path()
    if path.is_file():
        try:
            data = json.loads(path.read_text("utf-8"))
            cfg.update({k: v for k, v in data.items() if k in cfg})
        except Exception as e:
            log.warning("email_config.json unreadable: %s", e)
    cfg["port"] = int(cfg.get("port") or 587)
    cfg["use_tls"] = bool(cfg.get("use_tls"))
    cfg["use_ssl"] = bool(cfg.get("use_ssl"))
    if public:
        password_set = bool(cfg.get("password"))
        cfg.pop("password", None)
        cfg["password_set"] = password_set
    return cfg


def save_config(payload: dict[str, Any]) -> dict[str, Any]:
    existing = load_config(public=False)
    cfg = dict(_DEFAULT_CFG)
    cfg.update(existing)
    for k in _DEFAULT_CFG:
        if k not in payload:
            continue
        if k == "password" and not payload.get(k) and existing.get("password"):
            continue
        cfg[k] = payload[k]
    cfg["port"] = int(cfg.get("port") or 587)
    cfg["use_tls"] = bool(cfg.get("use_tls"))
    cfg["use_ssl"] = bool(cfg.get("use_ssl"))
    path = _config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), "utf-8")
    tmp.replace(path)
    return load_config(public=True)


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
    return send_email(to, subject, body or "这是一封来自 GenericAgent-Admin 的测试邮件。")
