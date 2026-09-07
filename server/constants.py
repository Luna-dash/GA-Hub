"""Hub-wide constants: fixed ports and the GA_HUB_* environment registry.

One home for every fixed localhost port and every ``GA_HUB_*`` name so call
sites cannot drift apart silently (review: port constants and env names were
scattered with no registry).

Not every constant is importable from every layer — the webui dev port lives
in ``webui/vite.config.ts`` and the desktop shell mirrors it in Rust; those
are documented here as cross-language facts rather than imported values.
"""
from __future__ import annotations

# ── fixed ports ─────────────────────────────────────────────────
# Backend listen address (server.run). Overridable via GA's mykey.py
# (webui_port / webui_host); the singleton lock socket binds port+1.
DEFAULT_WEBUI_PORT = 8765
SINGLETON_LOCK_PORT_OFFSET = 1
# GA conductor engine's default listen port (server.services.conductor_client).
CONDUCTOR_ENGINE_PORT = 18770
# Frontend dev server (webui/vite.config.ts), mirrored by the Tauri dev
# origin allowance in src-tauri/src/main.rs. Not imported anywhere in Python.
VITE_DEV_PORT = 5173

# ── GA_HUB_* environment variables (inputs) ─────────────────────
# Callback address for in-process services that call the Hub API; set by
# server.runtime_endpoint.configure_runtime_endpoint at startup.
ENV_RUNTIME_HOST = "GA_HUB_RUNTIME_HOST"
ENV_RUNTIME_PORT = "GA_HUB_RUNTIME_PORT"
# _paths.py: opt-in to exposing site paths outside the discovered GA root.
ENV_ENABLE_EXTERNAL_SITE_PATHS = "GA_HUB_ENABLE_EXTERNAL_SITE_PATHS"
# Desktop build chain: interpreter used for the PyInstaller sidecar build
# (scripts/build_all.py and src-tauri/src/main.rs).
ENV_SIDECAR_PYTHON = "GA_HUB_PYTHON"
# Desktop shell: dev-mode sidecar override and debug bridge port
# (src-tauri/src/main.rs).
ENV_SIDECAR = "GA_HUB_SIDECAR"
ENV_BRIDGE_PORT = "GA_HUB_BRIDGE_PORT"

# ── session run capacity (server/routes/sessions.py + session_coordinator) ──
# GAHUB_* env override for how many sessions may run concurrently; the gate
# is shared by webui chat, wechat, scheduled and autonomous producers, so
# the ceiling must leave headroom above interactive use alone (default 10).
ENV_SESSION_RUN_CAPACITY = "GAHUB_SESSION_RUN_CAPACITY"
# gahub_app engine (conductor_client): engine temp/journal locations.
ENV_GAHUB_TEMP_DIR = "GAHUB_TEMP_DIR"
ENV_GAHUB_JOURNAL_PATH = "GAHUB_JOURNAL_PATH"
# gahub_app engine (conductor_client): comma-separated deliverable allow-list.
# Without it the engine only accepts deliverable paths under the GA repo root,
# so any user task naming an outside folder strands before dispatch (422).
ENV_GAHUB_DELIVERABLE_ROOTS = "GAHUB_DELIVERABLE_ROOTS"
# UI origin allowlist beyond localhost (main.py).
ENV_GAHUB_ALLOWED_HOSTS = "GAHUB_ALLOWED_HOSTS"
# mykey sync (routes/mykey.py): sync-site root URL and the credential env
# entries the sync subprocess consumes; the probe strips both secrets from
# the child environment.
ENV_MYKEY_SYNC_URL = "GA_MYKEY_SYNC_URL"
ENV_MYKEY_SYNC_PASSPHRASE = "GA_MYKEY_SYNC_PASSPHRASE"
ENV_MYKEY_UPLOAD_TOKEN = "GA_MYKEY_UPLOAD_TOKEN"
# gahub_app engine overrides (conductor_client): config keys gahub_python/
# gahub_port/gahub_token resolve to env GAHUB_<KEY.upper()> — the doubled
# prefix is historical and wire-compatible. Built dynamically by
# _config_int/_config_str, so the env-name scan cannot see them; they are
# registered here by hand.
ENV_GAHUB_GAHUB_PYTHON = "GAHUB_GAHUB_PYTHON"
ENV_GAHUB_GAHUB_PORT = "GAHUB_GAHUB_PORT"
ENV_GAHUB_GAHUB_TOKEN = "GAHUB_GAHUB_TOKEN"
SESSION_RUN_CAPACITY_DEFAULT = 10
SESSION_RUN_CAPACITY_MAX = 10

# ── GA_HUB_-namespaced protocol markers (NOT environment inputs) ──
# GA_HUB_MYKEY_PYTHON=..;CRYPTOGRAPHY=..  stdout probe marker (routes/mykey.py)
# __GA_HUB_HIDE_LOADING__                 Tauri loading-gate marker (main.rs)
# __GA_HUB_RUNTIME__                      window global injected by main.rs
# __GA_HUB_PERF__                         webui-only chat perf ring buffer
#                                         (webui/src/utils/chatPerformance.ts;
#                                         never crosses a process boundary)
