"""Compatibility facade delegating local agy profile operations to agy_profile."""
from __future__ import annotations

from .agy_profile import (  # noqa: F401
    DEFAULT,
    PROFILE_ID,
    AgyProfileError,
    Profile,
    _root,
    acp_spawn_command,
    add,
    agy_executable,
    agy_executable_or_none,
    capture_default,
    clean_agy_env,
    clear_credentials,
    delete,
    has_local_credentials,
    prepare_profile,
    profile_env,
    record_usage,
    rename,
    select,
    snapshot,
    snapshot_details,
    system_proxy_env,
)
