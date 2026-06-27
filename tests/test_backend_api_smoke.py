"""Smoke tests for the FastAPI backend surface.

These tests intentionally force setup mode so they exercise the API shell
without bootstrapping a real GenericAgent checkout, schedulers, or background
watchers.  The goal is to catch broken imports/router wiring/middleware changes
with a cheap in-process HTTP client.
"""
from __future__ import annotations

import importlib
import os
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

    def test_host_guard_rejects_non_localhost_domains(self) -> None:
        app = self.main.create_app()
        with TestClient(app) as client:
            response = client.get("/api/status", headers={"host": "evil.example"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.text, "Forbidden host")


if __name__ == "__main__":
    unittest.main()
