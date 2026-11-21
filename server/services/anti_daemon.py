"""Compatibility shim exposing the standalone Agy ACP runtime as `daemon`."""
from __future__ import annotations

from .agy_runtime import (  # noqa: F401
    AgyRuntimeManager as AntiDaemon,
    AntiAuthState,
    AntiDaemonState,
    AntiDaemonStatus,
    runtime as daemon,
)
