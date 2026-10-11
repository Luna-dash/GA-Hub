"""GA core contract diagnostics (P0).

GA-Hub's backend depends on a small, stable surface of the GenericAgent
("GA core") project: the ``GeneraticAgent`` class and a handful of its
methods and instance attributes, the whole registered
``frontends.gahub.bridge`` seam (session lifecycle, archive projection,
workspace, usage, model, rewind, official hub), and the remaining direct GA
modules the backend still imports. When the user upgrades GA core, a rename
or a removed symbol silently breaks chat with an opaque ``ImportError`` /
``AttributeError`` deep in a worker thread.

This module makes that contract *explicit and observable*:

* ``probe_core_contract()`` imports GA core using the *same* sys.path
  mechanism as ``agent_service`` (``_paths.bootstrap_sys_path``), then
  verifies every symbol GA-Hub actually calls. No subprocess, no second
  import path — so the probe sees exactly what the live service sees.
* The result is surfaced at ``GET /api/health/core-contract`` and is
  evaluated during app lifespan startup. On failure the service still
  boots (to the diagnostic page) but chat returns
  ``503 core_contract_failed``.

Design notes
------------
* We deliberately do **not** instantiate ``GeneraticAgent`` — that spawns
  threads / loads LLM clients / touches the network. Contract presence is
  checked statically (``inspect`` + ``__init__`` source scan), which is
  what we actually need: "does the symbol the backend calls still exist?"
* Instance attributes are verified by scanning ``GeneraticAgent.__init__``
  source for ``self.<attr>`` assignments rather than ``hasattr`` on a live
  instance — the latter would require construction and would also pass for
  attributes only set inside other methods (false confidence).
* No secrets are returned: only paths, a git revision, capability bits and
  error strings.

The probe is intentionally pure (no I/O side effects beyond importing GA
core and reading one git revision) so it can be unit-tested with stub
modules injected into ``sys.modules``.
"""

from __future__ import annotations

import inspect
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .. import _paths
from ..process_utils import hidden_process_kwargs

log = _paths.log  # reuse the configured logger

# ── the contract surface ────────────────────────────────────────────────────
# Mirrors the real call sites in ``server/services/agent_service.py``. Keep
# these lists in sync with that file; ``test_core_contract`` asserts the
# names against the actual source so drift fails loudly.

# Methods GA-Hub calls on a GeneraticAgent instance / class.
_REQUIRED_CLASS_MEMBERS: tuple[str, ...] = (
    "put_task",     # put_task(query, source=, images=) -> queue
    "abort",        # abort()
    "run",          # run() — main loop
    "list_llms",    # list_llms() -> [(i, name, current)]
    "get_llm_name",
)

# Attributes assigned in GeneraticAgent.__init__ that agent_service reads.
# Verified by scanning __init__ source for `self.<name>` assignment.
_REQUIRED_INIT_ATTRS: tuple[str, ...] = (
    "llm_no",
    "llmclient",
    "history",
    "inc_out",
    "is_running",
    "stop_sig",
    "all_outputs",
    "task_queue",
)

# Every GA module/name the backend imports, including the whole registered
# bridge surface. An empty tuple means "importing this module IS the contract".
#
# This replaces an older declaration that pinned raw ``frontends.continue_cmd``
# helpers (``install`` / ``reset_conversation``) which Hub no longer calls
# directly — those requests now go through ``frontends.gahub.bridge.session``.
# Pinning them meant a GA upgrade could fail the startup gate (chat 503) for a
# symbol nothing in this repo touches, while the 17 bridge symbols Hub *does*
# call were checked by nothing at all.
#
# Keep in sync with the real import sites: ``tests/test_ga_boundary_contract.py``
# derives this surface from the source and fails on both a missing declaration
# and an over-declaration.
_REQUIRED_GA_SYMBOLS: dict[str, tuple[str, ...]] = {
    # ── registered bridge: GA's declared seam for GA-Hub ────────────────────
    "frontends.gahub.bridge.archive": (
        "list_native_sessions",
        "mint_native_log_path",
        "project_archive_text",
    ),
    "frontends.gahub.bridge.model": (
        "mykey_revision",
        "model_snapshot",
        "switch_model",
    ),
    "frontends.gahub.bridge.official_hub": (
        "attach",
        "detach",
        "hub_client_class",
    ),
    "frontends.gahub.bridge.rewind": (
        "apply_durable",
        "bind_store",
        "sync_store",
        "sync_working_memory",
    ),
    "frontends.gahub.bridge.runtime": (
        "create_main_agent",
        "register_turn_end_hook",
        "unregister_turn_end_hook",
    ),
    "frontends.gahub.bridge.session": (
        "acquire_birth_lock",
        "begin_fresh_session",
        "continue_inplace",
        "release_current",
        "reset_conversation",
        "restore_archive",
        "takeover_stale_lock",
    ),
    "frontends.gahub.bridge.usage": (
        "initialize_usage_tracking",
        "read_usage_ledger",
    ),
    "frontends.gahub.bridge.workspace": (
        "get_workspace",
        "list_workspaces",
        "prepare_workspace",
        "remove_workspace",
    ),
    # ── remaining direct GA dependencies (debt registry in the boundary test) ─
    "agentmain": (),  # class members are checked by _REQUIRED_CLASS_MEMBERS
    "frontends.btw_cmd": ("handle_frontend_command",),
    "frontends.chatapp_common": ("public_access", "to_allowed_set"),
    "ga": (),      # GA's own package root, patched in-process by ga_subprocess_patch
    "llmcore": ("resolve_client",),
    "mykey": (),   # imported by server/run.py for GA's key bootstrap
}


# ── result types ────────────────────────────────────────────────────────────
class CoreRuntimeUnavailable(RuntimeError):
    """The app has not established a compatible GA runtime."""


def require_core_contract(report: ContractReport | None) -> None:
    if report is None or not report.ok:
        raise CoreRuntimeUnavailable("GA core 契约不可用，请在设置中检查 GA 路径和运行环境。")


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""


@dataclass
class ContractReport:
    """Result of probing the GA core contract.

    ``ok`` is the aggregate pass/fail. ``items`` carries per-symbol
    checks so callers can render *which* symbol is missing rather than a
    generic import error. Serialized via ``to_dict`` for the JSON endpoint.
    """

    ga_root: str | None
    core_commit: str | None
    ok: bool
    items: list[Check] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["items"] = [asdict(c) if isinstance(c, Check) else c for c in self.items]
        return d


# ── helpers ─────────────────────────────────────────────────────────────────
def _ga_root_path() -> Path | None:
    """Return the resolved GA root, bootstrapping sys.path if configured.

    ``bootstrap_sys_path`` is idempotent and safe to call repeatedly; we
    invoke it here so the probe is self-sufficient even if it runs before
    any other GA-Hub module has imported GA core.
    """
    if _paths.GA_ROOT is None:
        return None
    return _paths.bootstrap_sys_path(_paths.GA_ROOT)


def _core_commit(ga_root: Path) -> str | None:
    """Best-effort: resolve the GA core git revision.

    Returns ``None`` (not an error) if GA root is not a git repo — a
    user may run from a zip export. We shell out to git rather than use
    a git library to avoid an extra dependency.
    """
    import subprocess

    try:
        out = subprocess.run(
            ["git", "-C", str(ga_root), "rev-parse", "--short", "HEAD"],
            capture_output=True,
            # The desktop sidecar reserves stdin as its owner-shutdown pipe.
            # Git for Windows may keep reading an inherited open pipe, which
            # blocks ``communicate()`` and therefore the entire app lifespan.
            stdin=subprocess.DEVNULL,
            text=True,
            timeout=5,
            **hidden_process_kwargs(),
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception as e:  # noqa: BLE001 — best effort only
        log.debug("could not resolve GA core commit: %s", e)
    return None


def _check_init_attr(cls: type, attr: str) -> Check:
    """Verify ``self.<attr>`` is assigned in ``cls.__init__`` source.

    We scan the *source* of ``__init__`` for ``self.<attr>`` followed by
    ``=`` (assignment), which is the only way the attribute becomes part
    of every instance's initial state. ``hasattr`` on a constructed
    instance would be a stronger signal but requires construction (spawns
    threads / network); ``getattr`` on the class is wrong for instance
    attrs. Source scan is the right trade-off for a startup probe.
    """
    try:
        src = inspect.getsource(cls.__init__)
    except (OSError, TypeError) as e:
        return Check(attr, False, f"could not read __init__ source: {e}")
    # match `self.attr =` allowing whitespace, and `self.attr:` (ann.)
    pattern = re.compile(rf"\bself\.{re.escape(attr)}\b\s*[:=]")
    if pattern.search(src):
        return Check(attr, True, "assigned in __init__")
    return Check(attr, False, "not assigned in __init__")


def _check_callable(module_name: str, obj: Any, name: str) -> Check:
    """Verify a name resolves to a callable in a module."""
    if obj is None:
        return Check(f"{module_name}.{name}", False, "missing")
    if not callable(obj):
        return Check(f"{module_name}.{name}", False, "present but not callable")
    return Check(f"{module_name}.{name}", True, "callable")


# ── public API ───────────────────────────────────────────────────────────────
def probe_core_contract() -> ContractReport:
    """Probe the GA core contract surface used by GA-Hub.

    Safe to call in any app state:
    * GA_ROOT unset → returns ``ok=False`` with a clear ``not_configured``
      error (the service is in setup mode).
    * GA core importable and complete → ``ok=True`` with per-symbol bits.
    * GA core importable but a symbol is gone → ``ok=False`` listing the
      specific missing symbols.
    * GA core not importable at all → ``ok=False`` with the import error.
    """
    ga_root = _ga_root_path()
    if ga_root is None:
        return ContractReport(
            ga_root=None,
            core_commit=None,
            ok=False,
            items=[],
            errors=["not_configured: GA_ROOT is not set (setup mode)"],
        )

    items: list[Check] = []
    errors: list[str] = []

    # 1) module-level: agentmain.GeneraticAgent
    try:
        import agentmain  # noqa: E402 — resolved via _paths sys.path
    except Exception as e:  # noqa: BLE001 — any import failure is fatal here
        return ContractReport(
            ga_root=str(ga_root),
            core_commit=None,
            ok=False,
            items=[],
            errors=[f"import_failed: agentmain: {e!r}"],
        )

    GA = getattr(agentmain, "GeneraticAgent", None)
    items.append(
        Check("agentmain.GeneraticAgent", GA is not None and inspect.isclass(GA),
              "class present" if GA is not None else "missing")
    )
    if GA is None or not inspect.isclass(GA):
        errors.append("GeneraticAgent class missing from agentmain")
        return ContractReport(
            ga_root=str(ga_root),
            core_commit=_core_commit(ga_root),
            ok=False,
            items=items,
            errors=errors,
        )

    # 2) class methods
    for name in _REQUIRED_CLASS_MEMBERS:
        member = getattr(GA, name, None)
        if callable(member):
            items.append(Check(f"GeneraticAgent.{name}", True, "callable"))
        else:
            items.append(Check(f"GeneraticAgent.{name}", False,
                                "missing or not callable"))
            errors.append(f"GeneraticAgent.{name} missing or not callable")

    # 3) __init__ instance attributes
    for attr in _REQUIRED_INIT_ATTRS:
        items.append(_check_init_attr(GA, attr))
        if not items[-1].ok:
            errors.append(f"GeneraticAgent.__init__ missing attr: {attr}")

    # 4) every GA module Hub imports, and every name it takes from them.
    #
    # ``importlib.import_module`` (not a static ``import``) so a single missing
    # module is one red item instead of an exception that hides the rest, and
    # so the loop can report *which* module failed.
    import importlib

    for module_name, names in _REQUIRED_GA_SYMBOLS.items():
        try:
            module = importlib.import_module(module_name)
        except Exception as e:  # noqa: BLE001 — any import failure is the finding
            if not names:
                items.append(Check(module_name, False, f"import failed: {e!r}"))
                errors.append(f"{module_name} not importable: {e!r}")
                continue
            for name in names:
                items.append(Check(f"{module_name}.{name}", False,
                                    f"import_failed: {e!r}"))
            errors.append(f"import_failed: {module_name}: {e!r}")
            continue
        if not names:
            items.append(Check(module_name, True, "importable"))
            continue
        for name in names:
            items.append(_check_callable(module_name, getattr(module, name, None), name))
            if not items[-1].ok:
                errors.append(f"{module_name}.{name} missing or not callable")

    # 5) GA runtime dependencies reachable from this interpreter. Frozen
    # desktop sidecars do not bundle GA's third-party dependencies; they
    # rely on _paths.bootstrap_sys_path injecting the discovered GA
    # interpreter's site-packages. ``frontends.worldline`` (durable rewind,
    # exercised on session restore) takes its only third-party hop into
    # ``rich``; Hub reaches worldline solely through the registered
    # ``frontends.gahub.bridge.rewind`` contract, so probe ``rich`` and let a
    # broken environment show up as a red setup item instead of a generic
    # "restore failed" on session open.
    try:
        import rich  # noqa: F401
    except Exception as e:  # noqa: BLE001
        items.append(Check("rich", False, f"import failed: {e!r}"))
        errors.append(
            "rich not importable (durable rewind will fail on session restore): "
            f"{e!r}"
        )
    else:
        items.append(Check("rich", True, "importable"))

    ok = all(c.ok for c in items)
    return ContractReport(
        ga_root=str(ga_root),
        core_commit=_core_commit(ga_root),
        ok=ok,
        items=items,
        errors=errors,
    )
