from server.services.archive_identity import begin_run, finish_run, project_identity


def _begin(path, run="r", ordinal=0):
    begin_run(path, session_id="s", run_id=run, logical_id=run, stream_id=run, ordinal=ordinal)


def _page(*ordinals):
    return {"items": [{"ordinal": i, "content": "private"} for i in ordinals], "total": 4}


def test_append_keeps_identity_and_terminal_outcome(tmp_path):
    path = tmp_path / "archive.log"
    path.write_text("prefix", encoding="utf-8")
    _begin(path)
    path.write_text("prefix continuation", encoding="utf-8")
    finish_run(path, "r", ordinal=4, outcome="completed")
    result = project_identity(path, _page(0, 1, 2, 3, 4))
    assert all(item["run_id"] == "r" and item["outcome"] == "completed" for item in result["items"][:4])
    assert "run_id" not in result["items"][4]
    assert "private" not in path.with_name(path.name + ".hub-identity.json").read_text()


def test_rewrite_or_truncation_invalidates_identity(tmp_path):
    path = tmp_path / "archive.log"
    path.write_text("prefix", encoding="utf-8")
    _begin(path)
    path.write_text("changed", encoding="utf-8")
    assert project_identity(path, _page(0)) == _page(0)
    path.write_text("p", encoding="utf-8")
    assert project_identity(path, _page(0)) == _page(0)


def test_legacy_history_does_not_infer_stop_or_identity(tmp_path):
    path = tmp_path / "archive.log"
    path.write_text("legacy", encoding="utf-8")
    assert project_identity(path, _page(0, 1)) == _page(0, 1)


def test_next_run_closes_previous_and_continuation_is_idempotent(tmp_path):
    path = tmp_path / "archive.log"
    path.write_text("prefix", encoding="utf-8")
    _begin(path)
    _begin(path, ordinal=2)
    _begin(path, run="next", ordinal=4)
    result = project_identity(path, _page(0, 3, 4))
    assert [item["run_id"] for item in result["items"]] == ["r", "r", "next"]
