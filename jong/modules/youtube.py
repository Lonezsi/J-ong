"""Which version of a song went up, and where it lives.

J-ong does not upload to YouTube. It records that you did, against the exact version you
published, so that six renders later you can still tell what is actually online.
"""
import time

from .. import db
from ..wire import Error, need
from . import songs

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


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM youtube_posts WHERE status = 'published'")
    return {"published": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs/<id>/youtube"): list_posts,
        ("POST", "/api/songs/<id>/youtube"): create_post,
        ("PATCH", "/api/youtube/<id>"): update_post,
        ("DELETE", "/api/youtube/<id>"): delete_post,
    }
