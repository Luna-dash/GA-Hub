# Restore session-scoped fix checkpoint

> **状态标记（2026-09-18 复核）：⏹ 已过期。**
> 本文记录的中途状态（「`restore_conversation` 仍调用进程级 `AgentService.instance()`」）**已不成立** ——
> 该收敛已于 2026-09-15 提交 `46ffcb4`。终态见 `restore-session-scoped-fix-plan.md`。
> 已归档（2026-09-23 移入 `docs/archive/`）。

- Date: 2026-09-15
- Status: ~~implementation resumed after user authorization.~~ → **已过期（2026-09-18 复核）**
- Verified red test: `tests/test_conversations_search.py::test_restore_requires_target_session_id_in_request_body` reaches `conversations.restore_conversation`, but current route calls `archive_session_by_id(cid)` before validating the target session; the monkeypatched archive lookup raises `AssertionError`.
- Existing working-tree changes must be preserved: request model binding in `server/routes/conversations.py`/`server/schemas.py`, `SessionCoordinator.replace_runtime()` and its tests, `SessionRuntimeFactory` changes/tests, and existing audit document.
- Verified APIs: `SessionMetadataStore.get(session_id)` raises `SessionNotFoundError`; `sessions._get_coordinator()` lazily returns the shared coordinator built with `SessionRuntimeFactory(_store)`; `SessionRuntimeFactory.__call__(session_id, archive_override=...)` constructs/prepares a runtime and skips metadata bind/rotation when override is supplied; `SessionCoordinator.replace_runtime()` atomically swaps only through exclusive idle control and shuts down the previous runtime after detaching it.
- Intended next change: restore validates request.session_id, resolves archive `cid`, constructs the target session runtime with `archive_override=path`, installs it through the shared coordinator, and returns the archive response. Then add focused tests for successful wiring, busy 409, and archive/session isolation before regression tests.
- No tests or source changes were performed after this checkpoint yet.
