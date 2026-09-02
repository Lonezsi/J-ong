"""What is switched on, and the handful of settings the whole app shares.

The web UI asks this first and hides any feature the server did not report, which is what
makes removing a module from config actually remove it from the interface rather than
leaving a button that returns 404.
"""
import time

from .. import config, registry, blobs
from ..wire import Error

NAME = "core"
SCHEMA = []
_STARTED = time.time()


def state(req):
    return {
        "name": config.settings()["library_name"],
        "modules": registry.enabled(),
        "failed": registry.failures(),
        "summary": registry.summaries(),
        "settings": config.settings(),
        "storage": blobs.usage(),
        "started": _STARTED,
        "uptime": round(time.time() - _STARTED, 1),
    }


def get_settings(req):
    return config.settings()


def put_settings(req):
    patch = req.json()
    allowed = {"library_name", "accent", "auto_update", "sync_interval_minutes"}
    unknown = set(patch) - allowed
    if unknown:
        raise Error("not a setting: " + ", ".join(sorted(unknown)))
    return config.save_settings(patch)


def health(req):
    return {"ok": True, "uptime": round(time.time() - _STARTED, 1)}


def ROUTES():
    return {
        ("GET", "/api/state"): state,
        ("GET", "/api/health"): health,
        ("GET", "/api/settings"): get_settings,
        ("PUT", "/api/settings"): put_settings,
    }
