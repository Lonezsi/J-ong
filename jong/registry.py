"""Loading whichever features are switched on.

A module is a file in jong/modules/ that may define:

    NAME     str, defaults to the file name
    SCHEMA   list of CREATE TABLE statements, run at startup, must be IF NOT EXISTS
    MIGRATE  optional callable, run after SCHEMA, for adding columns to old databases
    ROUTES   callable returning {(method, pattern): handler}
    SUMMARY  optional callable returning a small dict for /api/state

Nothing else in J-ong imports a module directly. If a name is missing from
config.MODULES the code is still on disk and simply never runs.
"""
import importlib
import traceback

from . import config, db

_loaded = {}
_routes = {}
_failed = {}


def load(names=None):
    """Import the enabled modules, create their tables, collect their routes."""
    global _loaded, _routes, _failed
    _loaded, _routes, _failed = {}, {}, {}
    for name in (names if names is not None else config.MODULES):
        try:
            module = importlib.import_module("jong.modules." + name)
        except Exception:
            _failed[name] = traceback.format_exc(limit=3)
            continue
        try:
            schema = getattr(module, "SCHEMA", [])
            if schema:
                db.apply_schema(schema)
            migrate = getattr(module, "MIGRATE", None)
            if migrate:
                migrate()
            for key, handler in (getattr(module, "ROUTES", dict)() or {}).items():
                # Two modules claiming one route used to be settled by load order, with
                # nothing said anywhere: the loser's endpoint simply stopped existing and
                # the module still reported itself loaded. Whichever one is second is the
                # one that failed, and it says so.
                if key in _routes:
                    raise RuntimeError(
                        "%s %s is already served by another module" % (key[0], key[1]))
                _routes[key] = handler
        except Exception:
            # A module that cannot set itself up is switched off rather than taking the
            # server down. The rest of the library still opens.
            _failed[name] = traceback.format_exc(limit=3)
            continue
        _loaded[getattr(module, "NAME", name)] = module
    return _loaded


def routes():
    return _routes


def enabled():
    return sorted(_loaded)


def failures():
    return dict(_failed)


def has(name):
    return name in _loaded


def summaries():
    """Whatever each module wants to say about itself on the state endpoint."""
    out = {}
    for name, module in _loaded.items():
        fn = getattr(module, "SUMMARY", None)
        if not fn:
            continue
        try:
            out[name] = fn()
        except Exception:
            out[name] = {"error": "summary failed"}
    return out
