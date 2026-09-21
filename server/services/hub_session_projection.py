"""Phone-session projection: project every GA-Hub chat session onto the official hub.

Design baseline: ``docs/plans/phone-session-projection-plan-20260921.md`` §7
(route A).  The GA desktop app's phone client lists the peers connected to the
official hub bus (``ws://127.0.0.1:19736/ws``) and can read a peer's task flow,
send new instructions and abort.  GA-Hub's own sessions are invisible to it, so
this service projects each eligible chat session as one stable hub peer:

    peer name   ``gh-<session_id[:8]>`` (``GAHUB_HUB_PROJECTION_SUFFIX`` appends)
    read        archive tail window folded into the hub task-flow shape
    continue    ``coordinator.submit(text, session_id=..., source="hub")``
    abort       ``coordinator.abort_if_current(session_id=...)``
    state       ``peek_coordinator().runtime_state(sid).status != idle``
    title       session topic rides in ``state()['title']`` when set; the
                official ``_build`` spreads ``state()`` last so it overrides
                the derived last-input title (blank topic keeps that fallback)

Scope rules (validated against the live store in the Phase-0 smoke):

* ``kind in {None, "user"}`` by default; ``GAHUB_HUB_PROJECTION_INCLUDE_SYSTEM=1``
  widens it (the scheduled-tasks system session already has its own bridge).
* title-only archive rows (``is_archive_metadata_id``) are never projected.
* sessions without a bound, existing archive file are skipped.
* at most ``GAHUB_HUB_PROJECTION_MAX`` (default 50) sessions, newest first.

Lifecycle: one reconciler thread rescans the session store every
``RECONCILE_INTERVAL`` seconds and attaches/detaches one ``HubClient`` per
session (one-shot clients: a dead client is dropped and re-attached fresh).
Every hook is thin and never raises — a raising hook makes the hub close the
socket and the peer vanish from the phone; ``get_outputs`` therefore serves a
stat-guarded cache so the hub's ~15s ``ask`` budget is never spent on re-reads.

Layering: the coordinator accessors are injected by the composition root
(``server/main.py``) because ``tests/test_import_direction.py`` keeps
``services/`` from importing ``routes/`` — even function-locally.  The service
degrades gracefully when they are absent: reads still work, while put/abort
reply a ``nosupport`` error code and state reports idle.

Import order: this module must only be imported with GA_ROOT configured (the
archive reader imports the GA-side parser); ``server._paths`` bootstraps
``sys.path`` at its own import time, mirroring ``server/routes/sessions.py``.
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any, Callable

from .. import _paths as _ga_paths_bootstrap  # noqa: F401  (GA sys.path bootstrap)
from .archive_messages import read_archive_messages
from .session_coordinator import (
    AgentBusyError,
    SessionControlBusyError,
    SessionNotActiveError,
)
from .session_metadata import SessionMetadataStore, is_archive_metadata_id
from .session_runtime_status import STATUS_IDLE

log = logging.getLogger(__name__)

PEER_PREFIX = "gh-"
WINDOW_ITEMS = 40  # archive tail window presented as the task flow
RECONCILE_INTERVAL = 20.0  # seconds between session-store scans
SUBMIT_JOIN_TIMEOUT = 14.0  # hub `ask` gives up ~15s; answer ok early and keep running
DETACH_TIMEOUT = 3.0  # per-peer client.stop() cap during teardown

_service_lock = threading.Lock()
_service: "HubSessionProjectionService | None" = None


def fold_items(items: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Fold archive UI messages into the hub task-flow shape.

    Same fold as the approved Phase-0 smoke: a ``user`` message opens a task
    (``input``), ``assistant`` messages append to the open task's ``outputs``,
    and a window that starts mid-task keeps its assistant steps under an
    ``input == ""`` task (the hub title logic then falls back to real inputs
    on its own).
    """
    tasks: list[dict[str, Any]] = []
    for message in items or []:
        content = message.get("content") or ""
        if (message.get("role") or "") == "user":
            tasks.append({"input": content, "outputs": []})
        elif tasks:
            tasks[-1]["outputs"].append(content)
        else:
            tasks.append({"input": "", "outputs": [content]})
    return tasks


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip() == "1"


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name) or default))
    except (TypeError, ValueError):
        return default


def _error_payload(exc: BaseException) -> dict[str, Any]:
    """Map a hook failure to the hub's error reply shape (never raises)."""
    message = str(exc)[:300] or type(exc).__name__
    if isinstance(exc, (AgentBusyError, SessionControlBusyError)):
        return {"error": message, "code": "busy"}
    return {"error": message, "code": "nosupport"}


class _ProjectedSession:
    """One session's projection: stat-guarded fold cache + the four hook bodies."""

    def __init__(
        self,
        session_id: str,
        archive_path: str,
        *,
        get_coordinator: Callable[[], Any] | None = None,
        peek_coordinator: Callable[[], Any] | None = None,
        topic_for_archive: Callable[[str], str] | None = None,
    ) -> None:
        self.session_id = session_id
        self.archive_path = str(archive_path)
        self.client: Any = None
        self._get_coordinator = get_coordinator
        self._peek_coordinator = peek_coordinator
        self._topic_for_archive = topic_for_archive
        self._lock = threading.Lock()
        self._sig: tuple[int, int] | None = None
        self._tasks: list[dict[str, Any]] = []

    # ── read path ────────────────────────────────────────────────
    def get_outputs(self) -> list[dict[str, Any]]:
        """Serve the folded task flow.  Never raises; one read per change."""
        try:
            stat = os.stat(self.archive_path)
            sig = (stat.st_mtime_ns, stat.st_size)
        except OSError:
            with self._lock:
                return self._tasks
        with self._lock:
            if sig == self._sig:
                return self._tasks
        try:
            payload = read_archive_messages(self.archive_path, limit=WINDOW_ITEMS)
            tasks = fold_items(payload.get("items") or [])
        except Exception:
            log.debug(
                "archive fold failed for %s; serving last cache",
                self.session_id[:8],
                exc_info=True,
            )
            with self._lock:
                return self._tasks
        with self._lock:
            self._tasks, self._sig = tasks, sig
        return tasks

    # ── write path ───────────────────────────────────────────────
    def put_task(self, text: str) -> dict[str, Any]:
        """Admit a new instruction for this session (cold start included).

        The coordinator submit runs in a worker so a slow admission (runtime
        cold start) cannot block the hub's reader thread; beyond
        ``SUBMIT_JOIN_TIMEOUT`` we reply ok and let the run continue in the
        background, because the hub ``ask`` gives up around 15s.
        """
        text = str(text or "")
        if not text.strip():
            return {"ok": 1}
        lookup = self._get_coordinator
        if lookup is None:
            return {"error": "coordinator access is not wired", "code": "nosupport"}
        result: dict[str, Any] = {}

        def _work() -> None:
            try:
                lookup().submit(text, session_id=self.session_id, source="hub")
            except Exception as exc:  # mapped on the caller side
                result["error"] = exc

        worker = threading.Thread(
            target=_work, name=f"hub-put-{self.session_id[:8]}", daemon=True
        )
        worker.start()
        worker.join(SUBMIT_JOIN_TIMEOUT)
        if worker.is_alive():
            log.info(
                "put %s: admission still in flight after %.0fs; replying ok early",
                self.session_id[:8],
                SUBMIT_JOIN_TIMEOUT,
            )
            return {"ok": 1}
        exc = result.get("error")
        if exc is None:
            log.info("put %s: accepted by coordinator", self.session_id[:8])
            return {"ok": 1}
        log.debug("put %s: rejected: %s", self.session_id[:8], exc)
        return _error_payload(exc)

    def abort(self) -> dict[str, Any]:
        lookup = self._get_coordinator
        if lookup is None:
            return {"error": "coordinator access is not wired", "code": "nosupport"}
        try:
            lookup().abort_if_current(session_id=self.session_id)
            return {"ok": 1}
        except SessionNotActiveError:
            # Idempotent: nothing to abort, the phone asked to stop a quiet session.
            return {"ok": 1}
        except Exception as exc:
            log.debug("abort %s failed: %s", self.session_id[:8], exc)
            return _error_payload(exc)

    def state(self) -> dict[str, Any]:
        out: dict[str, Any] = {"run": False}
        peek = self._peek_coordinator
        if peek is not None:
            try:
                coordinator = peek()
                if coordinator is not None:
                    out["run"] = (
                        coordinator.runtime_state(self.session_id).status != STATUS_IDLE
                    )
            except Exception:
                log.debug("state probe failed for %s", self.session_id[:8], exc_info=True)
        topic = self._topic()
        if topic:
            # The official ``_build`` spreads ``state()`` last, so the session
            # topic overrides the derived last-input title on list and detail.
            out["title"] = topic
        return out

    def _topic(self) -> str:
        """Session topic from the metadata store ('' when unset; never raises)."""
        lookup = self._topic_for_archive
        if lookup is None:
            return ""
        try:
            return str(lookup(self.archive_path) or "").strip()
        except Exception:
            log.debug("topic lookup failed for %s", self.session_id[:8], exc_info=True)
            return ""


class HubSessionProjectionService:
    """Reconciler thread + one hub peer per eligible session."""

    def __init__(
        self,
        *,
        store: Any = None,
        client_factory: Callable[..., Any] | None = None,
        get_coordinator: Callable[[], Any] | None = None,
        peek_coordinator: Callable[[], Any] | None = None,
        reconcile_interval: float = RECONCILE_INTERVAL,
    ) -> None:
        self._store = store
        self._client_factory = client_factory
        self._get_coordinator = get_coordinator
        self._peek_coordinator = peek_coordinator
        self._interval = reconcile_interval
        self._stopping = threading.Event()
        self._thread: threading.Thread | None = None
        self._peers: dict[str, _ProjectedSession] = {}

    # ── lifecycle ────────────────────────────────────────────────
    def start(self) -> bool:
        """Start the reconciler; idempotent.  False = hub client unavailable."""
        if self._thread is not None and self._thread.is_alive():
            return True
        factory = self._client_factory or _resolve_hub_client()
        if factory is None:
            log.warning("hub session projection disabled: frontends.hub is not importable")
            return False
        self._client_factory = factory
        if self._get_coordinator is None or self._peek_coordinator is None:
            log.warning(
                "hub session projection: coordinator accessors absent; "
                "put/abort/state degrade to no-op replies"
            )
        self._stopping.clear()
        self._thread = threading.Thread(
            target=self._loop, name="hub-session-projection", daemon=True
        )
        self._thread.start()
        log.info("hub session projection started (reconcile every %.0fs)", self._interval)
        return True

    def stop(self) -> bool:
        """Stop the reconciler and detach every peer; idempotent."""
        self._stopping.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        for sid in list(self._peers):
            self._detach(sid)
        log.info("hub session projection stopped")
        return True

    def _loop(self) -> None:
        while not self._stopping.is_set():
            try:
                self._reconcile()
            except Exception:
                log.exception("hub session projection reconcile failed")
            self._stopping.wait(self._interval)

    # ── reconcile ────────────────────────────────────────────────
    def _reconcile(self) -> None:
        if self._stopping.is_set():
            return
        store = self._store
        if store is None:
            store = self._store = SessionMetadataStore()
        try:
            rows = store.list()
        except Exception:
            log.warning("session store read failed; keeping current peers", exc_info=True)
            return
        cap = _env_int("GAHUB_HUB_PROJECTION_MAX", 50)
        include_system = _env_flag("GAHUB_HUB_PROJECTION_INCLUDE_SYSTEM")
        wanted: dict[str, str] = {}
        for row in rows or []:
            if len(wanted) >= cap:
                break
            sid = str(row.get("id") or "")
            if not sid or is_archive_metadata_id(sid):
                continue
            if row.get("kind") not in (None, "user") and not include_system:
                continue
            archive_path = str(row.get("archive_path") or "")
            if not archive_path or not os.path.exists(archive_path):
                continue
            wanted[sid] = archive_path
        for sid in list(self._peers):
            if sid not in wanted:
                self._detach(sid)
        for sid, archive_path in wanted.items():
            if self._stopping.is_set():
                break
            peer = self._peers.get(sid)
            if peer is not None:
                if peer.client is not None and peer.client.is_alive():
                    peer.archive_path = archive_path
                    continue
                # One-shot clients cannot be revived (e.g. a build without
                # websockets): drop the corpse and attach a fresh instance.
                self._detach(sid)
            self._attach(sid, archive_path)

    def _topic_for_archive(self, archive_path: str) -> str:
        """Display title the UI shows for this archive ('' when unknown)."""
        store = self._store
        if store is None:
            return ""
        return store.title_for_archive(archive_path)

    def _attach(self, sid: str, archive_path: str) -> None:
        factory = self._client_factory
        if factory is None:
            return
        peer = _ProjectedSession(
            sid,
            archive_path,
            get_coordinator=self._get_coordinator,
            peek_coordinator=self._peek_coordinator,
            topic_for_archive=self._topic_for_archive,
        )
        peer.get_outputs()  # prewarm: the first hub poll should not pay the first read
        name = f"{PEER_PREFIX}{sid[:8]}{os.environ.get('GAHUB_HUB_PROJECTION_SUFFIX') or ''}"
        try:
            client = factory(
                name,
                put_task=peer.put_task,
                get_outputs=peer.get_outputs,
                abort=peer.abort,
                state=peer.state,
                fixed=True,
            )
            client.start()
        except Exception:
            log.warning("hub peer attach failed: %s", name, exc_info=True)
            return
        peer.client = client
        self._peers[sid] = peer
        log.info("hub peer attached: %s -> %s", name, archive_path)

    def _detach(self, sid: str) -> None:
        peer = self._peers.pop(sid, None)
        if peer is None:
            return
        client = peer.client
        if client is not None:
            try:
                client.stop(timeout=DETACH_TIMEOUT)
            except Exception:
                log.debug("hub peer stop failed: %s", sid[:8], exc_info=True)
        log.info("hub peer detached: %s%s", PEER_PREFIX, sid[:8])


def _resolve_hub_client() -> Any:
    """Resolve GA's ``HubClient`` via the registered GA bridge.

    ``frontends.gahub.bridge.official_hub`` owns the sanctioned reference to
    the official module (``tests/test_ga_boundary_contract.py`` forbids direct
    GA imports from ``server/``); its ``hub_client_class()`` never raises and
    returns ``None`` when the official module is unavailable.
    """
    try:
        from frontends.gahub.bridge.official_hub import hub_client_class
    except Exception:
        log.warning("GA bridge import failed; projection stays off", exc_info=True)
        return None
    return hub_client_class()


def start_hub_session_projection(
    *,
    get_coordinator: Callable[[], Any] | None = None,
    peek_coordinator: Callable[[], Any] | None = None,
) -> bool:
    """Start the process-wide projection service (idempotent).

    The coordinator accessors come from the composition root (``server/main.py``)
    — see the module docstring for the layering rule that forbids importing
    ``routes/`` from here.
    """
    global _service
    with _service_lock:
        if _service is not None:
            return True
        service = HubSessionProjectionService(
            get_coordinator=get_coordinator,
            peek_coordinator=peek_coordinator,
        )
        if not service.start():
            return False
        _service = service
        return True


def stop_hub_session_projection() -> bool:
    """Stop the service if running (idempotent; safe from any thread)."""
    global _service
    with _service_lock:
        service, _service = _service, None
    if service is None:
        return True
    return service.stop()
