"""Per song playback processing: an EQ curve, a limiter, and presets to compare them.

None of this touches the stored file. The browser builds the filter chain from these
numbers at playback time, so the render you uploaded is the render you keep.

The band list is deliberately open ended rather than a fixed set of sliders, because the
editor lets you put a node anywhere and the server should not be the thing that decides
how many there can be.
"""
import json
import time

from .. import db
from ..wire import Error, need
from . import songs

NAME = "sound"

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS sound_presets (
      id         INTEGER PRIMARY KEY,
      song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      name       TEXT NOT NULL DEFAULT 'Current',
      is_current INTEGER NOT NULL DEFAULT 0,
      data       TEXT NOT NULL DEFAULT '{}',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    )
    """,
    "CREATE INDEX IF NOT EXISTS presets_song ON sound_presets(song_id)",
]

FILTER_TYPES = ("peaking", "lowshelf", "highshelf", "lowpass", "highpass",
                "notch", "bandpass")

DEFAULT = {
    "bands": [],
    "limiter": {"on": False, "threshold": -6.0, "ceiling": -0.3,
                "release": 120.0, "attack": 5.0},
    "gain": 0.0,
    "bypass": False,
}


def _clamp(value, low, high, default):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:  # NaN, which JSON can carry in from a broken client
        return default
    return max(low, min(high, number))


def normalise(raw):
    """Clamp anything a client sends into ranges Web Audio will actually accept.

    A frequency of zero or a Q of NaN does not raise in the browser, it silently produces
    a filter that outputs nothing, which is the worst way to find out.
    """
    if not isinstance(raw, dict):
        raw = {}
    out = {
        "bands": [],
        "limiter": dict(DEFAULT["limiter"]),
        "gain": _clamp(raw.get("gain", 0.0), -24.0, 24.0, 0.0),
        "bypass": bool(raw.get("bypass", False)),
    }
    for band in (raw.get("bands") or [])[:24]:
        if not isinstance(band, dict):
            continue
        kind = band.get("type", "peaking")
        if kind not in FILTER_TYPES:
            kind = "peaking"
        out["bands"].append({
            "id": band.get("id") or ("b%d" % (len(out["bands"]) + 1)),
            "type": kind,
            "freq": _clamp(band.get("freq", 1000), 10.0, 22000.0, 1000.0),
            "gain": _clamp(band.get("gain", 0.0), -30.0, 30.0, 0.0),
            "q": _clamp(band.get("q", 1.0), 0.05, 30.0, 1.0),
            "on": bool(band.get("on", True)),
        })
    limiter = raw.get("limiter") or {}
    if isinstance(limiter, dict):
        out["limiter"] = {
            "on": bool(limiter.get("on", False)),
            "threshold": _clamp(limiter.get("threshold", -6.0), -60.0, 0.0, -6.0),
            "ceiling": _clamp(limiter.get("ceiling", -0.3), -30.0, 0.0, -0.3),
            "release": _clamp(limiter.get("release", 120.0), 1.0, 1000.0, 120.0),
            "attack": _clamp(limiter.get("attack", 5.0), 0.0, 100.0, 5.0),
        }
    return out


def _row(preset):
    preset = dict(preset)
    try:
        preset["data"] = normalise(json.loads(preset["data"]))
    except (ValueError, TypeError):
        preset["data"] = dict(DEFAULT)
    return preset


def get(preset_id):
    row = db.one("SELECT * FROM sound_presets WHERE id = ?", (preset_id,))
    if not row:
        raise Error("no preset with id %s" % preset_id, 404)
    return row


def list_presets(req):
    song = songs.get(req.params["id"])
    rows = db.query("SELECT * FROM sound_presets WHERE song_id = ? ORDER BY id", (song["id"],))
    if not rows:
        # Every song has a Current, created the first time anyone looks. Without it the
        # sound tab would open on nothing and the first edit would have nowhere to go.
        now = time.time()
        preset_id = db.insert("sound_presets", {
            "song_id": song["id"], "name": "Current", "is_current": 1,
            "data": json.dumps(DEFAULT), "created_at": now, "updated_at": now})
        rows = db.query("SELECT * FROM sound_presets WHERE id = ?", (preset_id,))
    return {"presets": [_row(r) for r in rows]}


def create_preset(req):
    song = songs.get(req.params["id"])
    data = req.json()
    name = need(data, "name")
    payload = data.get("data")
    if payload is None and data.get("copy_from"):
        source = get(data["copy_from"])
        if source["song_id"] != song["id"]:
            raise Error("that preset belongs to another song")
        payload = json.loads(source["data"])
    now = time.time()
    preset_id = db.insert("sound_presets", {
        "song_id": song["id"], "name": name, "is_current": 0,
        "data": json.dumps(normalise(payload or DEFAULT)),
        "created_at": now, "updated_at": now})
    return {"preset": _row(get(preset_id))}


def save_preset(req):
    preset = get(req.params["id"])
    body = req.json()
    payload = body.get("data", body)
    db.update("sound_presets", preset["id"], {
        "data": json.dumps(normalise(payload)), "updated_at": time.time()})
    songs.touch(preset["song_id"])
    return {"preset": _row(get(preset["id"]))}


def rename(req):
    preset = get(req.params["id"])
    db.update("sound_presets", preset["id"], {"name": need(req.json(), "name")})
    return {"preset": _row(get(preset["id"]))}


def make_current(req):
    preset = get(req.params["id"])
    db.run("UPDATE sound_presets SET is_current = 0 WHERE song_id = ?", (preset["song_id"],))
    db.update("sound_presets", preset["id"], {"is_current": 1})
    return {"preset": _row(get(preset["id"]))}


def delete_preset(req):
    preset = get(req.params["id"])
    remaining = db.query("SELECT id FROM sound_presets WHERE song_id = ? AND id != ?",
                         (preset["song_id"], preset["id"]))
    if not remaining:
        raise Error("a song keeps at least one preset")
    db.run("DELETE FROM sound_presets WHERE id = ?", (preset["id"],))
    if preset["is_current"]:
        db.update("sound_presets", remaining[0]["id"], {"is_current": 1})
    return {"deleted": preset["id"]}


def SUMMARY():
    row = db.one("SELECT COUNT(*) AS n FROM sound_presets")
    return {"presets": row["n"] if row else 0}


def ROUTES():
    return {
        ("GET", "/api/songs/<id>/sound"): list_presets,
        ("POST", "/api/songs/<id>/sound"): create_preset,
        ("PUT", "/api/sound/<id>"): save_preset,
        ("PATCH", "/api/sound/<id>"): rename,
        ("POST", "/api/sound/<id>/current"): make_current,
        ("DELETE", "/api/sound/<id>"): delete_preset,
    }
