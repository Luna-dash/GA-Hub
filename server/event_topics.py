"""Hub-wide event-bus topic registry.

One home for every ``bus.publish`` topic so publishers cannot drift apart
silently ("chat:reset" was carried as an inline string in three separate
places). ``tests/test_event_topics.py`` statically scans ``server/`` and
fails on any publish-site topic literal that is not registered here, and on
registry entries nobody publishes (modeled on ``test_env_registry``).

Subscribe-side prefix filters (e.g. ``"chat:"``) and the frontend's own
topic lists are wire contracts, not registry members.
"""
from __future__ import annotations

# ── agent run lifecycle ─────────────────────────────────────────
AGENT_SUBMIT = "agent:submit"
AGENT_TURN = "agent:turn"
AGENT_DONE = "agent:done"
AGENT_TITLE = "agent:title"
AGENT_ABORT = "agent:abort"

# ── chat turn stream ────────────────────────────────────────────
CHAT_STARTED = "chat:started"
CHAT_HEARTBEAT = "chat:heartbeat"
CHAT_NEXT = "chat:next"
CHAT_DONE = "chat:done"
CHAT_ERROR = "chat:error"
CHAT_ABORTED = "chat:aborted"
CHAT_RESET = "chat:reset"
CHAT_RETRY = "chat:retry"
CHAT_RETRY_SCHEDULED = "chat:retry_scheduled"
CHAT_RETRY_EXHAUSTED = "chat:retry_exhausted"
CHAT_REWOUND = "chat:rewound"

# ── session runtime status ──────────────────────────────────────
SESSION_RUNTIME = "session:runtime"

# ── anti (agy) runtime status ───────────────────────────────────
ANTI_RUNTIME = "anti:runtime"

# ── feishu channel ──────────────────────────────────────────────
FEISHU_STARTED = "feishu:started"
FEISHU_STOPPED = "feishu:stopped"
FEISHU_CHAT = "feishu:chat"
FEISHU_CHECK = "feishu:check"
FEISHU_SEND = "feishu:send"
FEISHU_KEYS_SAVED = "feishu:keys_saved"

# ── scheduled task domain ───────────────────────────────────────
TASK_FIRED = "task:fired"
TASK_UPSERT = "task:upsert"
TASK_DELETE = "task:delete"
TASK_DONE = "task:done"
TASK_ERROR = "task:error"

# ── autonomous domain ───────────────────────────────────────────
AUTONOMOUS_FIRED = "autonomous:fired"
AUTONOMOUS_UPSERT = "autonomous:upsert"
AUTONOMOUS_DELETE = "autonomous:delete"
AUTONOMOUS_REPORT_SAVED = "autonomous:report_saved"

# ── conductor ───────────────────────────────────────────────────
CONDUCTOR_CHAT = "conductor:chat"
CONDUCTOR_CHAT_READ = "conductor:chat_read"
CONDUCTOR_SUBAGENTS = "conductor:subagents"
CONDUCTOR_LOG = "conductor:log"
CONDUCTOR_REQUEST_OUTCOME = "conductor:request_outcome"
CONDUCTOR_REQUEST_YIELD_REQUESTED = "conductor:request_yield_requested"
# The store's post-commit publish can fail (a listener raised, the bus is
# gone); the recovery loop then owns a resync and tells the page the board it
# is showing may be stale. Was published as an inline literal until the
# publish-site scan learned to see through ``self.kernel.publish``.
CONDUCTOR_RESYNC_REQUIRED = "conductor:resync_required"
# Terminal workflow transitions are built as (topic, payload) tuples inside
# the WorkflowTracker and published later via publish_workflow_transition —
# they must be constants, not inline strings, or the publish-site scan
# cannot see who owns them.
CONDUCTOR_WORKFLOW_COMPLETED = "conductor:workflow_completed"
CONDUCTOR_WORKFLOW_FAILED = "conductor:workflow_failed"
CONDUCTOR_WORKFLOW_REOPENED = "conductor:workflow_reopened"
CONDUCTOR_WORKER_FAILED = "conductor:worker_failed"

# ── dynamic sub-topic families ──────────────────────────────────
# Published as f-strings whose suffix is named at publish time (engine worker
# events, engine event types). The family prefix is the registered contract;
# the scan test accepts any f-string topic under one of these prefixes.
DYNAMIC_FAMILIES = (
    "conductor:",
)
