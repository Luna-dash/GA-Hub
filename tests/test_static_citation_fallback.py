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
        for path in ["/", "/chat", "/settings?tab=x", "/conversations/session"]:
            response = client.get(path)
            assert response.status_code == 200
            assert response.text == "<html>shell</html>"
            assert "no-store" in response.headers["cache-control"]
        for path in ["/temp/report.md", "/missing.pdf", "/api/files/missing", "/D:/a.md", "/assets/missing.js", "/chat/missing.pdf"]:
            response = client.get(path)
            assert response.status_code == 404
            assert "<html>shell</html>" not in response.text
        assert client.get("/icon.svg").text == "<svg/>"
