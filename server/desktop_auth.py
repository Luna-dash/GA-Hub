"""Authentication for privileged APIs in a shell-owned desktop sidecar."""
import secrets

from fastapi import HTTPException, Request


def require_desktop_instance(request: Request) -> None:
    expected = getattr(request.app.state, "desktop_instance_token", None)
    if not expected:
        return  # Standalone browser/server mode has no owning desktop shell.
    provided = request.headers.getlist("x-ga-hub-instance")
    if len(provided) != 1 or not secrets.compare_digest(provided[0].encode("utf-8"), expected.encode("utf-8")):
        raise HTTPException(403, "Forbidden desktop API caller")
