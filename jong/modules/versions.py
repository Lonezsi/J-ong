"""Rendered versions of a song, and serving them back for playback.

Uploads are a raw request body rather than a multipart form. The filename and anything
else travels in headers, which means the desktop client and the browser use the identical
call, and neither of them needs a multipart encoder.
"""
import os
import time

from .. import db, blobs, config, audio_meta, registry
from ..wire import Error, Response, as_int
from . import songs

NAME = "versions"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS versions (
      id          INTEGER PRIMARY KEY,
      song_id     INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      n           INTEGER NOT NULL,
      digest      TEXT NOT NULL,
      ext         TEXT NOT NULL DEFAULT '.mp3',
      size        INTEGER NOT NULL DEFAULT 0,
      duration    REAL NOT NULL DEFAULT 0,
      bitrate     INTEGER NOT NULL DEFAULT 0,
      label       TEXT NOT NULL DEFAULT '',
      filename    TEXT NOT NULL DEFAULT '',
      source_path TEXT NOT NULL DEFAULT '',
      created_at  REAL NOT NULL,
      project_at  REAL NOT NULL DEFAULT 0,
      rendered_at REAL NOT NULL DEFAULT 0
    )
    """,
    "CREATE INDEX IF NOT EXISTS versions_song ON versions(song_id, n DESC)",
    "CREATE INDEX IF NOT EXISTS versions_digest ON versions(digest)",
]



def _add_date_columns():
    """The two dates a render carries, kept when it becomes a version.

    attach() had both in its hand and dropped them, so once a render was filed the only
    date left was the song's updated_at, which a saved lyric bumps. "What have I not
    touched in six months" was measuring the wrong thing.
    """
    db.add_column_if_missing("versions", "project_at", "REAL NOT NULL DEFAULT 0")
    db.add_column_if_missing("versions", "rendered_at", "REAL NOT NULL DEFAULT 0")


#: Named steps, each run once ever and recorded by name. See jong/registry.py.
MIGRATE = [
    ("dates_from_the_render", _add_date_columns),
]

def get(version_id):
    row = db.one("SELECT * FROM versions WHERE id = ?", (version_id,))
    if not row:
        raise Error("no version with id %s" % version_id, 404)
    return row


def list_versions(req):
    song = songs.get(req.params["id"])
    rows = db.query("SELECT * FROM versions WHERE song_id = ? ORDER BY n DESC", (song["id"],))
    return {"versions": rows, "current_version_id": song["current_version_id"]}


def add_stored(song_id, digest, ext, size, duration=0.0, bitrate=0,
               label="", filename="", source_path="", project_at=0.0, rendered_at=0.0):
    """Make a version out of bytes that are already in the blob store.

    An upload calls this once the body has landed, and the renders list calls it when a
    render that arrived earlier is finally given a home. Nothing is copied either way:
    the blob is content addressed, so a version is a row pointing at bytes that already
    exist. Returns (version, was_already_there).
    """
    same = db.one("SELECT * FROM versions WHERE song_id = ? AND digest = ?",
                  (song_id, digest))
    if same:
        return same, True
    row = db.one("SELECT MAX(n) AS n FROM versions WHERE song_id = ?", (song_id,))
    next_n = (row["n"] or 0) + 1 if row else 1
    version_id = db.insert("versions", {
        "song_id": song_id, "n": next_n, "digest": digest, "ext": ext,
        "size": size, "duration": duration or 0.0, "bitrate": bitrate or 0,
        "label": label or "", "filename": filename or "",
        "source_path": source_path or "", "created_at": time.time(),
        "project_at": project_at or 0.0, "rendered_at": rendered_at or 0.0})
    db.update("songs", song_id, {"current_version_id": version_id,
                                 "updated_at": time.time()})
    return get(version_id), False


def upload(req):
    """Store one render. The song must already exist; the client creates it first if
    it has decided this is not a new take of something already here."""
    song = songs.get(req.params["id"])
    length = as_int(req.headers.get("Content-Length") or 0, "Content-Length")
    if length <= 0:
        raise Error("no file in that upload")

    filename = (req.headers.get("X-Filename") or "render.mp3").strip()
    ext = os.path.splitext(filename)[1].lower()
    if ext not in config.AUDIO_EXT:
        raise Error("%s is not an audio file J-ong handles" % (ext or filename))

    digest, size, _ = blobs.put_stream(req.rfile, length)

    # The same bytes arriving twice is a re-upload, not a new version. Saying so is more
    # useful than silently making v19 identical to v18.
    same = db.one("SELECT * FROM versions WHERE song_id = ? AND digest = ?",
                  (song["id"], digest))
    if same:
        return {"version": same, "duplicate": True,
                "message": "That is byte for byte v%d, so nothing was added." % same["n"]}

    meta = audio_meta.probe(blobs.path_for(digest), ext)
    duration = meta["duration"]
    header_duration = req.headers.get("X-Duration")
    if not duration and header_duration:
        try:
            duration = float(header_duration)
        except ValueError:
            duration = 0.0

    version, _ = add_stored(
        song["id"], digest, ext, size, duration, meta["bitrate"],
        label=(req.headers.get("X-Label") or "").strip(), filename=filename,
        source_path=(req.headers.get("X-Source-Path") or "").strip())
    return {"version": version, "duplicate": False}


def have(req):
    """Does the library already hold these bytes.

    The desktop client asks before sending anything, which is what keeps a folder of two
    hundred unchanged renders from being uploaded again every time it scans. This is the
    honest version of "only send the changes" for audio: whole files are compared by
    content, because a re-encode shares no bytes with the render before it.
    """
    digests = [d for d in (req.q("digest") or "").split(",") if d]
    if not digests:
        raise Error("digest is required")
    if len(digests) > 500:
        raise Error("ask about at most 500 files at a time")
    marks = ",".join("?" * len(digests))
    rows = db.query(
        "SELECT v.digest, v.id, v.n, v.song_id, s.title FROM versions v "
        "JOIN songs s ON s.id = v.song_id WHERE v.digest IN (%s)" % marks, digests)
    found = {r["digest"]: r for r in rows}
    return {"have": {d: found.get(d) for d in digests}}


def patch_version(req):
    version = get(req.params["id"])
    data = req.json()
    patch = {}
    if "label" in data:
        patch["label"] = (data["label"] or "").strip()
    if "duration" in data:
        # The browser knows the real duration once it has decoded the file, which is the
        # backstop for formats the server cannot parse.
        try:
            patch["duration"] = max(0.0, float(data["duration"]))
        except (TypeError, ValueError):
            raise Error("duration must be a number")
    db.update("versions", version["id"], patch)
    songs.touch(version["song_id"])
    return {"version": get(version["id"])}


def make_current(req):
    version = get(req.params["id"])
    db.update("songs", version["song_id"], {"current_version_id": version["id"],
                                            "updated_at": time.time()})
    return {"song_id": version["song_id"], "current_version_id": version["id"]}


def delete_version(req):
    version = get(req.params["id"])
    db.run("DELETE FROM versions WHERE id = ?", (version["id"],))
    song = db.one("SELECT * FROM songs WHERE id = ?", (version["song_id"],))
    if song and song["current_version_id"] == version["id"]:
        newest = db.one("SELECT id FROM versions WHERE song_id = ? ORDER BY n DESC LIMIT 1",
                        (song["id"],))
        db.update("songs", song["id"], {"current_version_id": newest["id"] if newest else None})
    if song:
        # Every sibling path bumps this; only deleting did not, so a song could lose a
        # render and still sort as untouched under "Recently touched".
        songs.touch(song["id"])
    # Only drop the bytes when no version anywhere still points at them.
    still = db.one("SELECT id FROM versions WHERE digest = ? LIMIT 1", (version["digest"],))
    # The table, not the module. Renders can be switched off in config.MODULES with the
    # rows still sitting there, and then deleting a version would take bytes that a
    # render entry still points at, which is exactly the data the module being off is
    # meant to be preserving.
    if not still and db.table_exists("renders"):
        # A render sitting in the list plays from the same bytes. Deleting a version made
        # from it must not leave that entry pointing at nothing.
        still = db.one("SELECT id FROM renders WHERE digest = ? LIMIT 1",
                       (version["digest"],))
    if not still:
        blobs.delete(version["digest"])
    return {"deleted": version["id"]}


def audio(req):
    version = get(req.params["id"])
    path = blobs.path_for(version["digest"])
    if not os.path.isfile(path):
        raise Error("the file for that version is missing from storage", 410)
    return Response(path=path, content_type=_content_type(version["ext"]))


def download(req):
    version = get(req.params["id"])
    path = blobs.path_for(version["digest"])
    if not os.path.isfile(path):
        raise Error("the file for that version is missing from storage", 410)
    name = version["filename"] or ("v%d%s" % (version["n"], version["ext"]))
    return Response(path=path, content_type=_content_type(version["ext"]),
                    headers={"download": name})


def _content_type(ext):
    from ..http import CONTENT_TYPES
    return CONTENT_TYPES.get(ext, "application/octet-stream")


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM versions")
    distinct = db.one("SELECT COUNT(DISTINCT digest) AS n FROM versions")
    return {"count": row["n"], "bytes": row["bytes"],
            "distinct_files": distinct["n"] if distinct else 0}


def ROUTES():
    return {
        ("GET", "/api/versions/have"): have,
        ("GET", "/api/songs/<id>/versions"): list_versions,
        ("POST", "/api/songs/<id>/versions"): upload,
        ("PATCH", "/api/versions/<id>"): patch_version,
        ("DELETE", "/api/versions/<id>"): delete_version,
        ("POST", "/api/versions/<id>/current"): make_current,
        ("GET", "/api/versions/<id>/audio"): audio,
        ("GET", "/api/versions/<id>/download"): download,
    }
