"""Storage ownership tests for SMTP configuration."""
from __future__ import annotations

import json

import pytest

from server.services.email_config_store import EmailConfigFormatError, EmailConfigStore


def test_store_owns_defaults_public_view_and_atomic_update(tmp_path) -> None:
    path = tmp_path / "email_config.json"
    store = EmailConfigStore(path)

    assert store.read(public=True) == {
        "host": "",
        "port": 587,
        "username": "",
        "from_addr": "",
        "default_to": "",
        "use_tls": True,
        "use_ssl": False,
        "password_set": False,
    }

    view = store.update(
        {
            "host": "smtp.example.com",
            "username": "agent@example.com",
            "password": "secret",
            "unknown": "ignored",
        }
    )

    assert view["host"] == "smtp.example.com"
    assert view["password_set"] is True
    assert "password" not in view
    persisted = json.loads(path.read_text(encoding="utf-8"))
    assert persisted["password"] == "secret"
    assert "unknown" not in persisted
    assert list(tmp_path.glob("*.tmp")) == []

    retained = store.update({"host": "smtp2.example.com", "password": ""})
    assert retained["host"] == "smtp2.example.com"
    assert retained["password_set"] is True
    assert store.read()["password"] == "secret"


def test_store_rejects_invalid_documents_and_ports(tmp_path) -> None:
    path = tmp_path / "email_config.json"
    store = EmailConfigStore(path)
    path.write_text("[]", encoding="utf-8")

    with pytest.raises(EmailConfigFormatError):
        store.read()

    path.write_text("{}", encoding="utf-8")
    valid_port = store.update({"port": 465})
    assert valid_port["port"] == 465

    path.write_text(json.dumps({"port": "not-a-number"}), encoding="utf-8")
    with pytest.raises(EmailConfigFormatError):
        store.read()
