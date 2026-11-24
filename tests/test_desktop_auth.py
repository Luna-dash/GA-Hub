from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from server.routes import mykey


def test_mykey_router_requires_desktop_instance_header_only_when_configured(monkeypatch):
    app = FastAPI()
    app.include_router(mykey.router)
    calls = []

    def fake_read():
        calls.append(True)
        raise HTTPException(418, "Reached stub")

    monkeypatch.setattr(mykey.mykey_service, "read_mykey", fake_read)
    with TestClient(app) as client:
        assert client.get("/api/mykey").status_code == 418
        app.state.desktop_instance_token = "test-desktop-instance"
        assert client.get("/api/mykey").status_code == 403
        assert client.get("/api/mykey", headers={"X-GA-Hub-Instance": "wrong"}).status_code == 403
        headers = [("X-GA-Hub-Instance", "test-desktop-instance")]
        assert client.get("/api/mykey", headers=headers * 2).status_code == 403
        assert client.get("/api/mykey", headers=headers).status_code == 418
    assert len(calls) == 2
