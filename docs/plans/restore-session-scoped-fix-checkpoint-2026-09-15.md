# Restore session-scoped fix checkpoint

- Date: 2026-09-15
- Status: implementation resumed after user authorization.
- Verified red test: `tests/test_conversations_search.py::test_restore_requires_target_session_id_in_request_body` reaches `conversations.restore_conversation`, but current route calls `archive_session_by_id(cid)` before validating the target session; the monkeypatched archive lookup raises `AssertionError`.
- Existing working-tree changes must be preserved: request model binding in `server/routes/conversations.py`/`server/schemas.py`, `SessionCoordinator.replace_runtime()` and its tests, `SessionRuntimeFactory` changes/tests, and existing audit document.
- Verified APIs: `SessionMetadataStore.get(session_id)` raises `SessionNotFoundError`; `sessions._get_coordinator()` lazily returns the shared coordinator built with `SessionRuntimeFactory(_store)`; `SessionRuntimeFactory.__call__(session_id, archive_override=...)` constructs/prepares a runtime and skips metadata bind/rotation when override is supplied; `SessionCoordinator.replace_runtime()` atomically swaps only through exclusive idle control and shuts down the previous runtime after detaching it.
- Intended next change: restore validates request.session_id, resolves archive `cid`, constructs the target session runtime with `archive_override=path`, installs it through the shared coordinator, and returns the archive response. Then add focused tests for successful wiring, busy 409, and archive/session isolation before regression tests.
- No tests or source changes were performed after this checkpoint yet.
