"""The HTTP layer: routing, static files, and byte ranges for audio.

The CSS and JS directories are concatenated in filename order into /jong.css and
/jong.js, which is why the front end can be split into a file per feature with no build
step and no import graph to maintain. Delete a file from web/js and that feature stops
being served, which is the browser side of the same swappability the module registry
gives the server.
"""
import io
import os
import sys
import json
import time
import hashlib
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import config, registry
from .wire import Request, Response, Error

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".txt": "text/plain; charset=utf-8",
}

CHUNK = 256 * 1024

#: Errors that only mean the other end went away.
#:
#: A browser cancels a range request every single time the player seeks, and a tab that
#: closes mid download does the same. Windows raises ConnectionAbortedError for this
#: where other systems raise ConnectionResetError, which is why catching the other two
#: was not enough: every seek in a long render printed a full stack trace, the noise
#: buried real errors, and on the host that output goes through a pipe.
GONE = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)

# Reachable without signing in: the door itself, the stylesheet it wears, and the calls
# the door has to make. Everything else needs a session when the auth module is loaded.
OPEN_PAGES = {"/login", "/jong.css", "/favicon.ico"}
OPEN_API = {"/api/auth/state", "/api/auth/login", "/api/auth/setup", "/api/health",
            # the door wears the same typeface as the library behind it
            "/api/appearance/font"}


def content_type_for(name):
    return CONTENT_TYPES.get(os.path.splitext(name)[1].lower(), "application/octet-stream")


def bundle(directory, ext):
    """Every file in a directory, in filename order, joined into one response.

    Ordering is the numeric prefix on each filename, which is how a plain directory gets
    a dependency order without a module system.
    """
    parts = []
    try:
        names = sorted(n for n in os.listdir(directory) if n.endswith(ext))
    except OSError:
        return b""
    for name in names:
        with open(os.path.join(directory, name), "rb") as f:
            parts.append(b"/* " + name.encode() + b" */\n" + f.read())
    return b"\n\n".join(parts)


def _match(pattern, path):
    """Match /api/songs/<id>/versions against a real path, returning captures or None."""
    if "<" not in pattern:
        return {} if pattern == path else None
    want = pattern.strip("/").split("/")
    got = path.strip("/").split("/")
    if len(want) != len(got):
        return None
    params = {}
    for w, g in zip(want, got):
        if w.startswith("<") and w.endswith(">"):
            params[w[1:-1]] = urllib.parse.unquote(g)
        elif w != g:
            return None
    return params


def resolve(method, path):
    """Find the handler for a request. Exact routes win over patterned ones."""
    table = registry.routes()
    handler = table.get((method, path))
    if handler:
        return handler, {}
    for (route_method, pattern), fn in table.items():
        if route_method != method:
            continue
        params = _match(pattern, path)
        if params is not None:
            return fn, params
    return None, {}


class Body:
    """The request body, which remembers how much of it has been read.

    Whether a handler reads the body is the handler's business. What is not is leaving
    unread bytes in the socket: this server speaks HTTP/1.1, so a browser reuses one
    connection for many requests, and anything left over gets parsed as the start of the
    next one. The browser is then told 501 for a request it made perfectly well, at a
    moment that has nothing to do with the request that actually caused it.

    Most routes hit this. "Put this render back", "make this version current" and
    "delete this song" are all sent with a JSON body by the browser and have no reason
    to read it.
    """

    #: Worth draining to keep a connection alive. Past this, closing beats reading a
    #: refused upload all the way to the end out of politeness.
    DRAIN_LIMIT = 1024 * 1024

    def __init__(self, rfile, length):
        self._rfile = rfile
        self.remaining = max(0, length)

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        if size is None or size < 0:
            size = self.remaining
        chunk = self._rfile.read(min(size, self.remaining))
        self.remaining -= len(chunk)
        return chunk

    def readline(self, size=-1):
        if self.remaining <= 0:
            return b""
        limit = self.remaining if size is None or size < 0 else min(size, self.remaining)
        line = self._rfile.readline(limit)
        self.remaining -= len(line)
        return line

    def finish(self):
        """Swallow whatever is left. False means the connection has to be closed."""
        if self.remaining <= 0:
            return True
        if self.remaining > self.DRAIN_LIMIT:
            return False
        while self.remaining > 0:
            chunk = self._rfile.read(min(CHUNK, self.remaining))
            if not chunk:
                return False
            self.remaining -= len(chunk)
        return True


class Handler(BaseHTTPRequestHandler):
    server_version = "J-ong"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # the access log is noise for a single user tool

    # ── replies ──────────────────────────────────────────────────────────────
    def _send(self, status, body, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        try:
            self.end_headers()
            if self.command != "HEAD" and body:
                self.wfile.write(body)
        except GONE:
            self.close_connection = True

    def _etag_hit(self, etag):
        """Answer 304 when the caller already holds exactly this body.

        Revalidation rather than a long max-age. A document cached for a day means an
        update lands on disk and the browser keeps showing yesterday's page, which is a
        very confusing way to ship a fix.
        """
        if self.headers.get("If-None-Match") != etag:
            return False
        self.send_response(304)
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _json(self, data, status=200):
        body = json.dumps(data, default=str).encode("utf-8")
        self._send(status, body, "application/json", {"Cache-Control": "no-store"})

    def _file(self, path, content_type=None, download_name=None):
        """Serve a file, honouring Range so the player can seek without refetching."""
        try:
            stat = os.stat(path)
            size = stat.st_size
        except OSError:
            return self._json({"error": "not found"}, 404)
        ctype = content_type or content_type_for(path)

        # A page revalidates; audio and artwork are reached through an id that can never
        # come to mean different bytes, so those may be held.
        is_document = os.path.splitext(path)[1].lower() in (".html", ".htm")
        etag = '"%x-%x"' % (int(stat.st_mtime), size)
        if is_document and self._etag_hit(etag):
            return
        extra = {
            "Accept-Ranges": "bytes",
            "ETag": etag,
            "Cache-Control": "no-cache" if is_document else "private, max-age=86400, immutable",
        }
        if download_name:
            extra["Content-Disposition"] = 'attachment; filename="%s"' % download_name

        start, end = 0, size - 1
        status = 200
        header = self.headers.get("Range")
        if header and header.startswith("bytes="):
            spec = header[6:].split(",")[0].strip()
            first, _, last = spec.partition("-")
            try:
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                elif last:
                    # A suffix range: the last N bytes.
                    start = max(0, size - int(last))
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206
                extra["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)
            except ValueError:
                start, end, status = 0, size - 1, 200

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(length))
        for key, value in extra.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                try:
                    self.wfile.write(chunk)
                except GONE:
                    return  # the player seeked away or the tab closed

    # ── verbs ────────────────────────────────────────────────────────────────
    def _serve(self, method):
        """Handle one request and leave the connection fit for the next one."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        self.body = Body(self.rfile, length)
        try:
            self._dispatch(method)
        finally:
            try:
                if not self.body.finish():
                    self.close_connection = True
            except GONE:
                self.close_connection = True

    def do_GET(self):
        self._serve("GET")

    def do_HEAD(self):
        self._serve("GET")

    def do_POST(self):
        self._serve("POST")

    def do_PUT(self):
        self._serve("PUT")

    def do_PATCH(self):
        self._serve("PATCH")

    def do_DELETE(self):
        self._serve("DELETE")

    def _locked_out(self, path):
        """Is this request allowed through the door.

        With the auth module switched off there is no door at all, which is what makes a
        purely local install as simple as running the script.
        """
        if not registry.has("auth"):
            return False
        if path in OPEN_PAGES or path in OPEN_API:
            return False
        from .modules import auth
        return not auth.signed_in(self.headers)

    def _dispatch(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = {k: v[-1] for k, v in urllib.parse.parse_qs(parsed.query).items()}

        if self._locked_out(path):
            if path.startswith("/api/"):
                return self._json({"error": "Sign in to use this library."}, 401)
            self.send_response(303)
            self.send_header("Location", "/login")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path.startswith("/api/"):
            return self._api(method, path, query)
        if method != "GET":
            return self._json({"error": "not found"}, 404)
        return self._static(path)

    def _api(self, method, path, query):
        handler, params = resolve(method, path)
        if not handler:
            return self._json({"error": "no such endpoint", "path": path}, 404)
        request = Request(method, path, query, self.headers,
                          getattr(self, "body", self.rfile), params)
        # Used only to tell one guesser from another when rate limiting.
        request.client = self.client_address[0] if self.client_address else "local"
        try:
            result = handler(request)
        except Error as e:
            return self._json({"error": e.message}, e.status)
        except Exception as e:
            # The message is worth more than a 500 with nothing in it, and this server
            # only ever listens to one person.
            return self._json({"error": "%s: %s" % (type(e).__name__, e)}, 500)

        if isinstance(result, Response):
            if getattr(result, "path", None):
                return self._file(result.path, result.content_type,
                                  result.headers.pop("download", None))
            if result.stream is not None:
                self.send_response(result.status)
                self.send_header("Content-Type", result.content_type)
                if result.length is not None:
                    self.send_header("Content-Length", str(result.length))
                for key, value in result.headers.items():
                    self.send_header(key, value)
                self.end_headers()
                try:
                    while True:
                        chunk = result.stream.read(CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                finally:
                    result.stream.close()
                return
            return self._send(result.status, result.body, result.content_type, result.headers)
        if result is None:
            return self._json({"ok": True})
        return self._json(result)

    def _static(self, path):
        for name, directory, ext in (("/jong.css", "css", ".css"),
                                     ("/jong.js", "js", ".js")):
            if path != name:
                continue
            body = bundle(os.path.join(config.WEB, directory), ext)
            # The tag is the content, so an unchanged bundle costs one small round trip
            # and a changed one is picked up immediately.
            etag = '"%s"' % hashlib.sha256(body).hexdigest()[:16]
            if self._etag_hit(etag):
                return
            return self._send(200, body, CONTENT_TYPES[ext],
                              {"Cache-Control": "no-cache", "ETag": etag})

        if path == "/login":
            return self._file(os.path.join(config.WEB, "login.html"))
        rel = "index.html" if path == "/" else path.lstrip("/")
        full = os.path.normpath(os.path.join(config.WEB, rel))
        if not full.startswith(config.WEB):
            return self._json({"error": "not found"}, 404)
        if os.path.isfile(full):
            return self._file(full)
        # Unknown paths are client side routes, so hand back the app and let it decide.
        index = os.path.join(config.WEB, "index.html")
        if os.path.isfile(index):
            return self._file(index)
        return self._json({"error": "not found"}, 404)


class Server(ThreadingHTTPServer):
    """The socket server, quiet about disconnections.

    socketserver prints a full traceback for every exception a handler raises, including
    the ones that only mean a browser went away. Seeking around a forty megabyte render
    produced pages of them, which is slow in itself and hides anything that matters.
    """

    daemon_threads = True
    #: Otherwise a restart during development hits "address already in use" for a minute.
    allow_reuse_address = True

    def handle_error(self, request, client_address):
        kind = sys.exc_info()[0]
        if kind is not None and issubclass(kind, GONE):
            return
        super().handle_error(request, client_address)


def serve(host=None, port=None):
    config.ensure_dirs()
    registry.load()
    return Server((host or config.HOST, port or config.PORT), Handler)
