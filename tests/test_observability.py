"""Regression tests for bounded logging and health summary semantics."""
from __future__ import annotations

import io
import logging
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from server import logging_config
from server.routes import logs as log_routes
from server.services.service_registry import ServiceRegistry


def test_application_logging_is_bounded_and_idempotent() -> None:
    logger = logging.Logger("observability-test")
    with TemporaryDirectory() as tmp, mock.patch.object(logging_config, "MAX_LOG_BYTES", 96), mock.patch.object(
        logging_config, "LOG_BACKUP_COUNT", 2
    ):
        log_dir = Path(tmp)
        log_path = logging_config.configure_application_logging(log_dir, logger=logger, stream=io.StringIO())
        logging_config.configure_application_logging(log_dir, logger=logger, stream=io.StringIO())
        assert len(logger.handlers) == 2

        for index in range(20):
            logger.info("record-%02d-%s", index, "x" * 30)
        for handler in logger.handlers:
            handler.flush()

        assert log_path.exists()
        assert (log_dir / "backend.log.1").exists()
        assert not (log_dir / "backend.log.3").exists()

        for handler in list(logger.handlers):
            handler.close()


def test_backend_log_redaction_and_tail_limit() -> None:
    with TemporaryDirectory() as tmp:
        path = Path(tmp) / "backend.log"
        path.write_text(
            "Bearer super-secret\napi_key=abc123 password: hunter2\nordinary message\n",
            encoding="utf-8",
        )
        lines = log_routes._tail(str(path), 2, redact=True)

    assert lines == [
        "api_key=[REDACTED] password: [REDACTED]",
        "ordinary message",
    ]
    assert all(secret not in "\n".join(lines) for secret in ("super-secret", "abc123", "hunter2"))


def _summary_for(states: list[str]) -> dict:
    registry = ServiceRegistry()
    services = [
        {"id": f"service-{index}", "state": state, "summary": state}
        for index, state in enumerate(states)
    ]
    with mock.patch.object(registry, "panel", return_value={"services": services, "timestamp": 42}):
        return registry.health_summary()


def test_health_summary_uses_stable_vocabulary() -> None:
    assert _summary_for(["running", "ready"])["status"] == "healthy"
    assert _summary_for(["stopped"])["status"] == "unavailable"
    assert _summary_for(["error"])["status"] == "unknown"

    degraded = _summary_for(["running", "stopped", "unexpected"])
    assert degraded["status"] == "degraded"
    assert [item["status"] for item in degraded["services"]] == [
        "healthy",
        "unavailable",
        "unknown",
    ]
    assert degraded["timestamp"] == 42
