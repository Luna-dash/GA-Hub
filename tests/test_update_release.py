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
    def fetch(url, path, limit, progress=None):
        path.write_bytes(contents[url])
        if progress is not None:
            progress(len(contents[url]))
    monkeypatch.setattr(feed, "fetch", fetch)
    return contents, metadata


def test_check_and_prepare_three_exe_package(tmp_path, monkeypatch):
    fake_feed(monkeypatch, tmp_path)
    store = UpdateStore(tmp_path / "updates")
    result = feed.check(store.root)
    assert result["available"] and result["notes"] == "Notes"
    events = []
    plan = feed.prepare(store, progress=lambda phase, **values: events.append((phase, values)))
    assert [phase for phase, _ in events] == ["checksums", "downloading", "downloading", "verifying", "preparing"]
    assert events[2][1]["received_bytes"] == result["size"]
    assert events[0][1]["total_bytes"] == result["size"]
    assert json.loads((store.root / "release.json").read_text(encoding="utf8")) == result
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


@pytest.mark.parametrize("system_proxies,bypass,expected", [
    ({"http": "http://system:10808", "https": "http://system:10808"}, False, {"http": "http://system:10808", "https": "http://system:10808"}),
    ({"https": "http://system:10808"}, True, {}),
    ({}, False, None),
])
def test_windows_download_uses_system_proxy_over_partial_environment(monkeypatch, tmp_path, system_proxies, bypass, expected):
    monkeypatch.setattr(feed, "platform", "win32", raising=False)
    monkeypatch.setenv("HTTP_PROXY", "http://environment:9999")
    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.setattr(feed.proxy_settings, "getproxies_registry", lambda: system_proxies, raising=False)
    monkeypatch.setattr(feed.proxy_settings, "proxy_bypass_registry", lambda host: bypass, raising=False)
    calls = []

    class Response:
        status_code = 200
        is_redirect = False
        headers = {}
        def __enter__(self): return self
        def __exit__(self, *args): pass
        def raise_for_status(self): pass
        def iter_content(self, size): return iter([b"downloaded"])

    class Session:
        trust_env = True
        def get(self, url, **kwargs):
            calls.append((self.trust_env, kwargs.get("proxies")))
            return Response()
        def close(self): pass

    monkeypatch.setattr(feed.requests, "Session", Session)
    received = []
    feed.fetch("https://github.com/test", tmp_path / "asset", 100, progress=received.append)
    assert received == [len(b"downloaded")]
    assert (tmp_path / "asset").read_bytes() == b"downloaded"
    assert calls == [(not bool(system_proxies), expected)]


@pytest.mark.parametrize("platform", ["win32", "linux"])
def test_real_session_proxy_choice_and_redirect_bypass(monkeypatch, tmp_path, platform):
    from requests import Response

    monkeypatch.setattr(feed, "platform", platform)
    monkeypatch.setenv("HTTP_PROXY", "http://environment:9999")
    monkeypatch.setenv("HTTPS_PROXY", "http://environment:9999")
    monkeypatch.setattr(feed.proxy_settings, "getproxies_registry", lambda: {"https": "http://system:10808"}, raising=False)
    monkeypatch.setattr(feed.proxy_settings, "proxy_bypass_registry", lambda host: host == "release-assets.githubusercontent.com", raising=False)
    calls = []

    def send(self, request, **kwargs):
        calls.append(kwargs["proxies"])
        response = Response()
        response.url = request.url
        response.request = request
        response.status_code = 302 if len(calls) == 1 else 200
        response.headers = feed.requests.structures.CaseInsensitiveDict({"Location": "https://release-assets.githubusercontent.com/test"} if len(calls) == 1 else {})
        response._content = b"downloaded"
        response._content_consumed = True
        return response

    monkeypatch.setattr(feed.requests.Session, "send", send)
    feed.fetch("https://github.com/test", tmp_path / "asset", 100)
    assert (tmp_path / "asset").read_bytes() == b"downloaded"
    if platform == "win32":
        assert calls == [{"https": "http://system:10808"}, {}]
    else:
        assert all(proxy["https"] == "http://environment:9999" for proxy in calls)


@pytest.mark.parametrize("version", ["v1.2.3-rc1", "../1.2.3", "1.2", "latest"])
def test_strict_stable_versions(version):
    with pytest.raises(ValueError):
        feed.version_tuple(version)
