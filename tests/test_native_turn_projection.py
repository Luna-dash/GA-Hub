"""Native queue boundaries, including compatibility and terminal failures."""
from server.services.native_turn_projection import NativeTurnProjection


def test_cumulative_native_windows_and_replay():
    projection = NativeTurnProjection()
    first = "Turn 1\nbody\nTurn 99 is literal\n"
    second, third = "Turn 2\nwork\n", "Turn 3\nanswer"
    assert projection.update(dict(turn=1, outputs=[first]), first) == [first]
    assert projection.update(dict(turn=2, outputs=[first, second]), first+second) == [first, second]
    event = dict(turn=3, outputs=[second, third])
    assert projection.update(event, first+second+third) == [first, second, third]
    assert projection.update(event, first+second+third) == [first, second, third]
    assert projection.update(dict(turn=3, outputs=[first, second, third]), first+second+third, final=True) == [first, second, third]


def test_missing_windows_fail_closed_and_final_snapshot_repairs():
    projection = NativeTurnProjection()
    assert projection.update(dict(turn=3, outputs=['b', 'c']), 'abc') is None
    assert projection.update(dict(turn=3, outputs=['a', 'b', 'c']), 'abc', final=True) == ['a', 'b', 'c']


def test_native_error_trailer_stays_in_last_real_turn():
    projection = NativeTurnProjection()
    assert projection.update(dict(turn=2, outputs=['a', 'b']), 'ab\nerror', final=True) == ['a', 'b\nerror']


def test_legacy_and_bad_metadata_never_infer_boundaries():
    for event in [{}, dict(turn=True, outputs=['a']), dict(turn=1, outputs=['wrong']), dict(turn=1, outputs=[1]), dict(turn=1, outputs=[])]:
        assert NativeTurnProjection().update(event, 'Turn 1\na') is None
