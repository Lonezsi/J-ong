"""Watching folders where renders land, and pulling new ones in.

A scan hashes what it finds and compares that against the versions already stored, so a
file you have already imported is recognised no matter what it has been renamed to, and
a file that was only touched is skipped without being read again.

Nothing is imported without being asked. A scan reports candidates and what it thinks
each one is a new render of; importing is a second, explicit call.
"""
import os
import time

from .. import db, blobs, config, audio_meta, registry
from ..wire import Error, need
from . import songs

NAME = "sync"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS sync_folders (
      id         INTEGER PRIMARY KEY,
      path       TEXT NOT NULL UNIQUE,
      enabled    INTEGER NOT NULL DEFAULT 1,
      last_scan  REAL NOT NULL DEFAULT 0,
      created_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS sync_seen (
      path       TEXT PRIMARY KEY,
      digest     TEXT NOT NULL,
      size       INTEGER NOT NULL,
      mtime      REAL NOT NULL,
      checked_at REAL NOT NULL
    )
    """,
]


def list_folders(req):
    return {"folders": db.query("SELECT * FROM sync_folders ORDER BY path")}


def add_folder(req):
    path = need(req.json(), "path")
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        raise Error("there is no folder at %s" % path)
    existing = db.one("SELECT * FROM sync_folders WHERE path = ?", (path,))
    if existing:
        return {"folder": existing, "added": False}
    folder_id = db.insert("sync_folders",
                          {"path": path, "enabled": 1, "created_at": time.time()})
    return {"folder": db.one("SELECT * FROM sync_folders WHERE id = ?", (folder_id,)),
            "added": True}


def update_folder(req):
    folder = db.one("SELECT * FROM sync_folders WHERE id = ?", (req.params["id"],))
    if not folder:
        raise Error("no folder with id %s" % req.params["id"], 404)
    data = req.json()
    if "enabled" in data:
        db.update("sync_folders", folder["id"], {"enabled": 1 if data["enabled"] else 0})
    return {"folder": db.one("SELECT * FROM sync_folders WHERE id = ?", (folder["id"],))}


def remove_folder(req):
    db.run("DELETE FROM sync_folders WHERE id = ?", (req.params["id"],))
    return {"removed": req.params["id"]}


def _digest_for(path, stat):
    """Hash a file, reusing the last answer when size and mtime are unchanged.

    Hashing every render on every scan would make a folder of a few hundred mixes take
    minutes. Size and mtime together are enough to know nothing has been rewritten.
    """
    cached = db.one("SELECT * FROM sync_seen WHERE path = ?", (path,))
    if cached and cached["size"] == stat.st_size and abs(cached["mtime"] - stat.st_mtime) < 1:
        return cached["digest"]
    digest = blobs.hash_file(path)
    db.run("INSERT INTO sync_seen (path, digest, size, mtime, checked_at) "
           "VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET "
           "digest = excluded.digest, size = excluded.size, mtime = excluded.mtime, "
           "checked_at = excluded.checked_at",
           (path, digest, stat.st_size, stat.st_mtime, time.time()))
    return digest


def _walk(root):
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if os.path.splitext(name)[1].lower() in config.AUDIO_EXT:
                yield os.path.join(base, name)


def scan(req):
    """Look at every watched folder and report what is not in the library yet."""
    if not registry.has("versions"):
        raise Error("the versions module is switched off, so nothing can be imported", 409)
    folders = db.query("SELECT * FROM sync_folders WHERE enabled = 1")
    candidates, known, errors = [], 0, []
    for folder in folders:
        if not os.path.isdir(folder["path"]):
            errors.append({"path": folder["path"], "why": "the folder is not there any more"})
            continue
        for path in _walk(folder["path"]):
            try:
                stat = os.stat(path)
                digest = _digest_for(path, stat)
            except OSError as e:
                errors.append({"path": path, "why": str(e)})
                continue
            have = db.one("SELECT v.id, v.n, v.song_id, s.title FROM versions v "
                          "JOIN songs s ON s.id = v.song_id WHERE v.digest = ? LIMIT 1",
                          (digest,))
            if have:
                known += 1
                continue
            meta = audio_meta.probe(path)
            candidates.append({
                "path": path, "name": os.path.basename(path), "digest": digest,
                "size": stat.st_size, "modified": stat.st_mtime,
                "duration": meta["duration"], "bitrate": meta["bitrate"],
                "suggest": _suggest(os.path.basename(path)),
            })
        db.update("sync_folders", folder["id"], {"last_scan": time.time()})
    candidates.sort(key=lambda c: c["modified"], reverse=True)
    return {"candidates": candidates, "already_have": known, "errors": errors,
            "folders": len(folders)}


def _suggest(name):
    import difflib
    stem = os.path.splitext(name)[0].replace("_", " ").replace("-", " ").strip().lower()
    best, score = None, 0.0
    for row in db.query("SELECT id, title FROM songs"):
        ratio = difflib.SequenceMatcher(None, stem, row["title"].lower()).ratio()
        if row["title"].lower() in stem:
            ratio = max(ratio, 0.9)
        if ratio > score:
            best, score = row, ratio
    if best and score >= 0.62:
        return {"song_id": best["id"], "title": best["title"], "score": round(score, 3)}
    return None


def import_file(req):
    """Take one scanned file into the library, as a new version or a brand new song."""
    if not registry.has("versions"):
        raise Error("the versions module is switched off, so nothing can be imported", 409)
    data = req.json()
    path = need(data, "path")
    if not os.path.isfile(path):
        raise Error("there is no file at %s" % path)
    if os.path.splitext(path)[1].lower() not in config.AUDIO_EXT:
        raise Error("that is not an audio file J-ong handles")

    watched = db.query("SELECT path FROM sync_folders WHERE enabled = 1")
    real = os.path.abspath(path)
    # Only files inside a folder the user chose. Without this the endpoint would copy
    # anything on the machine into the library on request.
    if not any(real.startswith(os.path.abspath(f["path"]) + os.sep) or
               real == os.path.abspath(f["path"]) for f in watched):
        raise Error("that file is not inside any watched folder", 403)

    song_id = data.get("song_id")
    if song_id:
        song = songs.get(song_id)
    else:
        title = (data.get("title") or "").strip() or os.path.splitext(os.path.basename(path))[0]
        now = time.time()
        song = songs.get(db.insert("songs", {
            "title": title, "notes": "", "created_at": now, "updated_at": now}))

    digest, size, _ = blobs.put_path(path)
    same = db.one("SELECT * FROM versions WHERE song_id = ? AND digest = ?",
                  (song["id"], digest))
    if same:
        return {"song": song, "version": same, "duplicate": True}

    meta = audio_meta.probe(path)
    row = db.one("SELECT MAX(n) AS n FROM versions WHERE song_id = ?", (song["id"],))
    version_id = db.insert("versions", {
        "song_id": song["id"], "n": (row["n"] or 0) + 1 if row else 1,
        "digest": digest, "ext": os.path.splitext(path)[1].lower(), "size": size,
        "duration": meta["duration"], "bitrate": meta["bitrate"], "label": "",
        "filename": os.path.basename(path), "source_path": real,
        "created_at": time.time()})
    db.update("songs", song["id"], {"current_version_id": version_id,
                                    "updated_at": time.time()})
    return {"song": songs.get(song["id"]),
            "version": db.one("SELECT * FROM versions WHERE id = ?", (version_id,)),
            "duplicate": False}


def SUMMARY():
    folders = db.one("SELECT COUNT(*) AS n FROM sync_folders WHERE enabled = 1")
    return {"folders": folders["n"] if folders else 0}


def ROUTES():
    return {
        ("GET", "/api/sync/folders"): list_folders,
        ("POST", "/api/sync/folders"): add_folder,
        ("PATCH", "/api/sync/folders/<id>"): update_folder,
        ("DELETE", "/api/sync/folders/<id>"): remove_folder,
        ("POST", "/api/sync/scan"): scan,
        ("POST", "/api/sync/import"): import_file,
    }
