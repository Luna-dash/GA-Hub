"""Independent filesystem regressions: literal names must not alias URL-decoded peers."""
from pathlib import Path

import pytest

from server import _paths
from server.services.file_resolution import normalize, resolve


@pytest.mark.parametrize('name', [
    'literal%20name.txt', 'percent%25.txt', 'nested%2520.txt',
    'hash%23.txt', 'query%3F.txt', 'unicode% E4.txt', '中文 #+%.txt',
])
def test_literal_and_uri_roundtrip_are_distinct(tmp_path, monkeypatch, name):
    monkeypatch.setattr(_paths, 'GA_ROOT', tmp_path)
    target = tmp_path / name
    target.write_text('literal', encoding='utf-8')
    # A space peer makes a false positive ("exists" but wrong file) observable.
    peer = tmp_path / name.replace('%20', ' ')
    if peer != target:
        peer.write_text('other', encoding='utf-8')
    for raw in [str(target), target.as_uri(), f'"{target}"', f'{target}:12:4']:
        info = resolve(raw)
        assert info['resolved'] == str(target.resolve()), (raw, info)
        assert info['exists'] and not info['ambiguous']


def test_raw_encoded_name_never_falls_back_to_decoded_peer(tmp_path, monkeypatch):
    monkeypatch.setattr(_paths, 'GA_ROOT', tmp_path)
    (tmp_path / 'not here.txt').write_text('wrong', encoding='utf-8')
    info = resolve(str(tmp_path / 'not%20here.txt'))
    assert not info['exists'] and info['resolved'] is None


@pytest.mark.parametrize(('raw', 'expected'), [
    ('file:///C:/a%2520b.txt', 'C:/a%20b.txt'),
    ('file:///C:/a%20b.txt:12:4', 'C:/a b.txt'),
    ('file://LOCALHOST/C:/a%23b.txt', 'C:/a#b.txt'),
    ('file://server/share/a%25b.txt', '//server/share/a%b.txt'),
    ('C:\\data\\a%20b.txt', 'C:/data/a%20b.txt'),
    ('file:///C:/a%3A12', 'C:/a:12'),
])
def test_url_decoding_has_one_explicit_boundary(raw, expected):
    assert normalize(raw) == expected


def test_malformed_file_uri_is_unresolved():
    assert resolve('file://[broken/path')['resolved'] is None
