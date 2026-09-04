"""Content addressed file storage.

Every file is stored once under the SHA-256 of its bytes. Two identical renders uploaded
from two machines occupy one file, and re-uploading a render you already have costs
nothing but the hash.

This is what "only store the changes" honestly means for audio. A new MP3 render of the
same song shares almost no bytes with the previous one, because re-encoding rewrites the
whole stream, so a binary delta would save close to nothing. Deduplication saves the case
that actually happens: the same file arriving more than once.
"""
import os
import time
import hashlib
import tempfile
import shutil

from . import config

CHUNK = 1024 * 1024


def path_for(digest):
    """Two levels of fan out, so no directory ends up with fifty thousand entries."""
    return os.path.join(config.BLOBS, digest[:2], digest[2:4], digest)


def exists(digest):
    return os.path.isfile(path_for(digest))


def hash_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def put_bytes(data):
    """Store bytes, returning (digest, was_new)."""
    digest = hashlib.sha256(data).hexdigest()
    dest = path_for(digest)
    if os.path.isfile(dest):
        return digest, False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # Named per call for the same reason put_stream is: two callers storing the same
    # bytes at the same moment would otherwise share one temporary file.
    handle, tmp = tempfile.mkstemp(prefix=os.path.basename(dest) + ".",
                                   suffix=".part", dir=os.path.dirname(dest))
    try:
        with os.fdopen(handle, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, dest)
        tmp = None
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)
    _forget_usage()
    return digest, True


def put_stream(stream, length):
    """Store a request body without holding it all in memory. Returns (digest, size, was_new).

    The bytes land in a temporary file first because the name cannot be known until the
    last byte has been read.

    That temporary file gets a name of its own per call. It used to be named after the
    process, which is one name for the whole server: two uploads arriving together are
    two threads in here, and they wrote into the same file while each hashed its own
    stream in memory. Both were then told they had succeeded, one digest ended up
    pointing at the other song's bytes, and the other pointed at nothing at all, because
    the first rename had already carried the file away. Nothing raised. In a store that
    is addressed by content, a wrong file under a right name is permanent: exists() only
    stats the path, so it shadows every correct upload of that audio ever after.
    """
    config.ensure_dirs()
    handle, tmp = tempfile.mkstemp(prefix="incoming.", suffix=".part", dir=config.BLOBS)
    h = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(handle, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = stream.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                size += len(chunk)
                h.update(chunk)
                f.write(chunk)
            # On disk before it is given the name that promises what is in it. Without
            # this a machine that loses power between the rename and the flush comes back
            # with a truncated file under a valid digest, which is the same permanent
            # shadow arrived at from the other direction.
            f.flush()
            os.fsync(f.fileno())
        digest = h.hexdigest()
        dest = path_for(digest)
        if os.path.isfile(dest):
            return digest, size, False
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        os.replace(tmp, dest)
        tmp = None
        _forget_usage()
        return digest, size, True
    finally:
        if tmp and os.path.exists(tmp):
            os.remove(tmp)


def put_path(path):
    """Copy a file on disk into the store. Returns (digest, size, was_new)."""
    digest = hash_file(path)
    size = os.path.getsize(path)
    dest = path_for(digest)
    if os.path.isfile(dest):
        return digest, size, False
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    tmp = dest + ".part"
    shutil.copyfile(path, tmp)
    os.replace(tmp, dest)
    _forget_usage()
    return digest, size, True


def size_of(digest):
    try:
        return os.path.getsize(path_for(digest))
    except OSError:
        return 0


def delete(digest):
    """Only ever called once nothing references the blob. Callers check, not this."""
    try:
        os.remove(path_for(digest))
        _forget_usage()
        return True
    except OSError:
        return False


#: How long a storage total is allowed to be out of date, in seconds.
#:
#: Walking every blob is fine for a handful of files and slow for a library of a few
#: hundred, and it sat on /api/state, which is asked for on every page load. Nothing
#: depends on this number being to the byte: it is shown on the settings page.
USAGE_TTL = 30.0
#: Keyed by which store it counted, because a test, or a second library on the same
#: machine, must never be handed another one's total.
_usage = {"at": 0.0, "value": None, "where": None}


def _forget_usage():
    """Called by everything that adds or removes a blob, so the total is never stale
    because of something this process did. The clock is only a backstop for changes
    made to the folder from outside."""
    _usage["value"] = None


def usage(fresh=False):
    now = time.time()
    if (not fresh and _usage["value"] and _usage["where"] == config.BLOBS
            and now - _usage["at"] < USAGE_TTL):
        return _usage["value"]
    total = count = 0
    for root, _, files in os.walk(config.BLOBS):
        for name in files:
            if name.endswith(".part"):
                continue
            try:
                total += os.path.getsize(os.path.join(root, name))
                count += 1
            except OSError:
                pass
    _usage["at"] = now
    _usage["where"] = config.BLOBS
    _usage["value"] = {"files": count, "bytes": total}
    return _usage["value"]
