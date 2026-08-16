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


def test_live_chat_lazily_creates_sessions_only_on_submit_or_explicit_new():
    source = _read("pages/LiveChat.tsx")

    # Opening /chat must not create a durable session as a side effect.
    init_block = source[source.index("  useEffect(() => {"):source.index("  const submit =")]
    assert "api.createSession" not in init_block
    assert "if (!current) {" in init_block
    assert "setSession(null)" in init_block

    # The empty state remains sendable; submit owns the lazy create path.
    assert "disabled={creatingSession}" in source
    submit_block = source[source.index("  const submit ="):source.index("  const newConv =")]
    assert "api.createSession({ title: '', llm_key: defaultLlmKey })" in submit_block
    assert "api.createSession({ title: '', llm_key: null })" not in source
    assert "liveChat:pending" in source


def test_live_chat_does_not_recreate_session_after_last_delete():
    source = _read("pages/LiveChat.tsx")
    assert "onDelete={deleteSession}" in source
    delete_start = source.index("  const deleteSession = useCallback")
    delete_block = source[delete_start:source.index("  const handleRewind =", delete_start)]
    # The last-session branch clears selection and returns to /chat.
    assert "nav('/chat', { replace: true })" in delete_block
    assert "api.createSession" not in delete_block


def test_chat_store_session_socket_is_receive_only():
    source = _read("stores/chatStore.ts")

    assert "new ChatSocket(() => sessionSocketPath(sessionId))" in source
    assert ".send(" not in source
