"""Hub control projection must classify raw blocks before GA folds rounds."""
import json
from server.services.archive_messages import _extract_ui_messages_from_text, read_archive_messages


def round_text(blocks, answer):
    return ('=== Prompt === 2026-09-22 10:00:00\n'
            + json.dumps({'role': 'user', 'content': blocks}, ensure_ascii=False)
            + '\n=== Response === 2026-09-22 10:00:01\n'
            + repr([{'type': 'text', 'text': answer}]) + '\n')


def text(value):
    return {'type': 'text', 'text': value}


def test_internal_retry_preserves_one_native_turn_boundary(tmp_path):
    native = (round_text([text('real request')], 'first response')
              + round_text([text('[ERROR] Incomplete response. Regenerate and tooluse.')], 'continued response'))
    messages = _extract_ui_messages_from_text(native)
    assert [m['role'] for m in messages] == ['user', 'assistant']
    assert 'first response' in messages[1]['content']
    assert 'continued response' in messages[1]['content']
    assert 'Turn 2' in messages[1]['content']
    path = tmp_path / 'retry.txt'
    path.write_text(native, encoding='utf-8')
    full = read_archive_messages(path)
    page = read_archive_messages(path, limit=2)
    assert page['items'] == full['items']
    assert len(full['items']) == 2


def test_control_block_does_not_discard_following_real_input():
    messages = _extract_ui_messages_from_text(round_text([
        text('[GA_CONTINUE] Continue from the interruption. Do not repeat completed work.'), text('real request')], 'answer'))
    assert messages[0]['role'] == 'user'
    assert messages[0]['content'] == 'real request'


def test_multiple_real_blocks_survive_control_and_memory():
    messages = _extract_ui_messages_from_text(round_text([
        text('first part'), text('[GA_CONTINUE] Continue from the interruption. Do not repeat completed work.'),
        text('### [WORKING MEMORY]\ninternal'), text('second part')], 'answer'))
    assert messages[0]['content'] == 'first part\n\nsecond part'


def test_similar_control_prefix_is_preserved():
    for body in (
        '[GA_CONTINUE] What does this marker mean?',
        '[ERROR] Incomplete response. Regenerate and tooluse. Explain this error.',
        '上一条回复因可恢复的传输/网络错误，这句话是什么意思？',
    ):
        messages = _extract_ui_messages_from_text(round_text([text(body)], 'answer'))
        assert messages[0]['role'] == 'user'
        assert messages[0]['content'] == body


def test_control_mention_inside_body_is_preserved():
    body = 'Explain this marker:\n[ERROR] Incomplete response.'
    messages = _extract_ui_messages_from_text(round_text([text(body)], 'answer'))
    assert messages[0]['content'] == body
