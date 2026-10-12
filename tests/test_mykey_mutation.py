"""Structured edits share one transaction; all fixtures are synthetic configs."""
import asyncio
from unittest import mock

import pytest
from fastapi import HTTPException

from server.routes import mykey
from server.schemas import MyKeyMutationReq
from server.services import mykey_service as svc

RAW = "# synthetic config\nproxy = (\n    'http://old'\n)\noai_config_a = {'name': 'A', 'apikey': 'fixture', 'model': 'old'}\noai_config_z = {'name': 'Z'}\n"


@pytest.fixture
def transaction(tmp_path):
    path = tmp_path / 'synthetic.py'
    path.write_text(RAW, encoding='utf-8')
    with (
        mock.patch.object(svc, '_mykey_path', return_value=path),
        mock.patch.object(svc, '_backup_current', return_value='fixture-backup') as backup,
        mock.patch.object(svc, '_trigger_reload', return_value=(2, [])) as reload,
    ):
        yield path, backup, reload


def test_rename_and_duplicate_are_ordered_atomic_transactions(transaction):
    path, backup, reload = transaction
    result = svc.mutate_mykey('rename', 'oai_config_a', 'oai_config_b', {'name': 'A', 'apikey': ''}, 'oai')
    assert result['ok'] and result['backup'] == 'fixture-backup'
    assert [s['var'] for s in result['structured']['sessions']] == ['oai_config_b', 'oai_config_z']
    assert 'oai_config_a =' not in path.read_text(encoding='utf-8')
    result = svc.mutate_mykey('duplicate', 'oai_config_b', 'oai_config_b_copy', {'name': 'copy', 'apikey': ''}, 'oai')
    assert [s['var'] for s in result['structured']['sessions']] == ['oai_config_b', 'oai_config_b_copy', 'oai_config_z']
    assert result['structured']['sessions'][1]['fields']['apikey'] == 'fixture'
    assert backup.call_count == reload.call_count == 2
    assert 'WebUI' not in path.read_text(encoding='utf-8')


@pytest.mark.parametrize('action,var,new_var,kind,status', [
    ('create', 'oai_config_a', None, 'oai', 409),
    ('update', 'oai_config_missing', None, 'oai', 404),
    ('duplicate', 'oai_config_a', 'oai_config_z', 'oai', 409),
    ('rename', 'oai_config_a', 'oai_config_z', 'oai', 409),
    ('rename', 'oai_config_missing', 'oai_config_new', 'oai', 404),
    ('create', 'ordinary_global', None, 'oai', 400),
    ('create', 'oai_config_new', None, 'claude', 400),
    ('create', 'class', None, 'oai', 400),
])
def test_rejected_edits_never_backup_write_or_reload(transaction, action, var, new_var, kind, status):
    path, backup, reload = transaction
    with pytest.raises(svc.MykeyHttpError) as error:
        svc.mutate_mykey(action, var, new_var, {'name': 'test'}, kind)
    assert error.value.status_code == status
    assert path.read_text(encoding='utf-8') == RAW
    backup.assert_not_called()
    reload.assert_not_called()


def test_proxy_updates_complete_multiline_statement(transaction):
    path, backup, reload = transaction
    result = svc.mutate_mykey('proxy', fields={'proxy': ' http://new '}, expected_raw=RAW)
    text = path.read_text(encoding='utf-8')
    assert "proxy = 'http://new'" in text
    assert 'http://old' not in text
    assert "oai_config_a = {'name': 'A'" in text
    assert result['structured']['globals']['proxy'] == 'http://new'
    backup.assert_called_once()
    reload.assert_called_once()


@pytest.mark.parametrize('expected', [None, '', RAW + '# stale'])
def test_proxy_stale_or_missing_revision_is_rejected(transaction, expected):
    path, backup, reload = transaction
    with pytest.raises(svc.MykeyHttpError) as error:
        svc.mutate_mykey('proxy', fields={'proxy': 'new'}, expected_raw=expected)
    assert error.value.status_code == 409
    assert path.read_text(encoding='utf-8') == RAW
    backup.assert_not_called()
    reload.assert_not_called()


@pytest.mark.parametrize('source', [
    'oai_config_a: dict = {}\n', 'oai_config_a = other = {}\n', 'oai_config_a = {}\noai_config_a = {}\n', 'oai_config_a = {\n',
])
def test_ambiguous_or_invalid_source_cannot_be_overwritten(transaction, source):
    path, backup, reload = transaction
    path.write_text(source, encoding='utf-8')
    with pytest.raises(svc.MykeyHttpError) as error:
        svc.mutate_mykey('update', 'oai_config_a', fields={'name': 'new'}, session_type='oai')
    assert error.value.status_code == 400
    assert path.read_text(encoding='utf-8') == source
    backup.assert_not_called()
    reload.assert_not_called()


def test_route_forwards_complete_mutation_contract():
    req = MyKeyMutationReq(action='proxy', fields={'proxy': 'new'}, expected_raw='fixture')
    with mock.patch.object(svc, 'mutate_mykey', return_value={'ok': True}) as mutation:
        assert asyncio.run(mykey.mutate_mykey(req)) == {'ok': True}
    mutation.assert_called_once_with('proxy', None, None, {'proxy': 'new'}, None, 'fixture')


def test_route_translates_conflict_without_losing_detail():
    req = MyKeyMutationReq(action='create', var='oai_config_a', fields={})
    with mock.patch.object(svc, 'mutate_mykey', side_effect=svc.MykeyHttpError(409, 'exists')):
        with pytest.raises(HTTPException) as error:
            asyncio.run(mykey.mutate_mykey(req))
    assert error.value.status_code == 409
    assert error.value.detail == 'exists'


@pytest.mark.parametrize('operation', ['raw', 'restore', 'fetch'])
def test_all_text_writes_share_one_commit(transaction, tmp_path, operation):
    path, backup, reload = transaction
    replacement = "oai_config_new = {'name': 'new'}\r\n"
    staged = []
    def fetch(args):
        target = svc.Path(args[args.index('--target') + 1])
        assert target != path and not target.exists()
        assert path.read_text(encoding='utf-8') == RAW
        target.write_bytes(replacement.encode('utf-8'))
        staged.append(target)
        return {'returncode': 0, 'stdout': 'fixture', 'stderr': ''}
    (tmp_path / 'mykey.py.fixture.bak').write_bytes(replacement.encode('utf-8'))
    with (
        mock.patch.object(svc, '_backup_dir', return_value=tmp_path),
        mock.patch.object(svc._paths, 'ADMIN_DATA', tmp_path),
        mock.patch.object(svc, '_run_mykey_sync', side_effect=fetch),
    ):
        if operation == 'raw':
            result = svc.write_raw(replacement)
        elif operation == 'restore':
            result = svc.restore_backup('mykey.py.fixture.bak')
        else:
            result = svc.sync_fetch()
    assert path.read_bytes() == replacement.encode('utf-8')
    assert result['backup'] == 'fixture-backup'
    assert 'mixin' not in result['structured']
    backup.assert_called_once_with(path)
    reload.assert_called_once()
    assert all(not target.parent.exists() for target in staged)


@pytest.mark.parametrize('failure', ['missing', 'invalid', 'runner'])
def test_fetch_failure_preserves_live_file_and_cleans_staging(transaction, tmp_path, failure):
    path, backup, reload = transaction
    staged = []
    def fetch(args):
        target = svc.Path(args[args.index('--target') + 1])
        staged.append(target)
        if failure == 'runner':
            target.write_text('partial', encoding='utf-8')
            raise svc.MykeyHttpError(502, 'download_failed')
        if failure == 'invalid':
            target.write_text('broken = {', encoding='utf-8')
        return {}
    with (
        mock.patch.object(svc._paths, 'ADMIN_DATA', tmp_path),
        mock.patch.object(svc, '_run_mykey_sync', side_effect=fetch),
        pytest.raises(svc.MykeyHttpError),
    ):
        svc.sync_fetch()
    assert path.read_text(encoding='utf-8') == RAW
    backup.assert_not_called()
    reload.assert_not_called()
    assert all(not target.parent.exists() for target in staged)


@pytest.mark.parametrize('operation', ['raw', 'restore'])
def test_invalid_text_write_is_rejected_before_backup(transaction, tmp_path, operation):
    path, backup, reload = transaction
    invalid = 'broken = {'
    (tmp_path / 'bad.py').write_text(invalid, encoding='utf-8')
    with mock.patch.object(svc, '_backup_dir', return_value=tmp_path), pytest.raises(svc.MykeyHttpError):
        svc.write_raw(invalid) if operation == 'raw' else svc.restore_backup('bad.py')
    assert path.read_text(encoding='utf-8') == RAW
    backup.assert_not_called()
    reload.assert_not_called()


def test_removed_structured_contract_is_not_exposed():
    from pydantic import ValidationError
    assert not hasattr(svc, 'upsert_session')
    assert not hasattr(svc, 'delete_session')
    assert not hasattr(svc, '_delete_session_assignment')
    assert not hasattr(svc, '_read_and_reload_mykey')
    with pytest.raises(ValidationError):
        MyKeyMutationReq(action='upsert', var='oai_config_new', fields={})
    writes = {(route.path, method) for route in mykey.router.routes for method in route.methods if method in {'POST', 'DELETE'}}
    assert ('/api/mykey/sessions', 'POST') not in writes
    assert ('/api/mykey/sessions/{var}', 'DELETE') not in writes
