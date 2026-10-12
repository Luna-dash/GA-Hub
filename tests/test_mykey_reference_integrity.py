"""Synthetic MyKey fixtures: GA file-order/name binding and transaction safety."""
import ast
from types import SimpleNamespace
from unittest import mock

import pytest

from server.services import mykey_codec as codec
from server.services import mykey_service as svc

RAW = '''first_oai_config = {"name": "alpha", "model": "fallback"}
mixin_early_config = {"llm_nos": [0, 2]}
last_oai_config = {"name": "beta", "model": "b"}
mixin_late_config = {"llm_nos": [0, 2, "alpha", "beta"]}
'''


def fields(raw, var):
    return next(ast.literal_eval(node.value) for node in ast.parse(raw).body
                if isinstance(node, ast.Assign) and node.targets[0].id == var)


def mutate(raw, action, var, new_var=None, values=None, kind=None):
    return codec.mutate_session_assignment(raw, action, var, new_var, values, kind)


@pytest.mark.parametrize("name", ["mixin_oai_config", "native_claude_mixin_api", "oai_mixin_cookie"])
def test_mixin_classification_precedes_backend_keywords(name):
    assert codec.classify_config(name) == "mixin"
    assert codec.classify_config("oai_mixin") == "global"
    mutate("", "create", name, values={"llm_nos": []}, kind="mixin")
    with pytest.raises(codec.InvalidVariableNameError):
        mutate("", "create", name, values={}, kind="oai")


@pytest.mark.parametrize("var, refs", [
    ("first_oai_config", [1, 1]),
    ("mixin_early_config", [0, 1, "alpha", "beta"]),
    ("last_oai_config", [0, "alpha"]),
])
def test_delete_remaps_all_slots_and_counts_removed_not_shifted(var, refs):
    updated, removed = codec.delete_base_assignment(RAW, var)
    assert fields(updated, "mixin_late_config")["llm_nos"] == refs
    assert removed == (0 if var == "mixin_early_config" else 3)


def test_duplicate_base_shifts_existing_refs_without_stealing_name_refs():
    updated = mutate(RAW, "duplicate", "first_oai_config", "copy_oai_config")
    assert fields(updated, "mixin_late_config")["llm_nos"] == [0, 3, "alpha", "beta"]
    assert fields(updated, "mixin_early_config")["llm_nos"] == [0, 3]


def test_duplicate_mixin_shifts_both_copy_and_original_refs():
    updated = mutate(RAW, "duplicate", "mixin_early_config", "copy_mixin_config")
    for var in ("mixin_early_config", "copy_mixin_config"):
        assert fields(updated, var)["llm_nos"] == [0, 3]
    assert fields(updated, "mixin_late_config")["llm_nos"] == [0, 3, "alpha", "beta"]


@pytest.mark.parametrize("action,new_var", [("update", None), ("rename", "renamed_oai_config")])
def test_name_edits_rebind_string_refs_but_keep_index_identity(action, new_var):
    updated = mutate(RAW, action, "first_oai_config", new_var, {"name": "new-alpha"})
    assert fields(updated, "mixin_late_config")["llm_nos"] == [0, 2, "new-alpha", "beta"]


def test_model_default_used_for_name_binding_on_edit_and_delete():
    raw = 'first_oai_config = {"model": "gpt"}\nmixin_config = {"llm_nos": ["gpt", 0]}\n'
    updated = mutate(raw, "update", "first_oai_config", values={"model": "new-gpt"})
    assert fields(updated, "mixin_config")["llm_nos"] == ["new-gpt", 0]
    deleted, removed = codec.delete_base_assignment(raw, "first_oai_config")
    assert fields(deleted, "mixin_config")["llm_nos"] == []
    assert removed == 2


def test_name_collision_cannot_silently_retarget_existing_refs():
    with pytest.raises(codec.AssignmentConflictError):
        mutate(RAW, "update", "last_oai_config", values={"name": "alpha"})


def test_negative_index_and_bool_follow_python_index_semantics():
    raw = RAW + 'extra_mixin_config = {"llm_nos": [-3, True, -1, 99, "unknown"]}\n'
    updated, removed = codec.delete_base_assignment(raw, "mixin_early_config")
    assert fields(updated, "extra_mixin_config")["llm_nos"] == [1, 3, 99, "unknown"]
    assert removed == 1


def test_create_mixin_refs_already_use_new_order():
    updated = mutate(RAW, "create", "new_mixin_config", values={"llm_nos": [-2, 0]})
    assert fields(updated, "new_mixin_config")["llm_nos"] == [-2, 0]


@pytest.fixture
def transaction(tmp_path):
    path = tmp_path / "mykey.py"
    path.write_bytes(RAW.encode())
    backup_dir = tmp_path / "backups"
    with mock.patch.object(svc, "_mykey_path", return_value=path), \
         mock.patch.object(svc, "_backup_dir", return_value=backup_dir), \
         mock.patch.object(svc, "_trigger_reload", return_value=([], [])) as reload:
        yield SimpleNamespace(path=path, backup_dir=backup_dir, reload=reload)


def test_service_delete_mixin_uses_same_slot_remapping(transaction):
    result = svc.mutate_mykey("delete", var="mixin_early_config")
    assert fields(transaction.path.read_text(), "mixin_late_config")["llm_nos"] == [0, 1, "alpha", "beta"]
    assert result["removed_mixin_references"] == 0
    assert len(list(transaction.backup_dir.glob("*.bak"))) == 1


@pytest.mark.parametrize("directory_failure", [False, True])
def test_backup_failure_aborts_before_write_and_reload(transaction, directory_failure):
    original = transaction.path.read_bytes()
    target = mock.patch.object(svc, "_ensure_backup_dir", side_effect=OSError("denied")) if directory_failure else mock.patch("pathlib.Path.open", side_effect=OSError("disk full"))
    # Exercise _backup_current directly for a failed write; transaction read must remain usable.
    if directory_failure:
        with target, pytest.raises(svc.MykeyHttpError) as error:
            svc.mutate_mykey("update", var="first_oai_config", fields={"name": "new"})
    else:
        with target, pytest.raises(svc.MykeyHttpError) as error:
            svc._backup_current(transaction.path)
    assert error.value.status_code == 500
    assert error.value.detail["error"] == "backup_failed"
    assert transaction.path.read_bytes() == original
    transaction.reload.assert_not_called()


def test_same_second_backups_are_distinct_and_keep_each_version(transaction):
    original = transaction.path.read_bytes()
    with mock.patch.object(svc.time, "strftime", return_value="same-second"):
        svc.mutate_mykey("update", var="first_oai_config", fields={"name": "new"})
        middle = transaction.path.read_bytes()
        svc.mutate_mykey("update", var="first_oai_config", fields={"name": "final"})
    snapshots = list(transaction.backup_dir.glob("*.bak"))
    assert len(snapshots) == 2
    assert {p.read_bytes() for p in snapshots} == {original, middle}


@pytest.mark.parametrize("newline", [b"\n", b"\r\n"])
def test_structured_edit_preserves_uniform_newline_style(transaction, newline):
    transaction.path.write_bytes(RAW.encode().replace(b"\n", newline))
    svc.mutate_mykey("update", var="first_oai_config", fields={"name": "new"})
    data = transaction.path.read_bytes()
    assert data.count(b"\n") > 0
    assert data.count(b"\r\n") == (data.count(b"\n") if newline == b"\r\n" else 0)


def test_replace_failure_preserves_original_and_cleans_temp(transaction):
    original = transaction.path.read_bytes()
    with mock.patch.object(svc.os, "replace", side_effect=OSError("busy")), pytest.raises(OSError):
        svc.mutate_mykey("update", var="first_oai_config", fields={"name": "new"})
    assert transaction.path.read_bytes() == original
    assert not transaction.path.with_suffix(".py.tmp").exists()
    transaction.reload.assert_not_called()


@pytest.mark.parametrize("action", ["update", "rename", "duplicate"])
def test_nested_mixin_derived_names_follow_member_edits(action):
    raw = RAW + 'mixin_nested_config = {"llm_nos": ["alpha|beta"]}\n'
    updated = mutate(raw, action, "first_oai_config",
                     "renamed_oai_config" if action != "update" else None,
                     {"name": "gamma", "model": "fallback"})
    expected = "alpha|beta" if action == "duplicate" else "gamma|beta"
    assert fields(updated, "mixin_nested_config")["llm_nos"] == [expected]


def test_nested_mixin_derived_name_follows_member_deletion():
    raw = RAW + 'mixin_nested_config = {"llm_nos": ["alpha|beta"]}\n'
    updated, removed = codec.delete_base_assignment(raw, "first_oai_config")
    assert fields(updated, "mixin_nested_config")["llm_nos"] == ["beta"]
    assert removed == 3
