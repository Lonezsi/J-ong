"""Lyrics, their alternatives, and the history of each.

A song has several lyric sheets and one of them is current. Each sheet keeps every text
it has ever held, so history belongs to the alternative rather than to the song. Saving
the same words twice does not make a second entry, because a history full of identical
snapshots is worse than no history.
"""
import time

from .. import db
from ..wire import Error, need
from . import songs

NAME = "lyrics"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS lyric_sheets (
      id         INTEGER PRIMARY KEY,
      song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      name       TEXT NOT NULL DEFAULT 'Alternative',
      position   INTEGER NOT NULL DEFAULT 0,
      is_current INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS lyric_revisions (
      id         INTEGER PRIMARY KEY,
      sheet_id   INTEGER NOT NULL REFERENCES lyric_sheets(id) ON DELETE CASCADE,
      text       TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS sheets_song ON lyric_sheets(song_id, position)",
    "CREATE INDEX IF NOT EXISTS revisions_sheet ON lyric_revisions(sheet_id, id DESC)",
]


def get_sheet(sheet_id):
    row = db.one("SELECT * FROM lyric_sheets WHERE id = ?", (sheet_id,))
    if not row:
        raise Error("no lyric alternative with id %s" % sheet_id, 404)
    return row


def _latest(sheet_id):
    return db.one("SELECT * FROM lyric_revisions WHERE sheet_id = ? ORDER BY id DESC LIMIT 1",
                  (sheet_id,))


def _with_text(sheet):
    revision = _latest(sheet["id"])
    sheet = dict(sheet)
    sheet["text"] = revision["text"] if revision else ""
    sheet["revision_id"] = revision["id"] if revision else None
    sheet["updated_at"] = revision["created_at"] if revision else sheet["created_at"]
    count = db.one("SELECT COUNT(*) AS n FROM lyric_revisions WHERE sheet_id = ?", (sheet["id"],))
    sheet["revisions"] = count["n"] if count else 0
    return sheet


def list_sheets(req):
    song = songs.get(req.params["id"])
    rows = db.query("SELECT * FROM lyric_sheets WHERE song_id = ? ORDER BY position, id",
                    (song["id"],))
    return {"lyrics": [_with_text(r) for r in rows]}


def create_sheet(req):
    song = songs.get(req.params["id"])
    data = req.json()
    name = (data.get("name") or "").strip()
    existing = db.query("SELECT * FROM lyric_sheets WHERE song_id = ?", (song["id"],))
    if not name:
        # Nobody wants to name a thing before writing it. A number is enough until it
        # earns a name, and with only one sheet the name is never shown at all.
        name = "v%d" % (len(existing) + 1)
    row = db.one("SELECT MAX(position) AS p FROM lyric_sheets WHERE song_id = ?", (song["id"],))
    sheet_id = db.insert("lyric_sheets", {
        "song_id": song["id"], "name": name,
        "position": ((row["p"] if row and row["p"] is not None else -1) + 1),
        "is_current": 0 if existing else 1,
        "created_at": time.time()})
    text = data.get("text")
    if text:
        db.insert("lyric_revisions",
                  {"sheet_id": sheet_id, "text": text, "created_at": time.time()})
    songs.touch(song["id"])
    return {"sheet": _with_text(get_sheet(sheet_id))}


def save_text(req):
    """Write new words. Unchanged text is not a revision."""
    sheet = get_sheet(req.params["id"])
    data = req.json()
    if "text" not in data:
        raise Error("text is required")
    text = data["text"] or ""
    current = _latest(sheet["id"])
    if current and current["text"] == text:
        return {"sheet": _with_text(sheet), "saved": False,
                "message": "Nothing changed, so no new revision was kept."}
    db.insert("lyric_revisions",
              {"sheet_id": sheet["id"], "text": text, "created_at": time.time()})
    songs.touch(sheet["song_id"])
    return {"sheet": _with_text(get_sheet(sheet["id"])), "saved": True}


def rename(req):
    sheet = get_sheet(req.params["id"])
    data = req.json()
    patch = {}
    if "name" in data:
        patch["name"] = need(data, "name")
    if patch:
        db.update("lyric_sheets", sheet["id"], patch)
    return {"sheet": _with_text(get_sheet(sheet["id"]))}


def make_current(req):
    sheet = get_sheet(req.params["id"])
    db.run("UPDATE lyric_sheets SET is_current = 0 WHERE song_id = ?", (sheet["song_id"],))
    db.update("lyric_sheets", sheet["id"], {"is_current": 1})
    songs.touch(sheet["song_id"])
    return {"sheet": _with_text(get_sheet(sheet["id"]))}


def history(req):
    sheet = get_sheet(req.params["id"])
    return {"revisions": db.query(
        "SELECT id, created_at, length(text) AS length FROM lyric_revisions "
        "WHERE sheet_id = ? ORDER BY id DESC", (sheet["id"],))}


def revision(req):
    row = db.one("SELECT * FROM lyric_revisions WHERE id = ?", (req.params["id"],))
    if not row:
        raise Error("no revision with id %s" % req.params["id"], 404)
    return {"revision": row}


def restore(req):
    """Bringing an old text back is a new revision, so nothing in the history is lost."""
    sheet = get_sheet(req.params["id"])
    revision_id = req.json().get("revision_id")
    old = db.one("SELECT * FROM lyric_revisions WHERE id = ? AND sheet_id = ?",
                 (revision_id, sheet["id"]))
    if not old:
        raise Error("that revision is not part of this alternative", 404)
    current = _latest(sheet["id"])
    if current and current["text"] == old["text"]:
        return {"sheet": _with_text(sheet), "saved": False,
                "message": "That text is already the current one."}
    db.insert("lyric_revisions",
              {"sheet_id": sheet["id"], "text": old["text"], "created_at": time.time()})
    songs.touch(sheet["song_id"])
    return {"sheet": _with_text(get_sheet(sheet["id"])), "saved": True}


def delete_sheet(req):
    sheet = get_sheet(req.params["id"])
    db.run("DELETE FROM lyric_revisions WHERE sheet_id = ?", (sheet["id"],))
    db.run("DELETE FROM lyric_sheets WHERE id = ?", (sheet["id"],))
    if sheet["is_current"]:
        other = db.one("SELECT id FROM lyric_sheets WHERE song_id = ? ORDER BY position LIMIT 1",
                       (sheet["song_id"],))
        if other:
            db.update("lyric_sheets", other["id"], {"is_current": 1})
    return {"deleted": sheet["id"]}


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM lyric_sheets")
    return {"alternatives": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs/<id>/lyrics"): list_sheets,
        ("POST", "/api/songs/<id>/lyrics"): create_sheet,
        ("PUT", "/api/lyrics/<id>/text"): save_text,
        ("PATCH", "/api/lyrics/<id>"): rename,
        ("POST", "/api/lyrics/<id>/current"): make_current,
        ("GET", "/api/lyrics/<id>/history"): history,
        ("POST", "/api/lyrics/<id>/restore"): restore,
        ("DELETE", "/api/lyrics/<id>"): delete_sheet,
        ("GET", "/api/lyric-revisions/<id>"): revision,
    }
