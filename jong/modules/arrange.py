"""The compositor: one track, cut and reordered by the beat.

This is not a DAW and does not want to be. It answers one question, the one you have
while a verse is playing and the words do not fit: what if that section were four bars
shorter, or that chorus went round twice. So there is one track, everything lands on a
beat, and the only moves are trim, move, duplicate and remove.

The arrangement belongs to the song, not to a version. Keeping one per version would
mean rebuilding it every time a new render lands, which is the opposite of useful: the
whole point is that the shape you worked out survives the next bounce. It remembers
which version it was built against so the page can say so when you are listening to a
different one.

Nothing here touches the audio. An arrangement is a list of beat numbers; the browser
plays the file through it, and the stored render is never rewritten.
"""
import json
import time

from .. import db
from ..wire import Error, need

NAME = "arrange"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS arrangements (
      song_id     INTEGER PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
      version_id  INTEGER,
      bpm         REAL NOT NULL DEFAULT 120,
      offset      REAL NOT NULL DEFAULT 0,
      per_bar     INTEGER NOT NULL DEFAULT 4,
      enabled     INTEGER NOT NULL DEFAULT 0,
      data        TEXT NOT NULL DEFAULT '{}',
      updated_at  REAL NOT NULL
    )
    """,
]

#: A song is not a thousand sections, and a runaway loop should not be able to write one.
MAX_PARTS = 64
MAX_CLIPS = 512


def _blank(song_id):
    return {"song_id": song_id, "version_id": None, "bpm": 120.0, "offset": 0.0,
            "per_bar": 4, "enabled": 0, "parts": [], "clips": [], "lyrics": {},
            "updated_at": 0}


def _read(row):
    """One row, with its JSON opened out, so callers never see the encoded blob."""
    try:
        data = json.loads(row["data"] or "{}")
    except ValueError:
        data = {}
    out = dict(row)
    out.pop("data", None)
    out["parts"] = data.get("parts") or []
    out["clips"] = data.get("clips") or []
    # Which lyric sheet belongs to which part. Held here rather than as a column on the
    # lyrics table so that switching this module off takes the links with it and leaves
    # the words alone.
    out["lyrics"] = data.get("lyrics") or {}
    return out


def get_for(song_id):
    row = db.one("SELECT * FROM arrangements WHERE song_id = ?", (song_id,))
    return _read(row) if row else _blank(song_id)


def _number(value, field, low, high, default=None):
    if value is None:
        if default is None:
            raise Error("%s is required" % field)
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise Error("%s must be a number" % field)
    if not (low <= number <= high):
        raise Error("%s must be between %g and %g" % (field, low, high))
    return number


def _spans(items, kind, limit, known_parts=None):
    """Check a list of beat spans and hand back a clean copy.

    Beats rather than seconds throughout. Seconds would drift the moment the tempo was
    corrected, and correcting the tempo after a bad guess is the common case.
    """
    if not isinstance(items, list):
        raise Error("%s must be a list" % kind)
    if len(items) > limit:
        raise Error("that is more than %d %s" % (limit, kind))
    out = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise Error("%s %d is not an object" % (kind, index + 1))
        span = {
            "id": str(item.get("id") or "%s%d" % (kind[0], index + 1))[:40],
            "from": _number(item.get("from"), "%s start" % kind, 0, 1e6, 0),
            "beats": _number(item.get("beats"), "%s length" % kind, 0.001, 1e6, 4),
        }
        if kind == "parts":
            span["name"] = str(item.get("name") or "Part %d" % (index + 1)).strip()[:60]
            span["hue"] = int(_number(item.get("hue"), "hue", 0, 360, 140))
        else:
            part = item.get("part")
            if part is not None:
                part = str(part)[:40]
                if known_parts is not None and part not in known_parts:
                    # A clip pointing at a part that is gone would draw with no name and
                    # no colour, which looks like a bug rather than a deleted section.
                    part = None
            span["part"] = part
        out.append(span)
    return out


def save(req):
    """Write the whole arrangement at once.

    One call rather than a route per field. The editor already holds the entire shape in
    memory, the thing is small, and a half applied arrangement is worse than none.
    """
    from . import songs
    song = songs.get(req.params["id"])
    body = req.json()

    bpm = _number(body.get("bpm"), "bpm", 20, 400, 120)
    offset = _number(body.get("offset"), "offset", -60, 600, 0)
    per_bar = int(_number(body.get("per_bar"), "beats in a bar", 1, 16, 4))
    parts = _spans(body.get("parts") or [], "parts", MAX_PARTS)
    known = {p["id"] for p in parts}
    clips = _spans(body.get("clips") or [], "clips", MAX_CLIPS, known)

    links = body.get("lyrics") or {}
    if not isinstance(links, dict):
        raise Error("lyrics links must be an object")
    lyrics = {}
    for part_id, sheet_id in links.items():
        if str(part_id) in known and sheet_id is not None:
            try:
                lyrics[str(part_id)] = int(sheet_id)
            except (TypeError, ValueError):
                raise Error("a lyrics link must be a sheet id")

    version_id = body.get("version_id")
    enabled = 1 if body.get("enabled") else 0
    data = json.dumps({"parts": parts, "clips": clips, "lyrics": lyrics})

    db.run(
        "INSERT INTO arrangements (song_id, version_id, bpm, offset, per_bar, enabled, "
        "data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(song_id) DO UPDATE SET version_id = excluded.version_id, "
        "bpm = excluded.bpm, offset = excluded.offset, per_bar = excluded.per_bar, "
        "enabled = excluded.enabled, data = excluded.data, "
        "updated_at = excluded.updated_at",
        (song["id"], version_id, bpm, offset, per_bar, enabled, data, time.time()))
    return {"arrangement": get_for(song["id"])}


def read(req):
    from . import songs
    song = songs.get(req.params["id"])
    return {"arrangement": get_for(song["id"])}


def shapes(req):
    """The shape of every arrangement that is switched on, in one call.

    The renders list draws a small picture of the arrangement each render ended up in.
    Asking per song meant one request per row, which on a list of fifty is fifty round
    trips for decoration. Only what the picture needs is sent: the sections, their
    lengths and their colours.
    """
    rows = db.query("SELECT song_id, data FROM arrangements WHERE enabled = 1")
    out = {}
    for row in rows:
        try:
            data = json.loads(row["data"] or "{}")
        except ValueError:
            continue
        parts = {p["id"]: p for p in data.get("parts") or []}
        out[str(row["song_id"])] = [
            {"beats": clip.get("beats") or 1,
             "hue": (parts.get(clip.get("part")) or {}).get("hue", 210)}
            for clip in data.get("clips") or []
        ]
    return {"shapes": out}


def switch(req):
    """On or off, without touching the arrangement itself.

    Separate from save because this is the button people press most, and turning the
    compositor off should never be able to lose the shape they built.
    """
    from . import songs
    song = songs.get(req.params["id"])
    on = 1 if need(req.json(), "on") in (True, 1, "1", "true") else 0
    existing = db.one("SELECT song_id FROM arrangements WHERE song_id = ?", (song["id"],))
    if not existing:
        raise Error("that song has no arrangement yet", 404)
    db.run("UPDATE arrangements SET enabled = ?, updated_at = ? WHERE song_id = ?",
           (on, time.time(), song["id"]))
    return {"arrangement": get_for(song["id"])}


def forget(req):
    from . import songs
    song = songs.get(req.params["id"])
    db.run("DELETE FROM arrangements WHERE song_id = ?", (song["id"],))
    return {"arrangement": _blank(song["id"])}


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM arrangements")
    on = db.one("SELECT COUNT(*) AS n FROM arrangements WHERE enabled = 1")
    return {"count": row["n"] if row else 0, "on": on["n"] if on else 0}


def ROUTES():
    return {
        ("GET", "/api/arrangements/shapes"): shapes,
        ("GET", "/api/songs/<id>/arrangement"): read,
        ("PUT", "/api/songs/<id>/arrangement"): save,
        ("POST", "/api/songs/<id>/arrangement/enabled"): switch,
        ("DELETE", "/api/songs/<id>/arrangement"): forget,
    }
