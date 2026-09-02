"""One password, and a door.

There are no rules about what the password may be. Length limits, character classes and
"must contain a symbol" mostly push people towards one bad password reused everywhere,
and this library has exactly one user who already knows what it is worth.

What guards it instead is a limit on guessing. An attacker who gets six attempts a minute
cannot brute force even a short password, and a rate limit costs the person who knows it
nothing. That is the trade this module makes: no rules about the secret, hard limits on
attempts.

The password is never stored. It is put through scrypt, which is deliberately slow and
memory hungry, and only the result is kept.
"""
import os
import json
import time
import hmac
import base64
import hashlib
import secrets
import threading

from .. import config
from ..wire import Error, Response

NAME = "auth"
SCHEMA = []

AUTH_PATH = os.path.join(config.DATA, "auth.json")
SETUP_PATH = os.path.join(config.DATA, "setup-code.txt")
COOKIE = "jong_session"
SESSION_DAYS = 30

# scrypt at these settings takes roughly a tenth of a second, which is nothing once a day
# and a wall to anyone working through a list.
SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1, "dklen": 32}

# Guessing limits. Six wrong answers and that address waits, for longer each time.
FREE_TRIES = 6
LOCKOUTS = (30, 120, 600, 1800, 3600)
WINDOW = 900

_lock = threading.Lock()
_attempts = {}          # ip -> {"fails": int, "since": float, "until": float, "level": int}


# ── the stored secret ────────────────────────────────────────────────────────
def _paths():
    """Read from config at call time, so tests pointing DATA elsewhere are honoured."""
    return (os.path.join(config.DATA, "auth.json"),
            os.path.join(config.DATA, "setup-code.txt"))


def _read():
    path, _ = _paths()
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _write(data):
    path, _ = _paths()
    config.ensure_dirs()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    try:
        # Best effort on Windows: keep it readable only by this account.
        os.chmod(path, 0o600)
    except OSError:
        pass


def has_password():
    return bool(_read().get("hash"))


def _hash(password, salt):
    return base64.b64encode(hashlib.scrypt(
        password.encode("utf-8"), salt=salt, **SCRYPT)).decode()


def set_password(password):
    """Any password at all, so long as there is one. Empty is not a password."""
    if not isinstance(password, str) or not password:
        raise Error("Type a password. Anything you like, but not nothing.")
    salt = secrets.token_bytes(16)
    data = _read()
    data.update({
        "salt": base64.b64encode(salt).decode(),
        "hash": _hash(password, salt),
        "secret": data.get("secret") or base64.b64encode(secrets.token_bytes(32)).decode(),
        "set_at": time.time(),
    })
    _write(data)
    # The setup code is spent the moment a password exists.
    _, setup_path = _paths()
    try:
        os.remove(setup_path)
    except OSError:
        pass
    return True


def check_password(password):
    data = _read()
    if not data.get("hash"):
        return False
    salt = base64.b64decode(data["salt"])
    return hmac.compare_digest(_hash(password or "", salt), data["hash"])


# ── the one time setup code ──────────────────────────────────────────────────
def setup_code():
    """A code that has to be presented to set the first password.

    Without it, the first stranger to find a freshly deployed J-ong could choose the
    password and lock the owner out. It is written next to the library and printed at
    startup, so it is available to whoever can already reach the machine, and it stops
    existing as soon as a password is set.
    """
    _, path = _paths()
    if has_password():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            code = f.read().strip()
            if code:
                return code
    except OSError:
        pass
    code = "-".join(secrets.token_hex(2) for _ in range(3))
    config.ensure_dirs()
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    return code


# ── sessions ─────────────────────────────────────────────────────────────────
def _secret():
    data = _read()
    if not data.get("secret"):
        data["secret"] = base64.b64encode(secrets.token_bytes(32)).decode()
        _write(data)
    return base64.b64decode(data["secret"])


def issue():
    """A signed cookie value: when it was made, and proof we made it."""
    issued = str(int(time.time()))
    nonce = secrets.token_hex(8)
    body = "%s.%s" % (issued, nonce)
    signature = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    return "%s.%s" % (body, signature)


def valid(token):
    if not token or token.count(".") != 2:
        return False
    issued, nonce, signature = token.split(".")
    body = "%s.%s" % (issued, nonce)
    expected = hmac.new(_secret(), body.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        age = time.time() - int(issued)
    except ValueError:
        return False
    return 0 <= age <= SESSION_DAYS * 86400


def signed_in(headers):
    if not has_password():
        return False
    raw = headers.get("Cookie") or ""
    for part in raw.split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE and valid(value):
            return True
    return False


def sign_out_everywhere():
    """Rotating the secret invalidates every cookie that was ever issued."""
    data = _read()
    data["secret"] = base64.b64encode(secrets.token_bytes(32)).decode()
    _write(data)


# ── guessing limits ──────────────────────────────────────────────────────────
def _who(req):
    # Behind Tailscale Funnel the real caller is in a forwarded header. Falling back to
    # the socket address keeps this working when it is reached directly.
    forwarded = req.headers.get("X-Forwarded-For") or ""
    if forwarded:
        return forwarded.split(",")[0].strip()
    return req.headers.get("X-Real-IP") or getattr(req, "client", "") or "local"


def _wait_for(ip):
    with _lock:
        entry = _attempts.get(ip)
        if not entry:
            return 0
        if entry["until"] > time.time():
            return int(entry["until"] - time.time())
        return 0


def _note_failure(ip):
    with _lock:
        now = time.time()
        entry = _attempts.get(ip)
        if not entry or now - entry["since"] > WINDOW:
            entry = {"fails": 0, "since": now, "until": 0, "level": 0}
        entry["fails"] += 1
        entry["since"] = now
        if entry["fails"] > FREE_TRIES:
            wait = LOCKOUTS[min(entry["level"], len(LOCKOUTS) - 1)]
            entry["until"] = now + wait
            entry["level"] += 1
            entry["fails"] = 0
        _attempts[ip] = entry


def _clear(ip):
    with _lock:
        _attempts.pop(ip, None)


def _cookie_header(req, value, days):
    secure = ""
    proto = (req.headers.get("X-Forwarded-Proto") or "").lower()
    if proto == "https":
        secure = " Secure;"
    age = days * 86400
    return ("%s=%s; Path=/; HttpOnly; SameSite=Lax;%s Max-Age=%d"
            % (COOKIE, value, secure, age))


# ── endpoints ────────────────────────────────────────────────────────────────
def state(req):
    return {
        "has_password": has_password(),
        "signed_in": signed_in(req.headers),
        "locked_for": _wait_for(_who(req)),
    }


def setup(req):
    """Choose the first password. Needs the setup code, and only works once."""
    if has_password():
        raise Error("A password is already set on this library.", 409)
    data = req.json()
    code = setup_code()
    given = (data.get("code") or "").strip()
    if not given or not hmac.compare_digest(given, code or ""):
        _note_failure(_who(req))
        raise Error("That setup code is not right.", 403)
    set_password(data.get("password") or "")
    _clear(_who(req))
    return Response(status=200, body=b'{"ok":true}', content_type="application/json",
                    headers={"Set-Cookie": _cookie_header(req, issue(), SESSION_DAYS)})


def login(req):
    ip = _who(req)
    wait = _wait_for(ip)
    if wait:
        raise Error("Too many attempts. Try again in %d seconds." % wait, 429)
    if not has_password():
        raise Error("No password is set on this library yet.", 409)
    if not check_password(req.json().get("password") or ""):
        _note_failure(ip)
        again = _wait_for(ip)
        raise Error("That is not the password."
                    + (" Too many attempts, wait %d seconds." % again if again else ""), 401)
    _clear(ip)
    return Response(status=200, body=b'{"ok":true}', content_type="application/json",
                    headers={"Set-Cookie": _cookie_header(req, issue(), SESSION_DAYS)})


def logout(req):
    return Response(status=200, body=b'{"ok":true}', content_type="application/json",
                    headers={"Set-Cookie": "%s=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
                                           % COOKIE})


def change(req):
    if not signed_in(req.headers):
        raise Error("Sign in first.", 401)
    data = req.json()
    if not check_password(data.get("current") or ""):
        _note_failure(_who(req))
        raise Error("That is not the current password.", 401)
    set_password(data.get("new") or "")
    sign_out_everywhere()
    return Response(status=200, body=b'{"ok":true,"signed_out":true}',
                    content_type="application/json",
                    headers={"Set-Cookie": _cookie_header(req, issue(), SESSION_DAYS)})


def SUMMARY():
    return {"protected": has_password()}


def ROUTES():
    return {
        ("GET", "/api/auth/state"): state,
        ("POST", "/api/auth/setup"): setup,
        ("POST", "/api/auth/login"): login,
        ("POST", "/api/auth/logout"): logout,
        ("POST", "/api/auth/password"): change,
    }
