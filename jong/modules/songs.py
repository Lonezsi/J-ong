"""Songs, and the library view of them.

A song is the object the whole product is built around. It owns nothing directly: the
renders, lyrics, artwork and settings all point at it, so a song row stays small and
every other feature can be switched off without leaving a hole in this table.
"""
import time
import difflib

from .. import db, registry
from ..wire import Error, need

NAME = "songs"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS songs (
      id                 INTEGER PRIMARY KEY,
      title              TEXT NOT NULL,
      notes              TEXT NOT NULL DEFAULT '',
      current_version_id INTEGER,
      created_at         REAL NOT NULL,
      updated_at         REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS songs_title ON songs(title)",
]


def touch(song_id):
    db.run("UPDATE songs SET updated_at = ? WHERE id = ?", (time.time(), song_id))


def get(song_id):
    song = db.one("SELECT * FROM songs WHERE id = ?", (song_id,))
    if not song:
        raise Error("no song with id %s" % song_id, 404)
    return song


def decorate(songs):
    """Attach whatever the switched on modules can say about each song.

    Asking the registry rather than importing means the library still renders with
    versions or albums turned off, just with less on each row.
    """
    if not songs:
        return songs
    ids = [s["id"] for s in songs]
    marks = ",".join("?" * len(ids))
    latest = {}
    if registry.has("versions"):
        for row in db.query(
                "SELECT song_id, MAX(n) AS n, COUNT(*) AS versions FROM versions "
                "WHERE song_id IN (%s) GROUP BY song_id" % marks, ids):
            latest[row["song_id"]] = row
        for row in db.query(
                "SELECT song_id, id, n, duration FROM versions WHERE song_id IN (%s)" % marks, ids):
            entry = latest.setdefault(row["song_id"], {})
            if row["n"] == entry.get("n"):
                entry["duration"] = row["duration"]
                entry["version_id"] = row["id"]
    covers = {}
    if registry.has("artwork"):
        for row in db.query(
                "SELECT song_id, MIN(position) AS p, id FROM artwork "
                "WHERE song_id IN (%s) GROUP BY song_id" % marks, ids):
            covers[row["song_id"]] = row["id"]

    for song in songs:
        info = latest.get(song["id"], {})
        song["version_count"] = info.get("versions", 0)
        song["latest_version"] = info.get("n", 0)
        song["latest_version_id"] = info.get("version_id")
        song["duration"] = info.get("duration", 0)
        song["artwork_id"] = covers.get(song["id"])
    return songs


def list_songs(req):
    term = (req.q("q") or "").strip()
    order = req.q("sort", "updated")
    by = {"updated": "updated_at DESC", "title": "title COLLATE NOCASE ASC",
          "created": "created_at DESC"}.get(order, "updated_at DESC")
    if term:
        rows = db.query(
            "SELECT * FROM songs WHERE title LIKE ? ORDER BY " + by,
            ("%" + term + "%",))
    else:
        rows = db.query("SELECT * FROM songs ORDER BY " + by)
    return {"songs": decorate(rows)}


def get_song(req):
    song = get(req.params["id"])
    return {"song": decorate([song])[0]}


def create_song(req):
    data = req.json()
    title = need(data, "title")
    now = time.time()
    song_id = db.insert("songs", {
        "title": title, "notes": data.get("notes", ""),
        "created_at": now, "updated_at": now})
    return {"song": decorate([get(song_id)])[0]}


def update_song(req):
    song = get(req.params["id"])
    data = req.json()
    patch = {}
    if "title" in data:
        patch["title"] = need(data, "title")
    if "notes" in data:
        patch["notes"] = data["notes"] or ""
    if "current_version_id" in data:
        patch["current_version_id"] = data["current_version_id"]
    patch["updated_at"] = time.time()
    db.update("songs", song["id"], patch)
    return {"song": decorate([get(song["id"])])[0]}


def delete_song(req):
    song = get(req.params["id"])
    # Blobs are left alone: another song may point at the same bytes, and a personal
    # library would rather keep an orphaned file than lose one that was still in use.
    db.run("DELETE FROM songs WHERE id = ?", (song["id"],))
    return {"deleted": song["id"]}


def match(req):
    """Which existing song is this filename probably another render of.

    The desktop client asks before uploading, so it can offer "Is this a new render of
    Halfway Under?" rather than making a second song every time you export.
    """
    name = (req.q("name") or "").strip()
    if not name:
        raise Error("name is required")
    stem = name.rsplit(".", 1)[0]
    # Renders are usually called "Song v18" or "Song_final_3", so the trailing junk is
    # noise for matching purposes.
    cleaned = stem.replace("_", " ").replace("-", " ").strip().lower()
    rows = db.query("SELECT id, title FROM songs")
    scored = []
    for row in rows:
        ratio = difflib.SequenceMatcher(None, cleaned, row["title"].lower()).ratio()
        if row["title"].lower() in cleaned:
            ratio = max(ratio, 0.9)
        scored.append((ratio, row))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    # song_id rather than id, matching what sync.scan puts in its own suggestions. The
    # two endpoints answer the same question and a caller should not have to remember
    # which one it asked.
    best = [{"song_id": r["id"], "title": r["title"], "score": round(score, 3)}
            for score, r in scored[:5] if score >= 0.45]
    return {"query": stem, "matches": best,
            "suggest": best[0] if best and best[0]["score"] >= 0.62 else None}


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM songs")
    return {"count": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs"): list_songs,
        ("POST", "/api/songs"): create_song,
        ("GET", "/api/songs/match"): match,
        ("GET", "/api/songs/<id>"): get_song,
        ("PATCH", "/api/songs/<id>"): update_song,
        ("DELETE", "/api/songs/<id>"): delete_song,
    }
