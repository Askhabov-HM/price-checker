from pathlib import Path
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

from price_checker.service import Tracker
from price_checker.web import make_server


class WebTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        root = Path(self.directory.name)
        secret = root / ".secrets/randewoo-session.json"
        secret.parent.mkdir()
        secret.write_text(json.dumps({"cookie": "private-test-session", "user_agent": "test"}))
        self.tracker = Tracker(root)
        self.server = make_server(self.tracker, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"
        self.token = self.request("/api/status")["csrf_token"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.directory.cleanup()

    def request(self, path, data=None, headers=None):
        headers = headers or {}
        if data is not None:
            headers.setdefault("Content-Type", "application/json")
        request = urllib.request.Request(self.base + path, data=json.dumps(data).encode() if data is not None else None, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            error.close()
            raise

    def test_session_values_are_not_exposed(self):
        status = self.request("/api/status")
        self.assertNotIn("private-test-session", json.dumps(status))
        self.assertTrue(status["session_present"])

    def test_secrets_and_files_outside_static_are_inaccessible(self):
        for path in ("/.secrets/randewoo-session.json", "/../.secrets/randewoo-session.json", "/.data/prices.sqlite3"):
            with self.subTest(path=path), self.assertRaises(urllib.error.HTTPError) as error:
                self.request(path)
            self.assertEqual(error.exception.code, 404)

    def test_changes_require_csrf_and_same_origin(self):
        data = {"schedule": ["10:00"], "schedule_enabled": True}
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/settings", data)
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request("/api/settings", data, {"X-CSRF-Token": self.token, "Origin": "https://example.com"})
        self.assertEqual(error.exception.code, 403)
        self.request("/api/settings", data, {"X-CSRF-Token": self.token, "Origin": self.base})
        self.assertEqual(self.request("/api/status")["schedule"], ["10:00"])

    def test_local_interface_and_csv_load(self):
        with urllib.request.urlopen(self.base + "/") as response:
            self.assertIn("Price Checker", response.read().decode())
            self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        dashboard = self.request("/api/dashboard?list=cart&context=public")
        self.assertEqual(dashboard["items"], [])
        with urllib.request.urlopen(self.base + "/api/export?list=cart") as response:
            self.assertTrue(response.read().startswith(b"\xef\xbb\xbf"))


if __name__ == "__main__":
    unittest.main()
