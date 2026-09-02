"""Images attached to a song.

Artwork is treated as content rather than a thumbnail on a record, so a song can hold
several and the first one is simply the one shown smallest. Reordering is how you choose
a cover.
"""
import os
import time

from .. import db, blobs, config
from ..wire import Error, Response, as_int
from . import songs

NAME = "artwork"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS artwork (
      id         INTEGER PRIMARY KEY,
      song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      digest     TEXT NOT NULL,
      ext        TEXT NOT NULL DEFAULT '.jpg',
      position   INTEGER NOT NULL DEFAULT 0,
      caption    TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS artwork_song ON artwork(song_id, position)",
]


def get(image_id):
    row = db.one("SELECT * FROM artwork WHERE id = ?", (image_id,))
    if not row:
        raise Error("no image with id %s" % image_id, 404)
    return row


def list_images(req):
    song = songs.get(req.params["id"])
    return {"artwork": db.query(
        "SELECT * FROM artwork WHERE song_id = ? ORDER BY position, id", (song["id"],))}


def upload(req):
    song = songs.get(req.params["id"])
    length = as_int(req.headers.get("Content-Length") or 0, "Content-Length")
    if length <= 0:
        raise Error("no image in that upload")
    filename = (req.headers.get("X-Filename") or "cover.jpg").strip()
    ext = os.path.splitext(filename)[1].lower()
    if ext not in config.IMAGE_EXT:
        raise Error("%s is not an image J-ong handles" % (ext or filename))

    digest, _, _ = blobs.put_stream(req.rfile, length)
    same = db.one("SELECT * FROM artwork WHERE song_id = ? AND digest = ?",
                  (song["id"], digest))
    if same:
        return {"image": same, "duplicate": True}

    row = db.one("SELECT MAX(position) AS p FROM artwork WHERE song_id = ?", (song["id"],))
    image_id = db.insert("artwork", {
        "song_id": song["id"], "digest": digest, "ext": ext,
        "position": ((row["p"] if row and row["p"] is not None else -1) + 1),
        "caption": (req.headers.get("X-Caption") or "").strip(),
        "created_at": time.time()})
    songs.touch(song["id"])
    return {"image": get(image_id), "duplicate": False}


def reorder(req):
    """Positions arrive as a list of ids in the order wanted. The first is the cover."""
    song = songs.get(req.params["id"])
    order = req.json().get("order")
    if not isinstance(order, list) or not order:
        raise Error("order must be a list of image ids")
    owned = {r["id"] for r in db.query("SELECT id FROM artwork WHERE song_id = ?", (song["id"],))}
    unknown = [i for i in order if i not in owned]
    if unknown:
        raise Error("those images are not on this song: %s" % unknown)
    for position, image_id in enumerate(order):
        db.update("artwork", image_id, {"position": position})
    songs.touch(song["id"])
    return {"artwork": db.query(
        "SELECT * FROM artwork WHERE song_id = ? ORDER BY position, id", (song["id"],))}


def delete_image(req):
    image = get(req.params["id"])
    db.run("DELETE FROM artwork WHERE id = ?", (image["id"],))
    still = db.one("SELECT id FROM artwork WHERE digest = ? LIMIT 1", (image["digest"],))
    if not still:
        from .. import registry
        used = None
        if registry.has("albums"):
            used = db.one("SELECT id FROM albums WHERE cover_digest = ? LIMIT 1",
                          (image["digest"],))
        if not used:
            blobs.delete(image["digest"])
    return {"deleted": image["id"]}


def image(req):
    row = get(req.params["id"])
    path = blobs.path_for(row["digest"])
    if not os.path.isfile(path):
        raise Error("that image is missing from storage", 410)
    from ..http import CONTENT_TYPES
    return Response(path=path,
                    content_type=CONTENT_TYPES.get(row["ext"], "application/octet-stream"))


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM artwork")
    return {"count": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs/<id>/artwork"): list_images,
        ("POST", "/api/songs/<id>/artwork"): upload,
        ("POST", "/api/songs/<id>/artwork/order"): reorder,
        ("DELETE", "/api/artwork/<id>"): delete_image,
        ("GET", "/api/artwork/<id>/image"): image,
    }
