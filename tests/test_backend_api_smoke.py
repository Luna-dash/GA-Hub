"""Smoke tests for the FastAPI backend surface.

These tests intentionally force setup mode so they exercise the API shell
without bootstrapping a real GenericAgent checkout, schedulers, or background
watchers.  The goal is to catch broken imports/router wiring/middleware changes
with a cheap in-process HTTP client.
"""
from __future__ import annotations

import importlib
import os
import re
import unittest
from tempfile import TemporaryDirectory
from unittest import mock

from fastapi.testclient import TestClient


class BackendApiSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self._env = mock.patch.dict(
            os.environ,
            {
                # Empty isolated config dir: no saved GA root from the user's machine.
                "GA_ADMIN_DATA": self._tmp.name,
                # Invalid on purpose: discover_ga_root() should ignore it and remain
                # in setup mode instead of touching a real GA checkout.
                "GA_ROOT": os.path.join(self._tmp.name, "not-a-ga-root"),
            },
            clear=False,
        )
        self._env.start()

        import server._paths as paths
        import server.main as main

        self.paths = importlib.reload(paths)
        self.main = importlib.reload(main)

        from server.services import event_bus

        self.event_bus = event_bus
        self._old_bus_loop = event_bus.bus._loop
        self._old_bus_subs = list(event_bus.bus._subs)

    def tearDown(self) -> None:
        self.event_bus.bus._loop = self._old_bus_loop
        self.event_bus.bus._subs[:] = self._old_bus_subs
        self._env.stop()
        # Restore module globals for any later tests in the same interpreter.
        importlib.reload(self.paths)
        importlib.reload(self.main)
        self._tmp.cleanup()

    def test_setup_mode_core_json_endpoints(self) -> None:
        app = self.main.create_app()
        with TestClient(app, base_url="http://127.0.0.1") as client:
            status = client.get("/api/status")
            self.assertEqual(status.status_code, 200)
            self.assertEqual(status.json()["mode"], "setup")
            self.assertFalse(status.json()["configured"])

            health = client.get("/api/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["status"], "unavailable")
            self.assertEqual(health.json()["services"][0]["id"], "core_contract")

            setup = client.get("/api/setup/status")
            self.assertEqual(setup.status_code, 200)
            data = setup.json()
            self.assertFalse(data["configured"])
            self.assertIn("admin_data", data)
            self.assertIn("candidates", data)
            self.assertIn("resolved_python", data)

            events = client.get("/api/events/recent?limit=5")
            self.assertEqual(events.status_code, 200)
            self.assertIn("events", events.json())

    def test_built_spa_deep_link_and_hashed_entry_asset(self) -> None:
        app = self.main.create_app()
        with TestClient(app, base_url="http://127.0.0.1") as client:
            root = client.get("/")
            deep_link = client.get("/chat")

            self.assertEqual(root.status_code, 200)
            self.assertEqual(deep_link.status_code, 200)
            self.assertIn("text/html", deep_link.headers["content-type"])
            self.assertEqual(deep_link.headers.get("cache-control"), "no-store, must-revalidate")

            match = re.search(r'<script[^>]+src="(/assets/[^"]+\.js)"', deep_link.text)
            self.assertIsNotNone(match, "built index must reference a hashed JavaScript entry")
            entry = client.get(match.group(1))
            self.assertEqual(entry.status_code, 200)
            self.assertIn("javascript", entry.headers["content-type"])
            self.assertGreater(len(entry.content), 100)

    def test_event_websocket_allows_local_origins(self) -> None:
        app = self.main.create_app()
        with TestClient(app, base_url="http://127.0.0.1") as client:
            for origin in ("http://127.0.0.1:8765", "http://localhost:5173"):
                with self.subTest(origin=origin):
                    with client.websocket_connect(
                        "/ws/events", headers={"origin": origin}
                    ) as websocket:
                        self.assertTrue(websocket.accepted_subprotocol is None)

    def test_event_websocket_rejects_external_origin(self) -> None:
        from server.routes.events import _is_allowed_origin
        from starlette.websockets import WebSocketDisconnect

        for origin in (
            "https://evil.example",
            "http://localhost.evil.example",
            "file://localhost",
            "null",
            "http://evil@localhost",
            "http://localhost/path",
            "http://localhost/?query",
            "http://localhost/#fragment",
        ):
            with self.subTest(origin=origin):
                self.assertFalse(_is_allowed_origin(origin))

        app = self.main.create_app()
        with TestClient(app, base_url="http://127.0.0.1") as client:
            with self.assertRaises(WebSocketDisconnect) as rejected:
                with client.websocket_connect(
                    "/ws/events?replay=5",
                    headers={"origin": "https://evil.example"},
                ):
                    self.fail("external origin must not reach the EventBus")

        self.assertEqual(rejected.exception.code, 1008)

    def test_host_guard_rejects_non_localhost_domains(self) -> None:
        app = self.main.create_app()
        with TestClient(app) as client:
            response = client.get("/api/status", headers={"host": "evil.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.text, "Forbidden host")


if __name__ == "__main__":
    unittest.main()
