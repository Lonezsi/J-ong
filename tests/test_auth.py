"""The door.

Two rules pull against each other here and both are deliberate. Any password is allowed,
because rules about characters mostly produce one bad password reused everywhere. And
guessing is capped hard, because that is what actually makes a short password survive
being on the public internet.
"""
import os
import time

import pytest

from jong import config, registry
from jong.modules import auth


@pytest.fixture
def secured(server):
    """The same live server, with the door loaded and the guess counter empty."""
    registry.load(config.MODULES)
    auth._attempts.clear()
    yield server
    registry.load([m for m in config.MODULES if m != "auth"])


def _sign_in(client, password):
    """Sign in and return the cookie header to send with later requests."""
    import urllib.request
    import json
    data = json.dumps({"password": password}).encode()
    request = urllib.request.Request(client.base + "/api/auth/login", data=data,
                                     method="POST",
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=10) as response:
        return response.headers.get("Set-Cookie", "").split(";")[0]


# ── choosing the first password ──────────────────────────────────────────────
def test_a_fresh_library_has_no_password_and_offers_a_setup_code(secured):
    status, state = secured.get("/api/auth/state")
    assert status == 200
    assert state["has_password"] is False
    assert auth.setup_code(), "no setup code was written"


def test_the_setup_code_is_needed_to_choose_the_first_password(secured):
    """Without this, the first stranger to find a public J-ong picks the password and
    locks the owner out of their own library."""
    status, answer = secured.post("/api/auth/setup",
                                  {"code": "not-the-code", "password": "whatever"})
    assert status == 403
    assert auth.has_password() is False


def test_the_right_code_sets_the_password_and_signs_you_in(secured):
    code = auth.setup_code()
    status, _ = secured.post("/api/auth/setup", {"code": code, "password": "a"})
    assert status == 200
    assert auth.has_password() is True
    _, state = secured.get("/api/auth/state")
    assert state["has_password"] is True


def test_the_setup_code_is_spent_once_a_password_exists(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    _, setup_path = auth._paths()
    assert not os.path.exists(setup_path), "the setup code outlived its use"
    status, answer = secured.post("/api/auth/setup", {"code": code, "password": "other"})
    assert status == 409


# ── any password at all ──────────────────────────────────────────────────────
@pytest.mark.parametrize("password", [
    "a", "1", "  ", "password", "12345678",
    "sörét",                       # not ascii
    "a" * 500,                     # very long
    "' OR 1=1 --",                 # would be a problem if it were ever put in a query
    "🎧",                          # outside the basic plane
])
def test_any_password_is_accepted(secured, password):
    """No length rule, no character classes, no "must contain a number". The limit on
    guessing is what does the work instead."""
    code = auth.setup_code()
    status, _ = secured.post("/api/auth/setup", {"code": code, "password": password})
    assert status == 200, "%r was refused" % password
    assert auth.check_password(password) is True
    assert auth.check_password(password + "x") is False


def test_an_empty_password_is_not_a_password(secured):
    code = auth.setup_code()
    status, answer = secured.post("/api/auth/setup", {"code": code, "password": ""})
    assert status == 400
    assert "not nothing" in answer["error"]


def test_the_password_itself_is_never_stored(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "hunter2"})
    path, _ = auth._paths()
    with open(path, encoding="utf-8") as f:
        stored = f.read()
    assert "hunter2" not in stored, "the password is sitting on disk in the clear"
    assert "salt" in stored and "hash" in stored


def test_the_same_password_hashes_differently_in_two_libraries(secured, tmp_path):
    """A salt per library, so one leaked file says nothing about another."""
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "same"})
    first = auth._read()["hash"]
    auth.set_password("same")
    assert auth._read()["hash"] != first


# ── the gate ─────────────────────────────────────────────────────────────────
def test_nothing_is_reachable_before_signing_in(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    # A brand new client has no cookie.
    status, answer = secured.get("/api/songs")
    assert status == 401
    assert "Sign in" in answer["error"]


def test_the_door_and_its_stylesheet_stay_open(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    assert secured.get("/login")[0] == 200
    assert secured.get("/jong.css")[0] == 200
    assert secured.get("/api/auth/state")[0] == 200


def test_a_signed_in_request_gets_through(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    cookie = _sign_in(secured, "a")
    status, answer = secured.request("GET", "/api/songs", headers={"Cookie": cookie})
    assert status == 200
    assert "songs" in answer


def test_a_forged_cookie_does_not_get_through(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    forged = "%s=%d.deadbeef.%s" % (auth.COOKIE, int(time.time()), "0" * 32)
    status, _ = secured.request("GET", "/api/songs", headers={"Cookie": forged})
    assert status == 401


def test_an_expired_cookie_does_not_get_through(secured, monkeypatch):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    old = auth.issue()
    monkeypatch.setattr(time, "time", lambda: time.__dict__["time"]() if False else 9e9)
    assert auth.valid(old) is False


def test_changing_the_password_signs_every_device_out(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    cookie = _sign_in(secured, "a")
    assert secured.request("GET", "/api/songs", headers={"Cookie": cookie})[0] == 200

    status, _ = secured.request("POST", "/api/auth/password",
                                {"current": "a", "new": "b"},
                                headers={"Cookie": cookie})
    assert status == 200
    assert secured.request("GET", "/api/songs", headers={"Cookie": cookie})[0] == 401
    assert auth.check_password("b") is True


def test_the_gate_is_gone_when_the_module_is(server):
    """A local only install has no door, which is what makes running the script enough."""
    registry.load([m for m in config.MODULES if m != "auth"])
    assert server.get("/api/songs")[0] == 200


# ── the limit that replaces password rules ───────────────────────────────────
def test_guessing_is_capped(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})

    seen_lockout = False
    for attempt in range(auth.FREE_TRIES + 2):
        status, answer = secured.post("/api/auth/login", {"password": "wrong"})
        if status == 429:
            seen_lockout = True
            break
        assert status == 401
    assert seen_lockout, "an attacker got unlimited guesses at a one character password"


def test_the_wait_grows_each_time(secured):
    auth._note_failure_ip = None
    ip = "10.0.0.9"
    for _ in range(auth.FREE_TRIES + 1):
        auth._note_failure(ip)
    first = auth._attempts[ip]["level"]
    auth._attempts[ip]["until"] = 0
    for _ in range(auth.FREE_TRIES + 1):
        auth._note_failure(ip)
    assert auth._attempts[ip]["level"] > first, "the lockout never lengthens"


def test_a_correct_password_clears_the_count(secured):
    code = auth.setup_code()
    secured.post("/api/auth/setup", {"code": code, "password": "a"})
    for _ in range(auth.FREE_TRIES - 1):
        secured.post("/api/auth/login", {"password": "wrong"})
    status, _ = secured.post("/api/auth/login", {"password": "a"})
    assert status == 200
    _, state = secured.get("/api/auth/state")
    assert state["locked_for"] == 0


def test_one_address_being_locked_does_not_lock_another(secured):
    """Rate limiting per address, so somebody else guessing badly cannot keep the owner
    out of their own library."""
    auth._attempts.clear()
    for _ in range(auth.FREE_TRIES + 2):
        auth._note_failure("203.0.113.7")
    assert auth._wait_for("203.0.113.7") > 0
    assert auth._wait_for("198.51.100.4") == 0


def test_a_damaged_auth_file_shuts_the_door_and_is_left_alone(secured):
    """"There is no password yet" and "the password is unreadable" are opposite states,
    and they used to be the same empty dict.

    A missing file is a fresh library that should offer setup. A damaged one belonged to
    somebody, and reading it as fresh means the next write destroys the only copy of
    their password and session secret. On a machine nobody is sitting at, that is the end
    of that library's credentials.

    So it refuses everything, including the login page and the setup flow, and touches
    nothing. Health still answers, so the watchdog can tell this apart from a wedged
    server and does not sit in a restart loop over it.
    """
    import os

    from jong import config
    from jong.modules import auth

    path = os.path.join(config.DATA, "auth.json")
    with open(path, "w", encoding="utf-8") as f:
        f.write('{"hash": "abc", "salt"')          # cut off mid write
    damaged = open(path, "rb").read()

    assert auth.damaged(), "a truncated file should not read as an empty one"

    status, _ = secured.get("/api/songs")
    assert status == 503, "the library answered while it could not check a password"
    status, said = secured.post("/api/auth/setup", {"code": "anything", "password": "hunter2"})
    assert status == 503, "setup would have written over the damaged file"
    status, _ = secured.post("/api/auth/login", {"password": "hunter2"})
    assert status == 503

    assert open(path, "rb").read() == damaged, "the damaged file was written over"

    status, health = secured.get("/api/health")
    assert status == 200, "health must keep answering or the watchdog kills it forever"

    # Repairing it on disk is enough; nothing has to be restarted.
    os.remove(path)
    assert auth.damaged() is None
    status, _ = secured.get("/api/health")
    assert status == 200


def test_a_missing_auth_file_is_still_just_a_fresh_library(secured):
    """The other half of the same distinction: absent is normal and must keep working."""
    import os

    from jong import config
    from jong.modules import auth

    path = os.path.join(config.DATA, "auth.json")
    if os.path.exists(path):
        os.remove(path)
    assert auth.damaged() is None
    assert auth.has_password() is False


# ── a credential for a machine ───────────────────────────────────────────────

def _as_owner(client):
    """Set a password, sign in, and hand back the header that proves it."""
    code = auth.setup_code()
    client.post("/api/auth/setup", {"code": code, "password": "a"})
    return {"Cookie": _sign_in(client, "a")}


def test_a_token_gets_a_machine_in_where_a_session_would_not(secured):
    """The client installs a logon task pointed at a host and held no credential at all,
    so it had been failing on its first request since the day it was installed, silently,
    because cmd_watch swallowed the error. A token is what it carries now."""
    owner = _as_owner(secured)
    status, made = secured.request("POST", "/api/auth/tokens", {"name": "the laptop"},
                                   headers=owner)
    assert status == 200, made
    raw = made["token"]
    assert raw.startswith("jt_")

    status, _ = secured.request("GET", "/api/state")
    assert status == 401, "a caller with no credential should be turned away"

    status, _ = secured.request("GET", "/api/state", headers={"X-Jong-Token": raw})
    assert status == 200, "the token did not open the door"


def test_a_token_cannot_reach_past_what_it_was_made_for(secured):
    """A credential sitting in a plain file on a laptop should not be able to delete a
    song. The scope is checked against the method and the path, so it does not depend on
    the client choosing to behave."""
    owner = _as_owner(secured)
    _, made = secured.request("POST", "/api/auth/tokens", {"name": "the laptop"},
                              headers=owner)
    machine = {"X-Jong-Token": made["token"]}

    _, song = secured.request("POST", "/api/songs", {"title": "Not Yours To Delete"},
                              headers=owner)
    song_id = song["song"]["id"]

    status, _ = secured.request("DELETE", "/api/songs/%d" % song_id, headers=machine)
    assert status == 401, "an upload token deleted a song"

    status, still = secured.request("GET", "/api/songs", headers=machine)
    assert status == 200
    assert any(s["id"] == song_id for s in still["songs"]), "it went anyway"


def test_the_token_itself_is_never_stored(secured):
    """Stored the way the password is: only a digest, so reading the database does not
    hand anybody a working credential."""
    import json as _json

    from jong import db

    owner = _as_owner(secured)
    _, made = secured.request("POST", "/api/auth/tokens", {"name": "the laptop"},
                              headers=owner)

    rows = db.query("SELECT * FROM auth_tokens")
    assert rows, "nothing was written"
    assert made["token"] not in _json.dumps(rows), "the token is in the database in clear"


def test_a_revoked_token_stops_working(secured):
    owner = _as_owner(secured)
    _, made = secured.request("POST", "/api/auth/tokens", {"name": "gone soon"},
                              headers=owner)
    machine = {"X-Jong-Token": made["token"]}
    assert secured.request("GET", "/api/state", headers=machine)[0] == 200

    _, listed = secured.request("GET", "/api/auth/tokens", headers=owner)
    secured.request("DELETE", "/api/auth/tokens/%d" % listed["tokens"][0]["id"],
                    headers=owner)

    assert secured.request("GET", "/api/state", headers=machine)[0] == 401,         "a revoked token still works"


def test_an_upload_token_can_do_everything_the_client_actually_does(secured):
    """The scope was written from memory and left out two routes the watcher calls on
    every pass, so an agent carrying a token got a 401 on its first request and the watch
    loop swallowed it. This walks the client's own source rather than a list somebody
    typed, so the two cannot drift apart again."""
    import os
    import re

    from jong.modules import auth

    client = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                          "client", "jong_client.py")
    source = open(client, encoding="utf-8").read()

    wanted = set(re.findall(r'server\.(?:get|post|upload)\(\s*f?"(/api/[^"?]*)', source))
    # Signing in is how a token is got in the first place, so it is not in scope.
    wanted = {w for w in wanted if not w.startswith("/api/auth/")}
    assert wanted, "the client calls nothing, so this test is reading the wrong shape"

    allowed = {path for _method, path in auth.SCOPES["upload"]}
    missing = sorted(w for w in wanted
                     if w not in allowed and not any(w.startswith(a + "/") for a in allowed))
    assert not missing, "the client calls these and an upload token cannot: %s" % missing
