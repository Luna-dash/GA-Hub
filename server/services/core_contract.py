"""GA core contract diagnostics (P0).

GA-Hub's backend depends on a small, stable surface of the GenericAgent
("GA core") project: the ``GeneraticAgent`` class, a handful of its methods,
a few instance attributes set in ``__init__``, and two helpers exported by
``frontends.continue_cmd``. When the user upgrades GA core, a rename or a
removed symbol silently breaks chat with an opaque ``ImportError`` /
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
    "next_llm",     # next_llm(idx)
    "list_llms",    # list_llms() -> [(i, name, current)]
    "load_llm_sessions",
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

# frontends.continue_cmd helpers used by agent_service.
_REQUIRED_CONTINUE_CMD: tuple[str, ...] = (
    "install",            # install(GeneraticAgent) — class-level patch
    "reset_conversation", # reset_conversation(agent) -> agent
)


# ── result types ────────────────────────────────────────────────────────────
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

    # 4) frontends.continue_cmd helpers
    try:
        import frontends.continue_cmd as cc  # noqa: E402
    except Exception as e:  # noqa: BLE001
        for name in _REQUIRED_CONTINUE_CMD:
            items.append(Check(f"frontends.continue_cmd.{name}", False,
                               f"import_failed: {e!r}"))
            errors.append(f"import_failed: frontends.continue_cmd: {e!r}")
    else:
        for name in _REQUIRED_CONTINUE_CMD:
            items.append(_check_callable("frontends.continue_cmd",
                                          getattr(cc, name, None), name))
            if not items[-1].ok:
                errors.append(f"frontends.continue_cmd.{name} missing or not callable")

    ok = all(c.ok for c in items)
    return ContractReport(
        ga_root=str(ga_root),
        core_commit=_core_commit(ga_root),
        ok=ok,
        items=items,
        errors=errors,
    )
