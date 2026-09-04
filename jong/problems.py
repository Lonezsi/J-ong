"""What went wrong, kept where it can be read.

Every handler exception used to be turned into `str(e)` in a 500 body and the traceback
discarded on the spot: no file, no line number, nothing anywhere. On a machine you reach
over a tunnel that is the whole of your diagnostics, and `str(e)` on a KeyError is a
single quoted word.

In memory on purpose. Nothing new on disk means nothing to prune, nothing to rotate,
nothing that can fill the drive on a host nobody is watching, and no write to the
database from the one code path where a write is least likely to succeed. The cost is
honest and worth saying: a restart takes the history with it, and the watchdog restarting
the server is exactly when you would go looking. What survives a restart is the fact that
a module failed to load, which the registry already keeps.
"""
import time
import threading
import traceback

#: How many to keep. Two hundred is far more than one person generates in a day and still
#: a fixed, small amount of memory.
LIMIT = 200

_lock = threading.Lock()
_seen = []
_dropped = 0


def record(where, error, method=None):
    """Keep one failure. Returns the short reference put in the reply.

    The reference is what makes the two ends meet: the browser is told
    "something failed (a3f)" and the same a3f is at the top of this list, so a
    person reporting a fault and the traceback explaining it can be lined up
    without timestamps and guesswork.
    """
    global _dropped
    now = time.time()
    ref = "%03x" % (int(now * 1000) & 0xFFF)
    entry = {
        "ref": ref,
        "at": now,
        "where": where,
        "method": method,
        "kind": type(error).__name__,
        "message": str(error),
        "traceback": "".join(traceback.format_exception(
            type(error), error, error.__traceback__)),
    }
    with _lock:
        _seen.append(entry)
        while len(_seen) > LIMIT:
            _seen.pop(0)
            _dropped += 1
    return ref


def recent(limit=50):
    """Newest first, because the one you want is the one that just happened."""
    with _lock:
        return list(reversed(_seen))[:max(1, int(limit))]


def count():
    with _lock:
        return {"kept": len(_seen), "dropped": _dropped}


def clear():
    global _dropped
    with _lock:
        _seen.clear()
        _dropped = 0
