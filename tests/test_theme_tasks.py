"""Theme task metadata and run-metrics regression tests (isolated persistence)."""
from fastapi import FastAPI
from fastapi.testclient import TestClient
from server.routes import sessions
from server.error_mapping import install_error_handlers
from server.services.session_lifecycle import SessionLifecycle
from server.services.session_metadata import SessionMetadataStore
from server.services import theme_task_runs as metrics


def test_convert_persist_restore(tmp_path):
    store = SessionMetadataStore(tmp_path)
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(sessions.router)
    app.state.session_lifecycle = SessionLifecycle(store=store)
    with TestClient(app) as c:
        sid = c.post('/api/sessions', json={'title': 'daily check'}).json()['id']
        config = {'instruction': 'Report only; make no changes', 'description': 'check'}
        r = c.patch(f'/api/sessions/{sid}', json={'theme_task': config})
        assert r.status_code == 200
        assert SessionMetadataStore(tmp_path).get(sid)['theme_task'] == config
        # A theme task MUST NOT silently inherit a global/default model.
        app.state.session_lifecycle._runtime_llm_key = 'default-model'
        r = c.post(f'/api/sessions/{sid}/theme-run', json={'text': config['instruction']})
        assert r.status_code == 409
        assert 'llm_unconfirmed' in r.text
        assert c.get(f'/api/sessions/{sid}/theme-run').status_code == 200
        assert c.patch(f'/api/sessions/{sid}', json={'theme_task': None}).status_code == 200
        assert SessionMetadataStore(tmp_path).get(sid)['theme_task'] is None
        assert c.post(f'/api/sessions/{sid}/theme-run', json={'text': 'test'}).status_code == 409


def test_metrics_deduplicate_and_freeze(tmp_path, monkeypatch):
    monkeypatch.setattr(metrics._paths, 'ADMIN_DATA', tmp_path)
    metrics.begin('s', 'r', 'assignment')
    metrics.turn('s', 'r', 'stream', 1)
    metrics.turn('s', 'r', 'stream', 1)
    metrics.turn('s', 'r', 'stream', 2)
    metrics.model_snapshot('s', 'r', 'actual/model')
    metrics.finish('s', 'r', 'completed', 'verified report')
    row = metrics.get('s')
    assert row['turns'] == 2
    assert row['finished_at'] >= row['started_at']
    assert row['report'] == 'verified report'
    assert row['model_name'] == 'actual/model'
    assert 'turn_ids' not in row
    metrics.finish('s', 'old-run', 'failed', 'wrong')
    assert metrics.get('s')['report'] == 'verified report'
    metrics.begin('s', 'r2', 'assignment')
    assert metrics.get('s')['interrupted'] is True
    assert metrics.get('s', 'r2')['outcome'] is None


def test_metrics_io_failure_never_breaks_chat(monkeypatch):
    def fail(*args):
        raise OSError('disk unavailable')
    monkeypatch.setattr(metrics, '_write', fail)
    assert metrics.begin('s', 'r', 'm') is None


def test_untracked_callbacks_never_read_or_write_metrics(monkeypatch):
    def fail(*args):
        raise AssertionError('ordinary sessions must not touch theme storage')
    monkeypatch.setattr(metrics, '_read', fail)
    monkeypatch.setattr(metrics, '_write', fail)
    metrics.turn('ordinary', 'r', 'stream', 1)
    metrics.model_snapshot('ordinary', 'r', 'model')
    metrics.finish('ordinary', 'r', 'completed', 'reply')


def test_discard_blocks_late_callbacks_and_removes_report(tmp_path, monkeypatch):
    monkeypatch.setattr(metrics._paths, 'ADMIN_DATA', tmp_path)
    metrics.begin('s', 'r', 'model')
    metrics.discard('s')
    metrics.turn('s', 'r', 'stream', 1)
    metrics.finish('s', 'r', 'completed', 'late reply')
    assert metrics.get('s') is None


def test_new_run_ignores_old_callbacks(tmp_path, monkeypatch):
    monkeypatch.setattr(metrics._paths, 'ADMIN_DATA', tmp_path)
    metrics.begin('s', 'old', 'model')
    metrics.begin('s', 'new', 'model')
    metrics.turn('s', 'old', 'stream', 1)
    metrics.finish('s', 'old', 'failed', 'old reply')
    assert metrics.get('s', 'new')['run_id'] == 'new'
    assert metrics.get('s', 'new')['turns'] == 0
    assert metrics.get('s', 'new')['report'] == ''
