"""Fingerprint sampling must be isolated and never upload model credentials/history."""
import asyncio
import copy
import json
import sys
from types import SimpleNamespace

import pytest
from server.services import model_fingerprint as m


def test_sample_isolated_and_numeric_only(monkeypatch):
    seen = {}
    original = {'api_key': 'private-secret', 'model': 'chosen', 'extra_sys_prompt': 'private context'}
    before = copy.deepcopy(original)
    backend = SimpleNamespace(history=['private history'], tools={'private': True}, system='private')
    def raw(messages):
        seen['messages'] = messages
        yield 'stream'
        return [{'type': 'text', 'text': 'Private explanation 9999.\n1 22 355 0 356 44'}]
    backend.raw_ask = raw
    def resolve(key, config):
        seen['config'] = config
        return backend
    monkeypatch.setitem(sys.modules, 'llmcore', SimpleNamespace(resolve_session=resolve))
    assert m.sample('test_oai', original, 'public challenge') == '1 22 355 44'
    assert original == before
    assert backend.history == [] and backend.tools is None and backend.system == ''
    assert seen['config']['max_retries'] == 0
    assert seen['messages'] == [{'role': 'user', 'content': [{'type': 'text', 'text': 'public challenge'}]}]


def test_active_conversation_limit_is_safe_and_specific(monkeypatch):
    def raw(messages):
        yield ''
        return [{'type': 'text', 'text': '!!!Error: HTTP 422 active_main_conversation_limit_exceeded private-secret'}]
    monkeypatch.setitem(sys.modules, 'llmcore', SimpleNamespace(resolve_session=lambda *args: SimpleNamespace(raw_ask=raw)))
    with pytest.raises(m.SamplingUnavailable, match='活跃会话') as error:
        m.sample('test_oai', {}, 'challenge')
    assert 'private-secret' not in str(error.value)


def test_snapshot_removes_context(monkeypatch):
    config = {'api_key': 'secret', 'model': 'chosen', 'extra_sys_prompt': 'private', 'extra_sys_prompt_file': 'private-path'}
    monkeypatch.setitem(sys.modules, 'llmcore', SimpleNamespace(reload_mykeys=lambda: ({'test_oai': config},)))
    isolated, target = m.model_snapshot('test_oai')
    assert isolated == {'api_key': 'secret', 'model': 'chosen'}
    assert 'secret' not in json.dumps(target)
    assert 'extra_sys_prompt' in config


def test_job_is_bounded_private_and_no_retry(monkeypatch):
    async def run():
        monkeypatch.setattr(m, 'scoring_settings', lambda: ('https://score.test', 'score-token'))
        monkeypatch.setattr(m, 'model_snapshot', lambda key: ({'api_key': 'private-secret'}, {'model': 'chosen'}))
        calls = []
        def request(method, url, **kw):
            calls.append((method, url, kw))
            data = {'challenges': [{'prompt': 'public', 'expected_count': 300}] * 3} if method == 'GET' else {'analysis': {'results': []}}
            return SimpleNamespace(raise_for_status=lambda: None, json=lambda: data)
        monkeypatch.setattr(m.requests, 'request', request)
        monkeypatch.setattr(m, 'sample', lambda *args: '1 2 3')
        service = m.FingerprintService()
        initial = service.start('session-a', 'test_oai')
        with pytest.raises(ValueError, match='fingerprint_busy'):
            service.start('session-b', 'test_oai')
        await asyncio.gather(*service.tasks)
        job = service.jobs[initial['id']]
        assert job['status'] == 'completed' and job['completed_samples'] == 3
        assert len(calls) == 2
        assert calls[1][2]['json'] == {'outputs': [{'text': '1 2 3', 'expected_count': 300}] * 3}
        assert calls[1][2]['allow_redirects'] is False
        assert 'private-secret' not in json.dumps(job)
        assert 'score-token' not in json.dumps(job)
        monkeypatch.setattr(m, 'sample', lambda *args: (_ for _ in ()).throw(RuntimeError('private-secret')))
        initial = service.start('session-a', 'test_oai')
        await asyncio.gather(*service.tasks)
        failed = service.jobs[initial['id']]
        assert failed['status'] == 'failed' and failed['completed_samples'] == 0
        assert 'private-secret' not in json.dumps(failed)
        assert len(calls) == 3
        monkeypatch.setattr(m, 'sample', lambda *args: (_ for _ in ()).throw(m.SamplingUnavailable('private-secret')))
        initial = service.start('session-a', 'test_oai')
        await asyncio.gather(*service.tasks)
        limited = service.jobs[initial['id']]
        assert limited['status'] == 'failed' and limited['completed_samples'] == 0
        assert '活跃会话' in limited['error']
        assert 'private-secret' not in json.dumps(limited)
        assert len(calls) == 4  # one challenge request; no retry or scoring
    asyncio.run(run())


def test_scoring_requires_https_and_secret(monkeypatch, tmp_path):
    monkeypatch.setenv('GA_FINGERPRINT_URL', 'http://unsafe.test')
    with pytest.raises(ValueError, match='scoring_https_required'):
        m.scoring_settings()
    monkeypatch.setenv('GA_FINGERPRINT_URL', 'https://score.test')
    monkeypatch.delenv('GA_FINGERPRINT_TOKEN', raising=False)
    monkeypatch.setenv('GA_FINGERPRINT_TOKEN_FILE', str(tmp_path / 'missing'))
    with pytest.raises(ValueError, match='scoring_not_configured'):
        m.scoring_settings()
