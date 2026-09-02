"""The shapes a route handler receives and returns.

This module imports nothing from the rest of J-ong on purpose. Modules need Response and
the HTTP layer needs Response, and if either owned it the two would import each other.
"""
import json


class Error(Exception):
    """Raised by a handler to answer with a status and a message rather than a stack trace."""

    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status


class Response:
    """Anything that is not a plain JSON body: files, streams, redirects, no content."""

    def __init__(self, status=200, body=b"", content_type="application/octet-stream",
                 headers=None, stream=None, length=None, path=None):
        self.status = status
        self.body = body
        self.content_type = content_type
        self.headers = headers or {}
        self.stream = stream          # a file object, read in chunks and closed after
        self.length = length
        # A path is served by the HTTP layer rather than read here, so that seeking in a
        # long render is a byte range rather than a fresh download of the whole file.
        self.path = path


class Request:
    def __init__(self, method, path, query, headers, rfile, params=None):
        self.method = method
        self.path = path
        self.query = query            # dict of str -> str, last value wins
        self.headers = headers
        self.rfile = rfile
        self.params = params or {}    # captured path segments

    def json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise Error("that request body is not JSON")
        if not isinstance(value, dict):
            raise Error("expected a JSON object")
        return value

    def q(self, name, default=None):
        return self.query.get(name, default)

    def q_int(self, name, default=None):
        raw = self.query.get(name)
        if raw is None or raw == "":
            return default
        try:
            return int(raw)
        except ValueError:
            raise Error("%s must be a whole number" % name)


def as_int(value, field, minimum=None):
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise Error("%s must be a whole number" % field)
    if minimum is not None and number < minimum:
        raise Error("%s must be at least %d" % (field, minimum))
    return number


def need(data, *fields):
    """Pull required fields out of a JSON body, complaining by name rather than KeyError."""
    out = []
    for field in fields:
        value = data.get(field)
        if value is None or (isinstance(value, str) and not value.strip()):
            raise Error("%s is required" % field)
        out.append(value.strip() if isinstance(value, str) else value)
    return out[0] if len(out) == 1 else out
