"""Hub-owned validation for the GA Conductor wire contract.

This module deliberately does not import GA.  The provider declaration lives
in GA while these requirements describe what this Hub build can consume;
paired-repository tests keep the two declarations aligned.
"""
from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from ..constants import ENV_GAHUB_DELIVERABLE_ROOTS, ENV_GAHUB_PATH_POLICY


PROTOCOL_VERSION = 2
SERVICE_NAME = "gahub"
REQUIRED_CAPABILITIES = frozenset({
    "snapshot_revision",
    "path_policy",
    "sse_resync",
    "guarded_actions",
    "unified_admission",
    "request_recovery",
    "operation_receipts",
})


class ProtocolValidationError(RuntimeError):
    """The engine is reachable but incompatible with this Hub build."""


def validate_protocol(response: Mapping[str, Any], *, expected_env: Mapping[str, str]) -> None:
    """Validate the common health/recovery protocol envelope.

    Transport success is intentionally outside this function: an HTTP 200 is
    only readiness when this complete contract also matches.
    """
    version = response.get("protocol_version")
    if version != PROTOCOL_VERSION:
        raise ProtocolValidationError(
            f"engine protocol_version must be {PROTOCOL_VERSION}, got {version!r}")

    capabilities = set(response.get("capabilities") or [])
    missing = sorted(REQUIRED_CAPABILITIES - capabilities)
    if missing:
        raise ProtocolValidationError(
            "engine protocol missing required capabilities: " + ", ".join(missing))

    if not response.get("boot_id"):
        raise ProtocolValidationError("engine protocol has no boot identity (boot_id)")

    policy = response.get("path_policy") or {}
    expected_mode = expected_env[ENV_GAHUB_PATH_POLICY]
    if policy.get("mode") != expected_mode:
        raise ProtocolValidationError(
            "engine path policy differs from Hub configuration: "
            f"expected {expected_mode!r}, got {policy.get('mode')!r}")

    roots = expected_env.get(ENV_GAHUB_DELIVERABLE_ROOTS, "")
    if roots.strip() and expected_mode == "allowed_roots":
        normalize = lambda path: os.path.normcase(os.path.realpath(path))
        wanted = {normalize(path.strip()) for path in roots.split(",") if path.strip()}
        actual = {normalize(path) for path in policy.get("allowed_roots") or []}
        if wanted != actual:
            raise ProtocolValidationError(
                "engine allowed roots differ from Hub configuration")
