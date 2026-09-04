"""Where things live, and which features are switched on.

Everything J-ong can do is a module, and this file is the list. Comment a name out and
that feature is gone: its tables stop being created, its routes stop existing, and the
web UI stops drawing it, because the UI asks the server what is enabled rather than
assuming. That is the whole swappability story and it is deliberately this boring.
"""
import os
import json

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(BASE, "web")

# Everything the user owns lives under one directory, so a backup is one copy.
DATA = os.environ.get("JONG_DATA") or os.path.join(BASE, "data")
BLOBS = os.path.join(DATA, "blobs")
DB_PATH = os.path.join(DATA, "jong.db")
SETTINGS_PATH = os.path.join(DATA, "settings.json")

HOST = os.environ.get("JONG_HOST", "127.0.0.1")
PORT = int(os.environ.get("JONG_PORT", "7900"))

# Order matters only where one module's tables reference another's.
MODULES = [
    "core",
    # Take this out and the library has no door at all, which is what you want when it
    # only ever listens on localhost.
    "auth",
    "appearance",
    "songs",
    "versions",
    "artwork",
    "lyrics",
    "albums",
    "sound",
    "arrange",
    # On, because "which render is the one that is actually online" turned out to be a
    # real question. J-ong still does not push the file to YouTube: it opens the upload
    # page with the render ready to hand and keeps the link against the version.
    "youtube",
    "renders",
    "playlists",
    "sync",
    "updater",
]

# The repository J-ong updates itself from.
REPO = os.environ.get("JONG_REPO", "Lonezsi/J-ong")
BRANCH = os.environ.get("JONG_BRANCH", "main")

AUDIO_EXT = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus")
IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif")

_DEFAULTS = {
    "library_name": "J-ong",
    "accent": "#54B37A",
    "auto_update": True,
    "sync_interval_minutes": 5,
}


def _read():
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def settings():
    """User settings, with defaults filled in for anything never set."""
    out = dict(_DEFAULTS)
    out.update(_read())
    return out


def save_settings(patch):
    current = _read()
    current.update(patch)
    ensure_dirs()
    tmp = SETTINGS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)
    return settings()


def ensure_dirs():
    for path in (DATA, BLOBS):
        os.makedirs(path, exist_ok=True)
