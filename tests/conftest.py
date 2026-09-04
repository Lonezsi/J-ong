"""Test setup.

JONG_DATA is redirected before anything imports jong, so a test run can never touch a
real library. Getting this wrong once means a test suite that quietly edits the music
you actually care about.
"""
import os
import sys
import tempfile

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

_TMP = tempfile.mkdtemp(prefix="jong-tests-")
os.environ["JONG_DATA"] = _TMP

from jong import config, db, registry  # noqa: E402  (must come after the env var)


@pytest.fixture(autouse=True)
def fresh_library(tmp_path, monkeypatch):
    """Every test gets an empty library on disk and an empty database."""
    data = tmp_path / "data"
    blobs = data / "blobs"
    blobs.mkdir(parents=True)
    monkeypatch.setattr(config, "DATA", str(data))
    monkeypatch.setattr(config, "BLOBS", str(blobs))
    monkeypatch.setattr(config, "DB_PATH", str(data / "jong.db"))
    monkeypatch.setattr(config, "SETTINGS_PATH", str(data / "settings.json"))
    db.close()
    # The door is loaded only by the tests that are about the door. Every other test is
    # about the library itself, and signing in first would say nothing about it.
    registry.load([m for m in config.MODULES if m != "auth"])
    yield
    db.close()
    registry.load([m for m in config.MODULES if m != "auth"])


@pytest.fixture
def wav(tmp_path):
    """A short but real audio file, so probing and uploading are tested against
    something a decoder would actually accept."""
    import wave
    import math
    import struct

    def make(name="take.wav", seconds=1.5, rate=44100, level=0.5):
        path = tmp_path / name
        frames = bytearray()
        for i in range(int(rate * seconds)):
            value = math.sin(2 * math.pi * 220 * (i / rate)) * level
            frames += struct.pack("<h", int(value * 32000))
        with wave.open(str(path), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(frames))
        return str(path)

    return make


@pytest.fixture
def server():
    """This J-ong on a real socket. Yields a small client."""
    import json
    import threading
    import urllib.error
    import urllib.request
    from http.server import ThreadingHTTPServer
    from jong.http import Handler

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    class Client:
        base = "http://127.0.0.1:%d" % port

        def request(self, method, path, payload=None, data=None, headers=None):
            body = data
            head = dict(headers or {})
            if payload is not None:
                body = json.dumps(payload).encode()
                head["Content-Type"] = "application/json"
            request = urllib.request.Request(
                self.base + path, data=body, method=method, headers=head)
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    raw = response.read()
                    kind = response.headers.get("Content-Type", "")
                    if not raw:
                        return response.status, {}
                    if "json" not in kind:
                        # Audio and images come back as bytes. Parsing them as JSON was
                        # a UnicodeDecodeError dressed up as a failing assertion.
                        return response.status, raw
                    return response.status, json.loads(raw)
            except urllib.error.HTTPError as e:
                raw = e.read()
                try:
                    return e.code, json.loads(raw)
                except ValueError:
                    return e.code, {"raw": raw[:200].decode("utf-8", "ignore")}

        def get(self, path):
            return self.request("GET", path)

        def post(self, path, payload=None):
            return self.request("POST", path, payload if payload is not None else {})

        def put(self, path, payload):
            return self.request("PUT", path, payload)

        def patch(self, path, payload):
            return self.request("PATCH", path, payload)

        def delete(self, path):
            return self.request("DELETE", path)

        def upload(self, path, file_path, filename=None, headers=None):
            with open(file_path, "rb") as f:
                blob = f.read()
            head = {
                "Content-Type": "application/octet-stream",
                "X-Filename": filename or os.path.basename(file_path),
            }
            # Extras rather than a replacement, so a test can add one header without
            # having to restate the two that every upload needs.
            head.update(headers or {})
            return self.request("POST", path, data=blob, headers=head)

    try:
        yield Client()
    finally:
        srv.shutdown()
        srv.server_close()
