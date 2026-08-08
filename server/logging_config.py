"""Bounded application logging for the GA-Hub backend."""
from __future__ import annotations

import logging
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import TextIO

LOG_FORMAT = "%(asctime)s %(levelname)-5s %(name)s :: %(message)s"
MAX_LOG_BYTES = 5 * 1024 * 1024
LOG_BACKUP_COUNT = 3


def configure_application_logging(
    log_dir: Path,
    *,
    logger: logging.Logger | None = None,
    stream: TextIO | None = None,
) -> Path:
    """Configure console + bounded UTF-8 file logging and return the log path.

    Existing handlers are closed and replaced so repeated launcher setup never
    duplicates each log line. Tests may pass an isolated ``logger``.
    """
    target = logger or logging.getLogger()
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "backend.log"
    formatter = logging.Formatter(LOG_FORMAT)

    for handler in list(target.handlers):
        target.removeHandler(handler)
        handler.close()

    console = logging.StreamHandler(stream or sys.stderr)
    console.setFormatter(formatter)
    rotating = RotatingFileHandler(
        log_path,
        maxBytes=MAX_LOG_BYTES,
        backupCount=LOG_BACKUP_COUNT,
        encoding="utf-8",
    )
    rotating.setFormatter(formatter)
    target.addHandler(console)
    target.addHandler(rotating)
    target.setLevel(logging.INFO)
    return log_path
