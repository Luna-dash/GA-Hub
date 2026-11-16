"""Public release update tests: no network, scheduler, or real desktop."""
import hashlib
import json
import zipfile

import pytest

from server.services import update_release as feed
from server.services.self_update import DATA_EPOCH, EXECUTABLES, UpdateStore


def fake_feed(monkeypatch, tmp_path, *, version="1.2.0", prerelease=False):
    name = f"GA-Hub-{version}-windows-x64.zip"
    files = {n: b"MZ-test-" + n.encode() for n in (*EXECUTABLES, "ga-hub-update.exe")}
    info = {"version": version, "tag": "v" + version, "channel": "stable", "dirty": False,
            "sha256": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}}
    archive = tmp_path / "source.zip"
    with zipfile.ZipFile(archive, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
        z.writestr("build-info.json", json.dumps(info))
        z.writestr("update-manifest.json", json.dumps({"schema": 1, "platform": "windows-x64", "data_epoch": DATA_EPOCH}))
    data = archive.read_bytes()
    metadata = {"tag_name": "v" + version, "draft": False, "prerelease": prerelease,
                "assets": [{"name": name, "size": len(data)}, {"name": "SHA256SUMS.txt", "size": 150}], "body": "Notes"}
    contents = {feed.API: json.dumps(metadata).encode(), feed.asset_url("v" + version, name): data,
                feed.asset_url("v" + version, "SHA256SUMS.txt"): (hashlib.sha256(data).hexdigest() + "  " + name + "\n").encode()}
    monkeypatch.setattr(feed, "installed_version", lambda: "1.1.0")
    monkeypatch.setattr(feed, "fetch", lambda url, path, limit: path.write_bytes(contents[url]))
    return contents, metadata


def test_check_and_prepare_three_exe_package(tmp_path, monkeypatch):
    fake_feed(monkeypatch, tmp_path)
    store = UpdateStore(tmp_path / "updates")
    result = feed.check(store.root)
    assert result["available"] and result["notes"] == "Notes"
    plan = feed.prepare(store)
    assert plan["state"] == "prepared"
    assert (store.verify(plan) / "ga-hub-update.exe").is_file()
    assert not list(store.root.glob("*.zip")) and not list(store.root.glob("feed-*.json"))


@pytest.mark.parametrize("version", ["1.1.0", "1.0.0"])
def test_no_downgrade(tmp_path, monkeypatch, version):
    fake_feed(monkeypatch, tmp_path, version=version)
    with pytest.raises(ValueError, match="No newer"):
        feed.prepare(UpdateStore(tmp_path / "updates"))


def test_reject_prerelease(tmp_path, monkeypatch):
    fake_feed(monkeypatch, tmp_path, prerelease=True)
    with pytest.raises(ValueError, match="not stable"):
        feed.check(tmp_path / "updates")


def test_corrupted_archive_never_prepared(tmp_path, monkeypatch):
    contents, _ = fake_feed(monkeypatch, tmp_path)
    key = next(k for k in contents if k.endswith(".zip"))
    contents[key] = b"x" * len(contents[key])
    store = UpdateStore(tmp_path / "updates")
    with pytest.raises(ValueError, match="checksum/size"):
        feed.prepare(store)
    assert store.read()["state"] == "idle"
    assert not list(store.root.glob("*.zip"))


@pytest.mark.parametrize("url", ["http://github.com/x", "https://evil.test/x", "https://github.com.evil.test/x", "https://a@github.com/x", "https://github.com:444/x"])
def test_untrusted_url_rejected_before_request(tmp_path, url):
    with pytest.raises(ValueError, match="Untrusted"):
        feed.fetch(url, tmp_path / "out", 10)


@pytest.mark.parametrize("version", ["v1.2.3-rc1", "../1.2.3", "1.2", "latest"])
def test_strict_stable_versions(version):
    with pytest.raises(ValueError):
        feed.version_tuple(version)
