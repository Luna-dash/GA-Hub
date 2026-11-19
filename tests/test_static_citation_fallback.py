import re
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
from server import main


def test_only_registered_routes_receive_spa(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>shell</html>", encoding="utf-8")
    (tmp_path / "icon.svg").write_text("<svg/>", encoding="utf-8")
    monkeypatch.setattr(main, "WEBUI_DIST", tmp_path)
    app = FastAPI()
    main._mount_static(app)
    with TestClient(app) as client:
        for path in ["/", "/chat", "/anti", "/theme-tasks", "/settings?tab=x", "/conversations/session"]:
            response = client.get(path)
            assert response.status_code == 200
            assert response.text == "<html>shell</html>"
            assert "no-store" in response.headers["cache-control"]
        for path in ["/temp/report.md", "/missing.pdf", "/api/files/missing", "/D:/a.md", "/assets/missing.js", "/chat/missing.pdf"]:
            response = client.get(path)
            assert response.status_code == 404
            assert "<html>shell</html>" not in response.text
        assert client.get("/icon.svg").text == "<svg/>"


def test_spa_routes_match_frontend_page_manifest():
    root = Path(__file__).resolve().parents[1]
    pages_ts = (root / "webui" / "src" / "config" / "pages.ts").read_text(encoding="utf-8")
    app_tsx = (root / "webui" / "src" / "App.tsx").read_text(encoding="utf-8")

    manifest_ids = set(re.findall(r"\bid:\s*'([a-z0-9-]+)'", pages_ts))
    explicit_redirects = set(re.findall(r'<Route\s+path="/([a-z0-9-]+)"\s+element=\{<Navigate\b', app_tsx))

    assert manifest_ids
    assert main.SPA_ROUTES == (manifest_ids | explicit_redirects)
