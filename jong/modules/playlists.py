"""Playlists, which hold songs and loose renders side by side.

The two things you might want to hear in a row are not the same kind of thing. A song is
the object this library is built around and it has a current version; a render in the
Renders list has no song yet and may never get one. A running order that could only hold
one of them would be useless for the thing people actually do, which is line up a
finished track, a rough bounce and an idea from last week and listen straight through.

So an item is one or the other, and which it is decided by which column is filled. That
is why there are two nullable columns rather than one id and a kind string: a foreign key
can only point at one table, and the point of the foreign keys is that deleting a song
takes it out of every running order it was in rather than leaving a hole that has to be
found later.

Albums get one of these automatically. An album is already an ordered set of songs; a
playlist is the same set with renders allowed and an order you chose, so making one per
album costs a row and saves explaining the difference.
"""
import os
import time

from .. import db
from ..wire import Error, need

NAME = "playlists"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS playlists (
      id         INTEGER PRIMARY KEY,
      title      TEXT NOT NULL,
      album_id   INTEGER REFERENCES albums(id) ON DELETE CASCADE,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS playlist_items (
      id          INTEGER PRIMARY KEY,
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position    REAL NOT NULL,
      song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      render_id   INTEGER REFERENCES renders(id) ON DELETE CASCADE,
      added_at    REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS playlist_items_order ON playlist_items(playlist_id, position)",
    "CREATE UNIQUE INDEX IF NOT EXISTS playlists_album ON playlists(album_id) "
    "WHERE album_id IS NOT NULL",
]

MAX_ITEMS = 2000


def get(playlist_id):
    row = db.one("SELECT * FROM playlists WHERE id = ?", (playlist_id,))
    if not row:
        raise Error("no playlist with id %s" % playlist_id, 404)
    return row


def _items(playlist_id):
    """Everything in a running order, each one carrying enough to be played and drawn.

    One query per kind rather than per item: a playlist of eighty things should cost two
    reads, not eighty.
    """
    rows = db.query(
        "SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id",
        (playlist_id,))
    if not rows:
        return []

    song_ids = [r["song_id"] for r in rows if r["song_id"]]
    render_ids = [r["render_id"] for r in rows if r["render_id"]]

    songs = {}
    if song_ids:
        marks = ",".join("?" * len(song_ids))
        for s in db.query(
                "SELECT s.*, (SELECT COUNT(*) FROM versions v WHERE v.song_id = s.id) "
                "AS version_count FROM songs s WHERE s.id IN (%s)" % marks, song_ids):
            songs[s["id"]] = s

    renders = {}
    if render_ids and db.table_exists("renders"):
        marks = ",".join("?" * len(render_ids))
        for r in db.query("SELECT * FROM renders WHERE id IN (%s)" % marks, render_ids):
            renders[r["id"]] = r

    out = []
    for row in rows:
        if row["song_id"]:
            song = songs.get(row["song_id"])
            if not song:
                continue
            out.append({"item_id": row["id"], "position": row["position"], "kind": "song",
                        "song": song, "title": song["title"]})
        elif row["render_id"]:
            render = renders.get(row["render_id"])
            if not render:
                continue
            name = os.path.splitext(render["filename"])[0] or "render"
            # Named the same way the Renders list names it, so the player does not show
            # a file extension for something that is called something else everywhere
            # else in the app.
            carried = dict(render)
            carried["name"] = name
            out.append({"item_id": row["id"], "position": row["position"], "kind": "render",
                        "render": carried, "title": name})
    return out


def _read(row):
    out = dict(row)
    out["items"] = _items(row["id"])
    out["count"] = len(out["items"])
    return out


def list_playlists(req):
    # Albums that existed before this module did get theirs here, which is the first
    # place anything would notice they were missing. Cheaper than a migration, and it
    # cannot be skipped by never opening the album.
    if db.table_exists("albums"):
        for album in db.query("SELECT id, title FROM albums"):
            for_album(album["id"], album["title"])

    rows = db.query("SELECT * FROM playlists ORDER BY album_id IS NULL DESC, title")
    out = []
    for row in rows:
        counted = db.one("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?",
                         (row["id"],))
        item = dict(row)
        item["count"] = counted["n"] if counted else 0
        out.append(item)
    return {"playlists": out}


def read(req):
    return {"playlist": _read(get(req.params["id"]))}


def create(req):
    title = need(req.json(), "title")
    now = time.time()
    made = db.insert("playlists", {"title": title[:120], "album_id": None,
                                   "created_at": now, "updated_at": now})
    return {"playlist": _read(get(made))}


def rename(req):
    playlist = get(req.params["id"])
    title = need(req.json(), "title")
    db.update("playlists", playlist["id"], {"title": title[:120], "updated_at": time.time()})
    return {"playlist": _read(get(playlist["id"]))}


def remove(req):
    playlist = get(req.params["id"])
    if playlist["album_id"]:
        raise Error("that playlist belongs to an album. Delete the album instead.")
    db.run("DELETE FROM playlists WHERE id = ?", (playlist["id"],))
    return {"deleted": playlist["id"]}


def _next_position(playlist_id):
    row = db.one("SELECT MAX(position) AS at FROM playlist_items WHERE playlist_id = ?",
                 (playlist_id,))
    return (row["at"] or 0) + 1 if row else 1


def add(req):
    """Put a song or a render at the end. Exactly one of the two, never both."""
    playlist = get(req.params["id"])
    data = req.json()
    song_id = data.get("song_id")
    render_id = data.get("render_id")
    if bool(song_id) == bool(render_id):
        raise Error("say either a song_id or a render_id, not both and not neither")

    counted = db.one("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?",
                     (playlist["id"],))
    if counted and counted["n"] >= MAX_ITEMS:
        raise Error("that playlist is full at %d" % MAX_ITEMS)

    if song_id:
        from . import songs
        songs.get(song_id)                       # 404s here rather than on playback
    else:
        if not db.one("SELECT id FROM renders WHERE id = ?", (render_id,)):
            raise Error("no render with id %s" % render_id, 404)

    # The same thing twice in a row is a mistake; the same thing twice in a playlist is
    # not, so this only refuses an exact repeat of what is already at the end.
    last = db.one("SELECT * FROM playlist_items WHERE playlist_id = ? "
                  "ORDER BY position DESC, id DESC LIMIT 1", (playlist["id"],))
    if last and last["song_id"] == song_id and last["render_id"] == render_id:
        return {"playlist": _read(get(playlist["id"])), "added": False,
                "message": "That is already the last thing in it."}

    db.insert("playlist_items", {
        "playlist_id": playlist["id"], "position": _next_position(playlist["id"]),
        "song_id": song_id, "render_id": render_id, "added_at": time.time()})
    db.update("playlists", playlist["id"], {"updated_at": time.time()})
    return {"playlist": _read(get(playlist["id"])), "added": True}


def drop_item(req):
    playlist = get(req.params["id"])
    db.run("DELETE FROM playlist_items WHERE id = ? AND playlist_id = ?",
           (req.params["item_id"], playlist["id"]))
    db.update("playlists", playlist["id"], {"updated_at": time.time()})
    return {"playlist": _read(get(playlist["id"]))}


def reorder(req):
    """The whole running order at once, as a list of item ids.

    Sent whole rather than as a move from here to there, because the page already holds
    the order it wants and a half applied reorder is worse than none.
    """
    playlist = get(req.params["id"])
    order = req.json().get("items")
    if not isinstance(order, list):
        raise Error("items must be a list of item ids")
    known = {r["id"] for r in db.query(
        "SELECT id FROM playlist_items WHERE playlist_id = ?", (playlist["id"],))}
    at = 1
    for item_id in order:
        try:
            item_id = int(item_id)
        except (TypeError, ValueError):
            raise Error("an item id must be a whole number")
        if item_id not in known:
            continue
        db.run("UPDATE playlist_items SET position = ? WHERE id = ?", (at, item_id))
        at += 1
    db.update("playlists", playlist["id"], {"updated_at": time.time()})
    return {"playlist": _read(get(playlist["id"]))}


# ── albums ───────────────────────────────────────────────────────────────────

def for_album(album_id, title=None, create_if_missing=True):
    """The playlist that belongs to an album, made on demand.

    Called when an album is created and again whenever one is read, so albums that
    existed before this module did get theirs the first time they are opened rather than
    needing a migration.
    """
    row = db.one("SELECT * FROM playlists WHERE album_id = ?", (album_id,))
    if row:
        return row
    if not create_if_missing:
        return None
    album = db.one("SELECT * FROM albums WHERE id = ?", (album_id,))
    if not album:
        return None
    now = time.time()
    made = db.insert("playlists", {"title": title or album["title"], "album_id": album_id,
                                   "created_at": now, "updated_at": now})
    # Seeded with the album's songs, in the album's own order.
    # album_songs is keyed by the pair, so there is no id to fall back on.
    for link in db.query("SELECT song_id FROM album_songs WHERE album_id = ? "
                         "ORDER BY position, song_id", (album_id,)):
        db.insert("playlist_items", {
            "playlist_id": made, "position": _next_position(made),
            "song_id": link["song_id"], "render_id": None, "added_at": now})
    return db.one("SELECT * FROM playlists WHERE id = ?", (made,))


def album_gained_song(album_id, song_id):
    playlist = for_album(album_id)
    if not playlist:
        return
    there = db.one("SELECT id FROM playlist_items WHERE playlist_id = ? AND song_id = ?",
                   (playlist["id"], song_id))
    if there:
        return
    db.insert("playlist_items", {
        "playlist_id": playlist["id"], "position": _next_position(playlist["id"]),
        "song_id": song_id, "render_id": None, "added_at": time.time()})


def album_lost_song(album_id, song_id):
    playlist = db.one("SELECT * FROM playlists WHERE album_id = ?", (album_id,))
    if not playlist:
        return
    db.run("DELETE FROM playlist_items WHERE playlist_id = ? AND song_id = ?",
           (playlist["id"], song_id))


def for_song(req):
    """Every running order this song is in, and where in each one it sits.

    The position is the point. A song that is track nine of an album is not the same
    thing as a song that happens to be in a list: knowing where it sits is what lets the
    page start the playlist at this song rather than at the top of it.

    A song can appear twice in one order, so the position given is the first, which is
    where you would expect pressing it to start.
    """
    song = songs_module().get(req.params["id"])
    rows = db.query(
        "SELECT p.*, MIN(i.position) AS at, COUNT(i.id) AS times "
        "FROM playlists p JOIN playlist_items i ON i.playlist_id = p.id "
        "WHERE i.song_id = ? GROUP BY p.id "
        "ORDER BY p.album_id IS NULL DESC, p.title", (song["id"],))

    out = []
    for row in rows:
        counted = db.one("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?",
                         (row["id"],))
        item = dict(row)
        item["count"] = counted["n"] if counted else 0
        # Where it sits as a person would say it: one of nine, not position 4.0.
        ahead = db.one(
            "SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ? AND position < ?",
            (row["id"], row["at"]))
        item["index"] = (ahead["n"] if ahead else 0)
        out.append(item)
    return {"playlists": out}


def songs_module():
    from . import songs
    return songs


def SUMMARY():
    total = db.one("SELECT COUNT(*) AS n FROM playlists")
    own = db.one("SELECT COUNT(*) AS n FROM playlists WHERE album_id IS NULL")
    return {"count": total["n"] if total else 0, "yours": own["n"] if own else 0}


def ROUTES():
    return {
        ("GET", "/api/playlists"): list_playlists,
        ("GET", "/api/songs/<id>/playlists"): for_song,
        ("POST", "/api/playlists"): create,
        ("GET", "/api/playlists/<id>"): read,
        ("PATCH", "/api/playlists/<id>"): rename,
        ("DELETE", "/api/playlists/<id>"): remove,
        ("POST", "/api/playlists/<id>/items"): add,
        ("DELETE", "/api/playlists/<id>/items/<item_id>"): drop_item,
        ("PUT", "/api/playlists/<id>/order"): reorder,
    }
