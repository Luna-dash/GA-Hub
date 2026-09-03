# Request usage attribution checkpoint

- Verified: `CoreConductor._run` consumes dict events, builds prompt, then calls `agent.put_task` on the conductor loop.
- Verified: `GenericAgent.run` consumes task dicts and has a `finally` block around each task; task metadata can carry `request_id`.
- Verified: `llmcore._record_usage` is the common usage recording point.
- Existing `server/services/request_usage.py` is an unconnected prototype; preserve unrelated token/UI work.
- Required implementation: propagate request_id from Hub chat event through Conductor task into the agent execution context; attribute direct usage events; mark request complete in task finally; expose read-only request usage data.
- Constraints: no secrets; no overwrite of unrelated files; validate with focused tests and runtime smoke checks.


## Additional verification — 2026-08-13
- GA-side real worker-thread smoke test passed for explicit request-ID attribution and ContextVar reset; prompt/model call arguments were unchanged.
- Slash-command cleanup smoke test passed with zero unfinished queue tasks and cleared request context.
- Hub focused lifecycle/wiring tests: **2 passed**; GA conductor tests: **14 passed**; both repositories compiled successfully.
- Residual: no live external LLM call; both worktrees contain uncommitted changes, including unrelated pre-existing token/UI edits.
