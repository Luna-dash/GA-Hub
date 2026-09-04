"""Shared pytest configuration for the GA-Hub backend tests.

Living here pins the repo root on sys.path before collection, so a bare
``pytest`` (not ``python -m pytest``) resolves the ``server`` package the
same way from any working directory.
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
