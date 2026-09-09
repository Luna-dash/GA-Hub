"""Persisted command preparation, guarded delivery, receipts and retry policy."""
from __future__ import annotations

import copy
import logging
import threading
import uuid

from .conductor_client import GahubProcessError
from .conductor_store import OperationConflict, command_fingerprint

log = logging.getLogger(__name__)
MODEL_KEYS = ("conductor_llm_index", "subagent_llm_index", "subagent_model_policy")


class ConductorCommands:
    def __init__(self, service, store, recovery):
        self.service = service
        self.store = store
        self.recovery = recovery
        self._inflight_lock = threading.Lock()
        self._idle = threading.Condition(self._inflight_lock)
        self._inflight: set[str] = set()

    def enqueue_auto_accept(self, sid: str, rid: str, generation: int) -> None:
        operation_id = "autoaccept-" + command_fingerprint({"engine": self.store.engine_key,
                        "sid": sid, "generation": generation, "boot": self.recovery.boot_id})[:48]
        if self.store.command(operation_id) is None:
            intent = {"kind": "action", "sid": sid, "action": "accept", "msg": "自动验收：机器检查全部通过。",
                      "request_id": rid, "force": False}
            self.store.put_command(operation_id, {"intent": intent, "auto": True,
                                   "boot_id": self.recovery.boot_id, "expected_generation": generation})

    def submit(self, operation_id: str | None, intent: dict) -> dict:
        self.service._assert_open()
        operation_id = operation_id or uuid.uuid4().hex
        with self.store.transaction():
            existing = self.store.command(operation_id)
            if existing is not None:
                if existing["payload"]["intent"] != intent:
                    raise OperationConflict("operation_id was used with different arguments")
            else:
                payload = {"intent": copy.deepcopy(intent), "boot_id": None}
                if intent["kind"] == "chat" and intent.get("role") == "user":
                    hint = intent.get("request_id")
                    payload["request_id"] = (hint if hint and self.service.workflow_tracker.is_open(hint)
                                             else uuid.uuid4().hex)
                    self.service.workflow_tracker.admit(payload["request_id"], admission_state="submitting")
                self.store.put_command(operation_id, payload)
        return self.execute_command(operation_id, start_allowed=True)

    def execute_command(self, operation_id: str, *, start_allowed: bool = False) -> dict:
        with self._inflight_lock:
            self.service._assert_open()
            if operation_id in self._inflight:
                raise GahubProcessError("operation is in progress", status_code=409,
                    detail={"error": "operation_in_progress", "operation_id": operation_id})
            self._inflight.add(operation_id)
        try:
            command = self.store.command(operation_id)
            if command["state"] == "succeeded":
                return command["result"]
            if command["state"] == "rejected":
                result = command["result"] or {}
                raise GahubProcessError("operation was rejected", status_code=result.get("status_code") or 409,
                                       detail=result.get("detail", result))
            payload = command["payload"]
            intent = payload["intent"]
            if payload.get("suspended"):
                raise GahubProcessError("operation suspended by manual stop", status_code=409,
                    detail={"error": "operation_unknown", "operation_id": operation_id})
            if (start_allowed and intent["kind"] == "chat" and intent.get("role") == "user"
                    and command["state"] == "pending"):
                # Model validation is a deterministic rejection: record it on
                # the command before surfacing 422. Leaving the command
                # pending would let a later drain_commands() deliver a
                # message the caller was already told was refused.
                try:
                    self.service.configure_models(llm_index=intent.get("llm_index"),
                        subagent_llm_index=intent.get("subagent_llm_index"),
                        subagent_model_policy=intent.get("subagent_model_policy"))
                except ValueError as exc:
                    failure = GahubProcessError(str(exc), status_code=422)
                    self._record_rejection(operation_id, failure)
                    raise failure from exc
                # ensure_started failures stay transient: the engine may be
                # cold-starting, and the command loop retries pending
                # commands once recovery is ready.
                self.service.ensure_started(exclude_request_id=payload.get("request_id"))
            if not self.recovery.ready:
                self.recovery.sync()
            if not self.recovery.ready or self.recovery.stop_event.is_set():
                raise GahubProcessError("Conductor recovery is not ready", status_code=503,
                                       detail={"error": "recovery_pending", "operation_id": operation_id})
            if payload.get("boot_id") and payload["boot_id"] != self.recovery.boot_id:
                self.store.finish_command(operation_id, "unknown", {"error": "engine_boot_changed"})
                raise GahubProcessError("engine changed; operation outcome requires reconciliation",
                                       status_code=409, detail={"error": "operation_unknown", "operation_id": operation_id})
            payload["boot_id"] = self.recovery.boot_id
            if "prepared" not in payload:
                from .conductor_service import ConductorNotRunning
                try:
                    self._prepare(payload)
                except GahubProcessError as exc:
                    self._record_rejection(operation_id, exc)
                    raise
                except (ValueError, ConductorNotRunning) as exc:
                    failure = GahubProcessError(str(exc), status_code=422 if isinstance(exc, ValueError) else 409)
                    self._record_rejection(operation_id, failure)
                    raise failure from exc
                self.store.prepare_command(operation_id, payload)
            self.store.finish_command(operation_id, "sending")
            receipt_known = False
            try:
                receipt = None
                if command["state"] in ("sending", "unknown"):
                    scope = "worker_action" if intent["kind"] == "action" else intent["kind"]
                    receipt = self.service.client.operation(operation_id, scope)
                    if receipt.get("boot_id") != payload["boot_id"]:
                        raise GahubProcessError("engine changed", status_code=409,
                                               detail={"error": "engine_boot_changed"})
                if receipt and receipt.get("known"):
                    receipt_known = True
                    result = receipt["result"]
                    if receipt["status_code"] >= 400:
                        raise GahubProcessError("engine operation rejected", status_code=receipt["status_code"], detail=result)
                else:
                    result = self._send(operation_id, payload)
            except GahubProcessError as exc:
                detail = exc.detail if isinstance(exc.detail, dict) else {"message": exc.detail or str(exc)}
                uncertain = (exc.status_code is None or (exc.status_code >= 500 and not receipt_known) or detail.get("enqueued")
                             or detail.get("error") == "engine_boot_changed")
                self.store.finish_command(operation_id, "unknown" if uncertain else "rejected",
                                          {"status_code": exc.status_code, "detail": exc.detail})
                if detail.get("error") == "engine_boot_changed":
                    self.recovery.reconnect()
                exc.detail = {**detail, "operation_id": operation_id,
                              "operation_state": "unknown" if uncertain else "rejected"}
                raise
            except Exception:
                self.store.finish_command(operation_id, "unknown")
                raise
            result = {**result, "operation_id": operation_id}
            with self.store.transaction():
                tracker = self.service.workflow_tracker
                rid = payload.get("request_id")
                sid = intent.get("sid") or result.get("id")
                if intent["kind"] == "chat":
                    if intent.get("role") == "user" and rid:
                        tracker.confirm_admission(rid, payload["boot_id"])
                    self.service._on_remote_chat(result, from_hello=True)
                else:
                    result.setdefault("request_id", rid)
                    if rid and tracker.has_request(rid):
                        if intent.get("action") == "accept":
                            _, transition = tracker.record_subagent_event(sid, "accepted", request_id=rid,
                                                        generation=result.get("active_generation"))
                            if transition:
                                self.service._publish_workflow_transition(transition)
                        elif tracker.is_open(rid) and intent.get("action") in (None, "input", "rework"):
                            tracker.confirm_admission(rid, payload["boot_id"])
                            tracker.bind_subagent(rid, sid, int(result.get("active_generation") or 0))
                    if intent.get("action") in (None, "input", "rework"):
                        result.setdefault("llm_index", payload["prepared"].get("llm_index"))
                        result["model_policy"] = payload.get("model_policy")
                        from .conductor_service import INSTR_DISPATCHED
                        result["instruction"] = INSTR_DISPATCHED
                    elif intent.get("action") == "keyinfo":
                        from .conductor_service import INSTR_KEYINFO
                        result["instruction"] = INSTR_KEYINFO
                self.store.finish_command(operation_id, "succeeded", result)
            self.recovery.wake.set()
            return result
        finally:
            with self._inflight_lock:
                self._inflight.discard(operation_id)
                self._idle.notify_all()

    def wait_idle(self, timeout: float) -> bool:
        with self._idle:
            return self._idle.wait_for(lambda: not self._inflight, timeout=timeout)

    def _record_rejection(self, operation_id: str, exc: GahubProcessError) -> None:
        detail = exc.detail if isinstance(exc.detail, dict) else {"message": exc.detail or str(exc)}
        if exc.status_code in (400, 404, 409, 422) and detail.get("error") != "operation_in_progress":
            self.store.finish_command(operation_id, "rejected", {"status_code": exc.status_code, "detail": detail})
        exc.detail = {**detail, "operation_id": operation_id}

    def _prepare(self, payload: dict) -> None:
        intent = dict(payload["intent"])
        kind = intent.pop("kind")
        tracker = self.service.workflow_tracker
        rid = payload.get("request_id") or intent.get("request_id")
        if kind == "action":
            rid = rid or tracker.request_for_subagent(intent["sid"])
            state = self.service.client.get_subagent(intent["sid"])
            if state.get("boot_id") != self.recovery.boot_id:
                self.recovery.reconnect()
                raise GahubProcessError("engine changed during action preparation", status_code=409)
            generation = state.get("active_generation", 0)
            for key, actual in (("expected_boot_id", state.get("boot_id")),
                                ("expected_generation", generation),
                                ("expected_command_revision", state.get("command_revision", 0))):
                expected = intent.pop(key, None)
                if expected is not None and expected != actual:
                    raise GahubProcessError("worker changed since it was displayed", status_code=409,
                                           detail={"error": "worker_version_conflict", "field": key})
            if payload.get("expected_generation", generation) != generation:
                raise GahubProcessError("worker generation changed", status_code=409,
                                       detail={"error": "worker_version_conflict"})
            if payload.get("auto") and (state.get("review_status") != "pending"
                    or state.get("deliverables_missing") or state.get("deliverables_stale")):
                raise GahubProcessError("worker no longer eligible for automatic acceptance", status_code=409,
                                       detail={"error": "auto_accept_ineligible"})
            payload.update(expected_generation=generation,
                           expected_command_revision=state.get("command_revision", 0))
        if kind == "dispatch" or intent.get("action") in ("input", "rework"):
            _, models, selected = self.service._admit_action_models(intent.get("llm_index"), rid,
                intent.get("conductor_llm_index"), intent.get("subagent_llm_index"), intent.get("subagent_model_policy"))
            intent["llm_index"] = selected
            payload["model_policy"] = models["subagent_model_policy"]
        elif kind == "chat" and intent.get("final"):
            tracker.assert_ready_for_final(rid)
        elif kind == "chat" and intent.get("role") == "user":
            self.service._assert_engine_ready()
        payload["request_id"] = rid
        intent["request_id"] = rid
        for key in MODEL_KEYS:
            intent.pop(key, None)
        payload["prepared"] = intent

    def _send(self, operation_id: str, payload: dict) -> dict:
        intent = dict(payload["prepared"])
        kind = payload["intent"]["kind"]
        if kind == "action":
            return self.service.client.subagent_action(**intent, operation_id=operation_id,
                expected_boot_id=payload["boot_id"], expected_generation=payload["expected_generation"],
                expected_command_revision=payload["expected_command_revision"])
        if kind == "chat":
            return self.service.client.post_chat(intent["msg"], intent.get("role", "user"),
                intent.get("request_id"), final=bool(intent.get("final")),
                operation_id=operation_id, expected_boot_id=payload["boot_id"])
        if kind == "dispatch":
            return self.service.client.start_subagent(**intent, operation_id=operation_id,
                                                      expected_boot_id=payload["boot_id"])
        raise ValueError(f"unknown command kind: {kind}")

    def drain_commands(self) -> None:
        for command in self.store.pending_commands():
            if self.recovery.stop_event.is_set() or not self.recovery.ready:
                break
            if command["payload"].get("auto") and not self.service.auto_accept:
                continue
            if command["payload"].get("suspended"):
                continue
            if command["payload"].get("boot_id") not in (None, self.recovery.boot_id):
                continue
            try:
                self.execute_command(command["operation_id"])
            except GahubProcessError as exc:
                if (command["state"] == "pending" and exc.status_code in (400, 404, 409, 422)
                        and not (isinstance(exc.detail, dict) and exc.detail.get("error") == "operation_in_progress")):
                    self._record_rejection(command["operation_id"], exc)
            except Exception:
                log.debug("Conductor command remains pending or requires review", exc_info=True)

    def suspend_commands(self) -> None:
        with self.store.transaction():
            for command in self.store.pending_commands():
                payload = command["payload"]
                payload["suspended"] = True
                self.store.prepare_command(command["operation_id"], payload)
                self.store.finish_command(command["operation_id"], "unknown", {"error": "manual_stop"})
