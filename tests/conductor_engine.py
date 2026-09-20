"""Shared in-memory engine transport for command-track conductor tests.

The Engine stands in for the gahub_app HTTP surface: it journals events,
records posted operations once (receipt-style), and serves the recovery
protocol so ConductorRecovery can sync without a real engine process.
"""
from __future__ import annotations

import copy

from server.services.conductor_client import GahubProcessError


class Engine:
    def __init__(self):
        self.boot = "boot-a"
        self.epoch = "journal-a"
        self.started = True
        self.events = []
        self.items = []
        self.receipts = {}
        self.posts = []
        self.fail_response = False
        self.revision = 1
        # Optional seam invoked at the start of a dispatch POST: lets a test
        # mutate hub state "while the engine call is in flight".
        self.dispatch_hook = None

    def event(self, kind, **payload):
        self.events.append({"seq": len(self.events) + 1, "type": kind,
                            "payload": {"event": kind, "boot_id": self.boot, **payload}})

    def recovery(self):
        return {"protocol_version": 2, "boot_id": self.boot,
                "capabilities": ["snapshot_revision", "path_policy", "request_recovery",
                                 "guarded_actions", "operation_receipts", "sse_resync",
                                 "unified_admission"],
                "path_policy": {"mode": "explicit_absolute"}, "requests": []}

    def get_subagents(self):
        return {"boot_id": self.boot, "snapshot_revision": self.revision, "items": self.items}

    def get_subagent(self, sid):
        return {"id": sid, "boot_id": self.boot, "active_generation": 1,
                "command_revision": 3, "review_status": "pending"}

    def journal(self, after_seq=0, limit=500):
        return {"journal": {"epoch": self.epoch, "last_seq": len(self.events)},
                "events": copy.deepcopy(self.events[after_seq:after_seq + limit])}

    def status(self):
        return {"started": self.started}

    def push_models(self, **kwargs):
        return {}

    def subagent_action(self, **kwargs):
        return self._post(kwargs, {"id": kwargs["sid"], "status": "stopped",
                                  "active_generation": 1})

    def start_subagent(self, **kwargs):
        if self.dispatch_hook:
            self.dispatch_hook()
        return self._post(kwargs, {"id": "worker", "active_generation": 1})

    def post_chat(self, msg, role, request_id, **kwargs):
        # The engine echoes the stored chat item, including the final flag —
        # the hub's record_final path keys off it.
        return self._post({**kwargs, "msg": msg, "role": role, "request_id": request_id},
                          {"id": "chat-1", "msg": msg, "role": role, "request_id": request_id,
                           "ts": 1000, "final": bool(kwargs.get("final"))})

    def _post(self, kwargs, result):
        operation = kwargs["operation_id"]
        if operation not in self.receipts:
            self.posts.append(copy.deepcopy(kwargs))
            self.receipts[operation] = copy.deepcopy(result)
        if self.fail_response:
            self.fail_response = False
            raise GahubProcessError("lost response")
        return copy.deepcopy(self.receipts[operation])

    def operation(self, operation_id, scope):
        return {"boot_id": self.boot, "known": operation_id in self.receipts,
                "status_code": 200, "result": copy.deepcopy(self.receipts.get(operation_id))}
