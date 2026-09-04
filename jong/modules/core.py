"""What is switched on, and the handful of settings the whole app shares.

The web UI asks this first and hides any feature the server did not report, which is what
makes removing a module from config actually remove it from the interface rather than
leaving a button that returns 404.
"""
import time

from .. import config, registry, blobs, db, problems
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
    """Is this process alive, and separately, is the library it is serving whole.

    `ok` stays pure liveness plus one query, because the host watchdog force-kills on it
    and a module that failed to load is not something restarting will fix: reporting that
    as unhealthy would put an unattended machine into a kill loop over a bad migration.
    `degraded` says what is wrong so it can be seen without SSH, and the watchdog is
    expected to log it and leave the server alone.
    """
    out = {"ok": True, "uptime": round(time.time() - _STARTED, 1)}
    try:
        db.one("SELECT 1 AS one")
    except Exception as e:
        # The port answering while the database does not is exactly the wedged state the
        # watchdog exists for, and it was invisible to it.
        out["ok"] = False
        out["degraded"] = ["the database did not answer: %s" % e]
        return out

    kept = problems.count()
    if kept["kept"]:
        out["problems"] = kept["kept"]

    failed = registry.failures()
    door = None
    if registry.has("auth"):
        from . import auth
        door = auth.damaged()
    trouble = ["%s did not load" % name for name in sorted(failed)]
    if door:
        trouble.append(door)
    if trouble:
        out["degraded"] = trouble
    return out


def errors(req):
    """The tracebacks this server has produced since it started.

    Behind the door, unlike /api/health, because a traceback names paths on the machine
    and the shape of the code. Not on disk: see jong/problems.py for why, and for what
    that costs.
    """
    return {"errors": problems.recent(int(req.q("limit") or 50)), **problems.count()}


def forget_errors(req):
    problems.clear()
    return {"cleared": True}


def ROUTES():
    return {
        ("GET", "/api/state"): state,
        ("GET", "/api/health"): health,
        ("GET", "/api/health/errors"): errors,
        ("DELETE", "/api/health/errors"): forget_errors,
        ("GET", "/api/settings"): get_settings,
        ("PUT", "/api/settings"): put_settings,
    }
