"""The display face, when you would rather use your own.

J-ong ships with an open licensed typeface and will happily use a different one, but it
never carries that file. You upload it, it lives in your data directory, and it is served
only to your own library. That keeps a licensed or shareware font where its licence
expects it to be: on your machine, rather than committed to a public repository and
handed to everyone who clones it.
"""
import os
import time

from .. import config, blobs
from ..wire import Error, Response, as_int

NAME = "appearance"
SCHEMA = []

FONT_EXT = {".ttf": "font/ttf", ".otf": "font/otf",
            ".woff": "font/woff", ".woff2": "font/woff2"}
MAX_BYTES = 8 * 1024 * 1024


def _dir():
    return os.path.join(config.DATA, "appearance")


def _find():
    """The uploaded display font, if there is one."""
    try:
        for name in sorted(os.listdir(_dir())):
            if os.path.splitext(name)[1].lower() in FONT_EXT:
                return os.path.join(_dir(), name)
    except OSError:
        pass
    return None


def state():
    path = _find()
    if not path:
        return {"custom_font": False}
    return {"custom_font": True,
            "font_name": os.path.basename(path),
            "font_format": FONT_EXT[os.path.splitext(path)[1].lower()],
            "uploaded_at": os.path.getmtime(path)}


def get_font(req):
    path = _find()
    if not path:
        raise Error("no display font has been uploaded", 404)
    return Response(path=path,
                    content_type=FONT_EXT[os.path.splitext(path)[1].lower()])


def upload_font(req):
    length = as_int(req.headers.get("Content-Length") or 0, "Content-Length")
    if length <= 0:
        raise Error("no font in that upload")
    if length > MAX_BYTES:
        raise Error("a display font over %d MB is not a display font" % (MAX_BYTES // 1048576))

    filename = (req.headers.get("X-Filename") or "display.ttf").strip()
    ext = os.path.splitext(filename)[1].lower()
    if ext not in FONT_EXT:
        raise Error("J-ong takes .ttf, .otf, .woff or .woff2, not %s" % (ext or filename))

    body = req.rfile.read(length)
    # Enough of a check to catch a renamed zip or an html error page, without pretending
    # to validate a font. The four leading bytes are the format's own signature.
    signature = body[:4]
    known = (b"\x00\x01\x00\x00", b"OTTO", b"true", b"ttcf", b"wOFF", b"wOF2")
    if not signature.startswith(known):
        raise Error("that file does not look like a font. Is it still inside a zip?")

    os.makedirs(_dir(), exist_ok=True)
    for old in os.listdir(_dir()):          # one display font at a time
        try:
            os.remove(os.path.join(_dir(), old))
        except OSError:
            pass
    safe = "display" + ext
    with open(os.path.join(_dir(), safe), "wb") as f:
        f.write(body)
    return {"ok": True, "font": state()}


def clear_font(req):
    path = _find()
    if path:
        os.remove(path)
    return {"ok": True, "font": state()}


def SUMMARY():
    return state()


def ROUTES():
    return {
        ("GET", "/api/appearance/font"): get_font,
        ("POST", "/api/appearance/font"): upload_font,
        ("DELETE", "/api/appearance/font"): clear_font,
    }
