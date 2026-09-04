"""Which version of a song went up, where it lives, and getting it there.

Two halves. The first is a record: which version you published, so that six renders later
you can still tell what is actually online, which is not recoverable from anywhere else.

The second is the upload itself, and it is worth being exact about what it can and cannot
do. Uploading acts as you, so it needs an OAuth client that belongs to you: there is no
way to ship one inside an app, and a client secret in a public repository is a secret in
name only. You make a Google Cloud project, switch on the YouTube Data API, and paste the
two values in. They are stored on your own server.

The sign in is the device flow, the one a television uses: a short code you type into
google.com on any device. That is deliberate. The ordinary browser flow needs a redirect
address registered in advance, and this library is reached at a different address
depending on whether you are at the machine, on the tailnet, or on a phone through the
funnel. A flow with no redirect works from all three.

One limit that is Google's and not ours, and which cannot be worked around: until they
have audited your project, everything it uploads is forced to private whatever you ask
for. Uploads still work; they are just not public until the audit.
"""
import os
import json
import time
import urllib.error
import urllib.parse
import urllib.request

from .. import db, config, blobs
from ..wire import Error, need
from . import songs

#: Google's endpoints. The device flow, then the token, then the upload.
DEVICE_URL = "https://oauth2.googleapis.com/device/code"
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = ("https://www.googleapis.com/upload/youtube/v3/videos"
              "?uploadType=resumable&part=snippet,status")
CHANNEL_URL = "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true"

#: The narrowest scope that can upload. Not youtube.force-ssl, which can also delete.
SCOPE = "https://www.googleapis.com/auth/youtube.upload"

#: Where the account lives. Beside the library rather than in it, because it is a
#: credential: a database that gets copied about for a backup should not carry one.
def _account_path():
    return os.path.join(config.DATA, "youtube.json")

NAME = "youtube"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS youtube_posts (
      id         INTEGER PRIMARY KEY,
      song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      version_id INTEGER,
      url        TEXT NOT NULL DEFAULT '',
      title      TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'published',
      note       TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS youtube_song ON youtube_posts(song_id)",
]

STATUSES = ("draft", "scheduled", "published", "private", "removed")


def get(post_id):
    row = db.one("SELECT * FROM youtube_posts WHERE id = ?", (post_id,))
    if not row:
        raise Error("no YouTube entry with id %s" % post_id, 404)
    return row


def _decorate(rows):
    from .. import registry
    if not registry.has("versions"):
        return rows
    for row in rows:
        if not row["version_id"]:
            row["version_n"] = None
            continue
        version = db.one("SELECT n FROM versions WHERE id = ?", (row["version_id"],))
        # A version can be deleted after it was published, and the entry should say so
        # rather than quietly showing nothing.
        row["version_n"] = version["n"] if version else None
        row["version_missing"] = version is None
    return rows


def list_posts(req):
    song = songs.get(req.params["id"])
    rows = db.query("SELECT * FROM youtube_posts WHERE song_id = ? ORDER BY id DESC",
                    (song["id"],))
    return {"posts": _decorate(rows)}


def create_post(req):
    song = songs.get(req.params["id"])
    data = req.json()
    status = data.get("status", "published")
    if status not in STATUSES:
        raise Error("status must be one of: " + ", ".join(STATUSES))
    now = time.time()
    post_id = db.insert("youtube_posts", {
        "song_id": song["id"], "version_id": data.get("version_id"),
        "url": (data.get("url") or "").strip(), "title": (data.get("title") or "").strip(),
        "status": status, "note": data.get("note", ""),
        "created_at": now, "updated_at": now})
    songs.touch(song["id"])
    return {"post": _decorate([get(post_id)])[0]}


def update_post(req):
    post = get(req.params["id"])
    data = req.json()
    patch = {}
    for field in ("url", "title", "note"):
        if field in data:
            patch[field] = (data[field] or "").strip()
    if "version_id" in data:
        patch["version_id"] = data["version_id"]
    if "status" in data:
        if data["status"] not in STATUSES:
            raise Error("status must be one of: " + ", ".join(STATUSES))
        patch["status"] = data["status"]
    patch["updated_at"] = time.time()
    db.update("youtube_posts", post["id"], patch)
    return {"post": _decorate([get(post["id"])])[0]}


def delete_post(req):
    post = get(req.params["id"])
    db.run("DELETE FROM youtube_posts WHERE id = ?", (post["id"],))
    return {"deleted": post["id"]}


# ── the account ──────────────────────────────────────────────────────────────

def _account(default=None):
    try:
        with open(_account_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return dict(default or {})


def _save_account(data):
    path = _account_path()
    config.ensure_dirs()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _post_form(url, fields):
    body = urllib.parse.urlencode(fields).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        try:
            said = json.loads(detail)
        except ValueError:
            said = {"error": detail[:200]}
        # Google's "still waiting" is an HTTP error, not an answer, so it is handed back
        # rather than raised: the caller is polling and this is the normal case.
        said["_status"] = e.code
        return said
    except urllib.error.URLError as e:
        raise Error("Google could not be reached: %s" % e.reason, 502)


def account_state(req):
    """Whether an account is connected, without ever handing back the credential."""
    held = _account()
    return {"connected": bool(held.get("refresh_token")),
            "channel": held.get("channel"),
            "connected_at": held.get("connected_at"),
            # Said here as well as on the page, because it changes what "public" means.
            "unaudited": True}


def connect(req):
    """Start the sign in. Returns the code to type into google.com."""
    data = req.json()
    client_id = need(data, "client_id").strip()
    client_secret = need(data, "client_secret").strip()

    said = _post_form(DEVICE_URL, {"client_id": client_id, "scope": SCOPE})
    if "device_code" not in said:
        raise Error("Google refused those credentials: %s"
                    % said.get("error_description") or said.get("error", "no reason given"))

    # Kept only until the sign in finishes or is abandoned.
    _save_account({"client_id": client_id, "client_secret": client_secret,
                   "device_code": said["device_code"], "started_at": time.time(),
                   "interval": said.get("interval", 5)})
    return {"user_code": said.get("user_code"),
            "verification_url": said.get("verification_url")
                                or said.get("verification_uri"),
            "expires_in": said.get("expires_in", 900)}


def finish(req):
    """Exchange the device code for a refresh token, once the person has typed it in."""
    held = _account()
    if not held.get("device_code"):
        raise Error("Nothing is waiting to be connected. Start again.")

    said = _post_form(TOKEN_URL, {
        "client_id": held["client_id"], "client_secret": held["client_secret"],
        "device_code": held["device_code"],
        "grant_type": "urn:ietf:params:oauth:grant-type:device_code"})

    if said.get("error") == "authorization_pending":
        raise Error("Google has not seen the code yet. Enter it, then try again.", 409)
    if "refresh_token" not in said:
        raise Error("That did not complete: %s"
                    % (said.get("error_description") or said.get("error", "no reason")))

    held.pop("device_code", None)
    held["refresh_token"] = said["refresh_token"]
    held["access_token"] = said.get("access_token")
    held["expires_at"] = time.time() + said.get("expires_in", 3600) - 60
    held["connected_at"] = time.time()
    held["channel"] = _channel_name(held.get("access_token"))
    _save_account(held)
    return {"connected": True, "channel": held.get("channel")}


def _channel_name(access_token):
    if not access_token:
        return None
    request = urllib.request.Request(CHANNEL_URL, headers={
        "Authorization": "Bearer " + access_token})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            items = json.loads(response.read().decode("utf-8")).get("items") or []
        return items[0]["snippet"]["title"] if items else None
    except Exception:
        return None          # a name is a nicety; not having it is not a failure


def _access_token():
    """A live token, refreshed if the one we hold has expired."""
    held = _account()
    if not held.get("refresh_token"):
        raise Error("No YouTube account is connected.", 409)
    if held.get("access_token") and held.get("expires_at", 0) > time.time():
        return held["access_token"]

    said = _post_form(TOKEN_URL, {
        "client_id": held["client_id"], "client_secret": held["client_secret"],
        "refresh_token": held["refresh_token"], "grant_type": "refresh_token"})
    if "access_token" not in said:
        raise Error("The YouTube account needs connecting again: %s"
                    % (said.get("error_description") or said.get("error", "no reason")), 401)
    held["access_token"] = said["access_token"]
    held["expires_at"] = time.time() + said.get("expires_in", 3600) - 60
    _save_account(held)
    return held["access_token"]


def disconnect(req):
    """Forget the account. Nothing already uploaded is touched."""
    try:
        os.remove(_account_path())
    except OSError:
        pass
    return {"connected": False}


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM youtube_posts WHERE status = 'published'")
    return {"published": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs/<id>/youtube"): list_posts,
        ("POST", "/api/songs/<id>/youtube"): create_post,
        ("PATCH", "/api/youtube/<id>"): update_post,
        ("DELETE", "/api/youtube/<id>"): delete_post,
        ("GET", "/api/youtube/account"): account_state,
        ("POST", "/api/youtube/connect"): connect,
        ("POST", "/api/youtube/finish"): finish,
        ("DELETE", "/api/youtube/account"): disconnect,
    }
