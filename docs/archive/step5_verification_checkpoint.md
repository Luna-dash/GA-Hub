# Step 5 verification checkpoint — 2026-08-04

- Frontend hydration/reconnect/cursor chain implemented; `webui/npm run build` passes.
- Backend resumable WS uses `EventBus.subscribe_after`, emits `snapshot`/replay frames plus `replay_done` with `event_id` and `epoch`.
- Event frames now include `event_id` and `epoch`.
- Resumable subscribers are tracked by queue; overflow clears queued events, marks `live_resync_reason= subscriber_overflow`, inserts a None sentinel, and WS sends `resync_required` then closes 1013.
- Targeted `tests/test_event_bus.py tests/test_sessions_api.py`: 18 passed.
- Full backend before test updates: 99 passed, 3 old websocket assertions failed due to new protocol fields/order.
- Updated strict frame and snapshot/ping test assertions; remaining websocket failure is test-side: it must consume `replay_done` after snapshot before publishing/receiving live events.
- Next: patch that test, run websocket tests, add/verify overflow test, then full pytest + frontend build and inspect diff.
