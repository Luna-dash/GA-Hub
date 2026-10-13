"""Run-level recovery: ordered physical segments and ownership isolation."""
from server.services.agent_service import AgentService, _CONTINUATION_PROMPT
from server.services.chat_stream_projection import ChatSnapshot
from server.services.session_coordinator import SessionCoordinator, RuntimeState


def _runtime():
    service = AgentService.for_tests()
    # Intentionally insert out of order: recovery orders by server start time.
    for snapshot in [
        ChatSnapshot('b', 'auto_continue', _CONTINUATION_PROMPT, 2,
                     content='SECOND', logical_id='a', session_id='s', run_id='r'),
        ChatSnapshot('foreign', 'webui', 'secret', 3,
                     content='FOREIGN', session_id='other', run_id='r'),
        ChatSnapshot('previous', 'webui', 'old', 0,
                     content='OLD', session_id='s', run_id='old'),
        ChatSnapshot('a', 'webui', 'q', 1, content='FIRST', done=True,
                     logical_id='a', session_id='s', run_id='r'),
    ]:
        service._snapshots.add(snapshot)
    return service


def test_run_snapshot_orders_all_retained_segments_and_is_detached():
    service = _runtime()
    snapshot = service.run_message_snapshot(session_id='s', run_id='r')
    assert [part['stream_id'] for part in snapshot['streams']] == ['a', 'b']
    assert [part['content'] for part in snapshot['streams']] == ['FIRST', 'SECOND']
    assert snapshot['stream_id'] == 'b'
    assert snapshot['done'] is False
    snapshot['streams'][0]['content'] = 'CLIENT MUTATION'
    assert service._snapshots.get('a').content == 'FIRST'
    assert service.run_message_snapshot(session_id='missing', run_id='r') is None


def test_coordinator_uses_run_snapshot_not_initial_stream():
    service = _runtime()
    coordinator = SessionCoordinator(lambda sid: None)
    state = RuntimeState('s', 'running', 'r', 'a')
    coordinator._states['s'] = state
    coordinator._active_by_session['s'] = state
    coordinator._runtimes['s'] = service
    recovered_state, snapshot = coordinator.session_snapshot('s')
    assert recovered_state.stream_id == 'a'
    assert snapshot['stream_id'] == 'b'
    assert len(snapshot['streams']) == 2


def test_coordinator_drops_snapshot_when_run_changes_during_copy():
    coordinator = SessionCoordinator(lambda sid: None)
    state = RuntimeState('s', 'running', 'r', 'a')
    coordinator._states['s'] = state
    coordinator._active_by_session['s'] = state

    class FinishingRuntime:
        def run_message_snapshot(self, **kwargs):
            coordinator._active_by_session.pop('s')
            coordinator._states['s'] = RuntimeState(
                's', completed_run_id='r', outcome='completed')
            return {'content': 'STALE', 'streams': []}

    coordinator._runtimes['s'] = FinishingRuntime()
    recovered_state, snapshot = coordinator.session_snapshot('s')
    assert recovered_state.completed_run_id == 'r'
    assert snapshot is None
