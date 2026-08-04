from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEBUI = ROOT / "webui" / "src"


def _read(relative: str) -> str:
    return (WEBUI / relative).read_text(encoding="utf-8")


def test_live_chat_uses_session_http_for_submit_and_abort():
    source = _read("pages/LiveChat.tsx")

    assert "api.sessionRun(" in source
    assert "api.abortSession(" in source
    assert "sock.send({ type: 'submit'" not in source
    assert "sock.send({ type: 'abort'" not in source


def test_chat_store_does_not_expose_legacy_submit_or_abort_actions():
    source = _read("stores/chatStore.ts")

    assert "submitWebui" not in source
    assert "abort: ()" not in source
    assert "send({ type: 'submit'" not in source
    assert "send({ type: 'abort'" not in source


def test_chat_store_session_socket_is_receive_only():
    source = _read("stores/chatStore.ts")

    assert "new ChatSocket(() => sessionSocketPath(sessionId))" in source
    assert ".send(" not in source
