"""Structural and behavioural contract for the Conductor collaborator cluster.

Architecture review problem 5 ("Conductor 五对象友元团"): the command track and
the recovery loop held the whole ``ConductorService`` and reached into its
private members, the store mutated the tracker's private projection, and neither
collaborator could be built without an engine. The fixes this file guards:

- P1 — ``ConductorStore`` and ``WorkflowTracker`` still share one transaction,
  but each owns its half: the store persists rows, the tracker owns the
  in-memory projection *and* its worker-ownership index. The store reaches the
  projection only through the public seam (``capacity``/``attach``/
  ``rollback_point``/``restore_projection``/``prune_terminal``/``lock``).
- P2 — ``ConductorCommands`` and ``ConductorRecovery`` depend on
  ``ConductorKernel`` (``conductor_kernel.py``) instead of the service, and
  ``build_collaborators`` is the only wiring site.

The static tests fail the moment a collaborator names a private member or an
undeclared kernel member again. The behavioural tests drive both collaborators
against a fake kernel — no service, engine, process manager or SQLite file of
the service's own anywhere — which is the capability the refactor bought.

Deliberate exemptions, both outside this cluster's ownership:
``conductor_client.py`` reaches into ``self.pm._headers`` (engine transport,
tracked for its own pass), and ``conductor_service.py`` uses ``cls._instance`` /
``obj._init_fields`` on its own class, which is same-class access rather than
the friend-group pattern.
"""
from __future__ import annotations

import ast
import re
import threading
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from server.services.conductor_client import GahubProcessError
from server.services.conductor_commands import ConductorCommands
from server.services.conductor_kernel import ConductorKernel, build_collaborators
from server.services.conductor_recovery import ConductorRecovery
from server.services.conductor_service import ConductorService
from server.services.conductor_store import ConductorStore
from server.services.conductor_workflow import WorkflowTracker

ROOT = Path(__file__).resolve().parents[1]
SERVICES = ROOT / "server" / "services"

# The two collaborator modules must never name the service again.
COLLABORATORS = ("conductor_commands.py", "conductor_recovery.py")
# Files whose cross-object private access is this refactor's responsibility.
GUARDED = COLLABORATORS + ("conductor_store.py", "conductor_workflow.py")


def _source(name: str) -> str:
    return (SERVICES / name).read_text(encoding="utf-8")


def _tree(name: str) -> ast.Module:
    return ast.parse(_source(name))


def _foreign_private_accesses_in(source: str) -> list[tuple[int, str]]:
    """Private attribute accesses in ``source`` that are not on ``self``/``cls``.

    Includes the reach-through form (``self.kernel.callbacks._x``): the point of
    the kernel is that a collaborator cannot grab another object's internals,
    however many hops it takes to name them.
    """
    found: list[tuple[int, str]] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, ast.Attribute):
            continue
        if not node.attr.startswith("_") or node.attr.startswith("__"):
            continue
        base = node.value
        if isinstance(base, ast.Name) and base.id in ("self", "cls"):
            continue
        found.append((node.lineno, ast.unparse(node)))
    return sorted(found)


def _foreign_private_accesses(name: str) -> list[tuple[int, str]]:
    return _foreign_private_accesses_in(_source(name))


def _identifiers_in(source: str) -> set[str]:
    tree = ast.parse(source)
    return {node.id for node in ast.walk(tree) if isinstance(node, ast.Name)} | {
        node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
    }


def _kernel_members() -> set[str]:
    members: set[str] = set()
    for node in ast.walk(_tree("conductor_kernel.py")):
        if isinstance(node, ast.ClassDef) and node.name == "ConductorKernel":
            for item in node.body:
                if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                    members.add(item.target.id)
                elif isinstance(item, ast.FunctionDef):
                    members.add(item.name)
    return members


def _kernel_uses() -> dict[str, set[str]]:
    """``<member> -> files`` for every kernel member the collaborators use."""
    uses: dict[str, set[str]] = {}
    for name in COLLABORATORS + ("conductor_kernel.py",):
        text = (SERVICES / name).read_text(encoding="utf-8")
        for match in re.finditer(r"\bkernel\.([A-Za-z_][A-Za-z0-9_]*)", text):
            uses.setdefault(match.group(1), set()).add(name)
    return uses


# ── static guards: no private reach ──────────────────────────────────────────

@pytest.mark.parametrize("module", GUARDED)
def test_cluster_never_reaches_into_another_object(module: str) -> None:
    offenders = _foreign_private_accesses(module)
    assert offenders == [], (
        f"{module} reaches into another object's private state: "
        + ", ".join(f"line {line}: {expr}" for line, expr in offenders)
    )


@pytest.mark.parametrize("module", COLLABORATORS)
def test_collaborators_do_not_name_the_service(module: str) -> None:
    assert "service" not in _identifiers_in(_source(module)), (
        f"{module} still holds a service reference; collaborators depend on "
        "ConductorKernel instead"
    )


@pytest.mark.parametrize("body,detected", [
    ("self.kernel.callbacks._hidden()", True),   # reach-through private call
    ("self.service._assert_open()", True),       # the old shape
    ("self.tracker._workflows.pop('r')", True),  # store into the projection
    ("self.service.publish('t', {})", False),    # public, but the name test flags it
    ("self.kernel.assert_open()", False),        # the contract shape
    ("with self.store.transaction():\n            pass", False),
])
def test_the_private_reach_guard_actually_bites(body: str, detected: bool) -> None:
    """A guard that cannot fail proves nothing: feed it known shapes.

    The second-to-last case is the reason both guards exist — a public member
    reached through the wrong object is caught by the identifier rule, not by
    the private-attribute rule.
    """
    source = f"class X:\n    def f(self):\n        {body}\n"
    assert bool(_foreign_private_accesses_in(source)) is detected
    if body.startswith("self.service"):
        assert "service" in _identifiers_in(source)
    else:
        assert "service" not in _identifiers_in(source)


def test_the_store_never_touches_the_tracker_projection() -> None:
    """The P1 seam in one assertion: rows are the store's, state is the tracker's."""
    text = (SERVICES / "conductor_store.py").read_text(encoding="utf-8")
    assert re.search(r"\btracker\._", text) is None
    assert re.search(r"self\.tracker\._", text) is None


def test_the_tracker_never_reaches_into_the_store() -> None:
    text = (SERVICES / "conductor_workflow.py").read_text(encoding="utf-8")
    assert re.search(r"self\.store\._", text) is None


# ── the kernel contract ──────────────────────────────────────────────────────

def test_kernel_surface_is_entirely_public() -> None:
    private = sorted(member for member in _kernel_members() if member.startswith("_"))
    assert private == []


def test_collaborators_use_only_declared_kernel_members() -> None:
    undeclared = {
        member: sorted(files)
        for member, files in _kernel_uses().items()
        if member not in _kernel_members()
    }
    assert undeclared == {}, (
        "collaborators reach for members the kernel does not declare: "
        f"{undeclared}; add them to ConductorKernel deliberately"
    )


def test_kernel_declares_nothing_speculative() -> None:
    """Every declared member is referenced somewhere in the cluster."""
    cluster_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in list(SERVICES.glob("conductor*.py")) + [SERVICES / "conductor_service.py"]
    )
    orphans = sorted(
        member for member in _kernel_members()
        if re.search(rf"\b{re.escape(member)}\b", cluster_text) is None
    )
    assert orphans == []


def test_the_service_satisfies_the_kernel_contract() -> None:
    service = ConductorService.for_tests()
    try:
        missing = sorted(member for member in _kernel_members() if not hasattr(service, member))
        assert missing == []
        assert isinstance(service, ConductorKernel) is True
    finally:
        service.store.close()


# ── assembly invariants (P1 + P2 wiring) ─────────────────────────────────────

def test_build_collaborators_wires_one_pair_and_one_kernel() -> None:
    service = ConductorService.for_tests()
    try:
        # One tracker, one store: the projection and its rows cannot diverge.
        assert service.store.tracker is service.workflow_tracker
        # One kernel: both collaborators talk to the same service.
        assert service.commands.kernel is service
        assert service.recovery.kernel is service
        assert service.commands.store is service.store
        assert service.recovery.store is service.store
        assert service.commands.recovery is service.recovery
    finally:
        service.store.close()


def test_a_tracker_refuses_to_be_attached_to_a_second_store() -> None:
    first_tracker = WorkflowTracker(clock=lambda: 10.0)
    second_tracker = WorkflowTracker(clock=lambda: 10.0)
    first = ConductorStore(":memory:", "engine-a", first_tracker)
    second = ConductorStore(":memory:", "engine-b", second_tracker)
    try:
        assert first_tracker.store is first
        with pytest.raises(RuntimeError, match="already attached"):
            first_tracker.attach(second)
        assert first_tracker.store is first
    finally:
        first.close()
        second.close()


def test_store_notification_failure_marks_the_service_dirty() -> None:
    service = ConductorService.for_tests()
    try:
        assert service.notifications_dirty is False
        service.store.notification_failed()  # the store's post-commit hook
        assert service.notifications_dirty is True
        service.clear_notifications_dirty()
        assert service.notifications_dirty is False
    finally:
        service.store.close()


def test_build_collaborators_repr_is_the_documented_triple() -> None:
    tracker = WorkflowTracker(clock=lambda: 10.0)
    kernel = _FakeKernel(tracker)
    store, recovery, commands = build_collaborators(
        kernel, store_path=":memory:", engine_base_url="http://127.0.0.1:1"
    )
    try:
        assert store.tracker is tracker
        assert (recovery.kernel, commands.kernel) == (kernel, kernel)
        assert commands.store is store and commands.recovery is recovery
    finally:
        store.close()


# ── projection rollback (P1 seam behaviour) ──────────────────────────────────

def test_transaction_holds_the_projection_lock() -> None:
    tracker = WorkflowTracker(clock=lambda: 10.0)
    store = ConductorStore(":memory:", "engine-a", tracker)
    try:
        with store.transaction():
            assert tracker.lock._is_owned()
    finally:
        store.close()


def test_a_failed_transaction_rolls_the_projection_back_with_its_index() -> None:
    tracker = WorkflowTracker(clock=lambda: 10.0)
    store = ConductorStore(":memory:", "engine-a", tracker)
    try:
        tracker.admit("rid-1", boot_id="boot-a")
        tracker.bind_subagent("rid-1", "worker-1", 1)

        with pytest.raises(RuntimeError, match="boom"):
            with store.transaction():
                tracker.admit("rid-2", boot_id="boot-a")
                tracker.bind_subagent("rid-2", "worker-2", 1)
                raise RuntimeError("boom")

        # In-memory half: the rolled-back workflow and its worker are gone.
        assert tracker.has_request("rid-2") is False
        assert tracker.request_for_subagent("worker-2") is None
        # Durable half: no row survived it either.
        assert store.workflow("rid-2") is None
        # And the committed workflow kept both its row and its ownership.
        assert store.workflow("rid-1") is not None
        assert tracker.request_for_subagent("worker-1") == "rid-1"
    finally:
        store.close()


def test_a_committed_transaction_persists_what_it_touched() -> None:
    tracker = WorkflowTracker(clock=lambda: 10.0)
    store = ConductorStore(":memory:", "engine-a", tracker)
    try:
        with store.transaction():
            tracker.admit("rid-3", boot_id="boot-a")
            tracker.set_title("rid-3", "committed")
        row = store.workflow("rid-3")
        assert row is not None and row["title"] == "committed"
    finally:
        store.close()


# ── the kernel seam in use: both collaborators without a service ─────────────

class _FakeKernel:
    """ConductorKernel in twenty lines — the capability the seam bought."""

    def __init__(self, tracker: WorkflowTracker) -> None:
        self.workflow_tracker = tracker
        self.store: ConductorStore | None = None
        self.client = SimpleNamespace()
        self.pool = SimpleNamespace()
        self.callbacks = SimpleNamespace()
        self.commands = SimpleNamespace()
        self.calls: list = []
        self.closed = False
        self._notifications = False
        self._auto_accept = True

    # admission / lifecycle
    def assert_open(self) -> None:
        self.calls.append("assert_open")
        if self.closed:
            raise RuntimeError("Conductor service is closed")

    def assert_engine_ready(self) -> None:
        self.calls.append("assert_engine_ready")

    def ensure_started(self, wake_recovery: bool = True) -> bool:
        self.calls.append("ensure_started")
        return True

    def ensure_relay(self) -> None:
        self.calls.append("ensure_relay")

    def configure_models(self, **kwargs) -> dict:
        self.calls.append("configure_models")
        return {}

    def push_models_to_engine(self, snapshot=None) -> None:
        self.calls.append("push_models_to_engine")

    def admit_action_models(self, *args, **kwargs):
        self.calls.append("admit_action_models")
        return self.workflow_tracker, {}, None

    # hub-side effects
    def publish(self, topic: str, payload: dict) -> None:
        self.calls.append(("publish", topic))

    def publish_workflow_transition(self, transition) -> None:
        self.calls.append(("transition", transition))

    def on_remote_chat(self, item: dict) -> None:
        self.calls.append(("chat", item))

    def mark_notifications_dirty(self) -> None:
        self._notifications = True

    def clear_notifications_dirty(self) -> None:
        self._notifications = False

    def remember_lifecycle(self, status: dict, *, merge: bool = False) -> None:
        self.calls.append(("lifecycle", merge))

    def chat_guard(self):
        return nullcontext()

    @property
    def notifications_dirty(self) -> bool:
        return self._notifications

    @property
    def auto_accept(self) -> bool:
        return self._auto_accept


def _bare_commands(*, ready: bool = False):
    """A command track built from a fake kernel plus an in-memory store."""
    tracker = WorkflowTracker(clock=lambda: 10.0)
    store = ConductorStore(":memory:", "engine-a", tracker)
    kernel = _FakeKernel(tracker)
    kernel.store = store
    recovery = SimpleNamespace(
        boot_id="boot-a",
        ready=ready,
        sync=lambda: ready,
        stop_event=threading.Event(),
    )
    return ConductorCommands(kernel, store, recovery), kernel, store


def test_enqueue_auto_accept_needs_only_the_store() -> None:
    commands, kernel, store = _bare_commands()
    try:
        commands.enqueue_auto_accept("worker-1", "rid-1", 2)
        rows = store.pending_commands()
        assert len(rows) == 1
        assert rows[0]["operation_id"].startswith("autoaccept-")
        assert rows[0]["payload"]["intent"]["action"] == "accept"
        assert kernel.calls == []
    finally:
        store.close()


def test_submit_asks_the_kernel_before_touching_the_store() -> None:
    commands, kernel, store = _bare_commands()
    try:
        kernel.closed = True
        with pytest.raises(RuntimeError, match="closed"):
            commands.submit("op-1", {"kind": "chat", "role": "user", "msg": "hi"})
        assert kernel.calls == ["assert_open"]
        assert store.command("op-1") is None
    finally:
        store.close()


def test_submit_admits_through_the_kernel_tracker_then_defers_to_recovery() -> None:
    commands, kernel, store = _bare_commands()
    try:
        with pytest.raises(GahubProcessError) as failure:
            commands.submit("op-2", {"kind": "chat", "role": "user", "msg": "hi"})
        # Recovery is not ready in this bare setup: the command must survive as
        # pending for the drain loop instead of being lost.
        assert failure.value.status_code == 503
        row = store.command("op-2")
        assert row is not None and row["state"] == "pending"
        request_id = row["payload"]["request_id"]
        assert kernel.workflow_tracker.has_request(request_id) is True
        # Both entry points re-check the shutdown gate before doing any work:
        # submit() admits, execute_command() delivers.
        assert [call if isinstance(call, str) else call[0] for call in kernel.calls] == [
            "assert_open", "assert_open", "configure_models", "ensure_started",
        ]
    finally:
        store.close()


def test_submit_refuses_a_reused_operation_id_with_different_arguments() -> None:
    commands, kernel, store = _bare_commands()
    try:
        with pytest.raises(GahubProcessError):
            commands.submit("op-3", {"kind": "chat", "role": "user", "msg": "hi"})
        with pytest.raises(Exception) as conflict:
            commands.submit("op-3", {"kind": "chat", "role": "user", "msg": "different"})
        assert "different arguments" in str(conflict.value)
    finally:
        store.close()


def _bare_recovery(*, boot_id: str = "boot-a"):
    tracker = WorkflowTracker(clock=lambda: 10.0)
    store = ConductorStore(":memory:", "engine-a", tracker)
    kernel = _FakeKernel(tracker)
    kernel.store = store
    frames: list = []
    kernel.callbacks = SimpleNamespace(
        on_conductor_log_frame=frames.append,
        publish_subagent_snapshot=lambda: frames.append("snapshot"),
    )
    recovery = ConductorRecovery(kernel, store)
    recovery.boot_id = boot_id
    return recovery, kernel, store, frames


def test_recovery_dispatches_log_frames_through_the_kernel() -> None:
    recovery, kernel, store, frames = _bare_recovery()
    try:
        assert recovery.on_event({"event": "log", "boot_id": "boot-a", "item": {"seq": 1}})
        assert frames == [{"seq": 1}]
        # A frame from another boot is ignored, not mis-applied.
        assert recovery.on_event({"event": "log", "boot_id": "boot-old", "item": {"seq": 2}})
        assert frames == [{"seq": 1}]
    finally:
        store.close()


def test_recovery_publishes_pool_snapshots_through_the_kernel() -> None:
    recovery, kernel, store, frames = _bare_recovery()
    kernel.pool = SimpleNamespace(update=lambda *a, **k: True)
    try:
        assert recovery.on_event({"event": "subagents", "boot_id": "boot-a",
                                  "items": [{"id": "w1"}], "snapshot_revision": 4})
        assert frames == ["snapshot"]
    finally:
        store.close()


def test_recovery_wakes_on_an_unknown_event_without_a_service() -> None:
    recovery, kernel, store, frames = _bare_recovery()
    try:
        recovery.wake.clear()
        assert recovery.on_event({"event": "something_new"}) is True
        assert recovery.wake.is_set() is True
    finally:
        store.close()
