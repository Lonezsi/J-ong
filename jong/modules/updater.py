"""Keeping J-ong up to date from its own GitHub repository.

The check is read only and says plainly when it cannot tell. Applying an update is a
fast forward pull and nothing else: no reset, no force, no stash. If the working tree has
been edited by hand, the update refuses and says so rather than throwing that work away.
"""
import os
import json
import subprocess
import urllib.error
import urllib.request

from .. import config
from ..wire import Error

NAME = "updater"
SCHEMA = []

TIMEOUT = 25


def _git(*args):
    try:
        done = subprocess.run(
            ("git",) + args, cwd=config.BASE, capture_output=True, text=True, timeout=TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    if done.returncode != 0:
        return None, (done.stderr or done.stdout).strip()
    return done.stdout.strip(), None


def _is_repo():
    out, _ = _git("rev-parse", "--is-inside-work-tree")
    return out == "true"


def _remote_head():
    """The newest commit on the tracked branch, straight from the GitHub API."""
    url = "https://api.github.com/repos/%s/commits/%s" % (config.REPO, config.BRANCH)
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json", "User-Agent": "J-ong"})
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return {"sha": payload.get("sha", ""),
            "message": (payload.get("commit", {}).get("message") or "").split("\n")[0],
            "date": payload.get("commit", {}).get("committer", {}).get("date", "")}


def check(req):
    if not _is_repo():
        return {"can_update": False,
                "why": "This copy of J-ong is not a git checkout, so it cannot update itself."}
    local, error = _git("rev-parse", "HEAD")
    if error:
        return {"can_update": False, "why": "git could not be read: " + error}

    try:
        remote = _remote_head()
    except (urllib.error.URLError, OSError, ValueError) as e:
        # Saying the check failed is the point. Reporting "up to date" when the question
        # was never asked is the failure mode worth avoiding.
        return {"can_update": False, "local": local, "checked": False,
                "why": "GitHub could not be reached: %s" % e}

    dirty, _ = _git("status", "--porcelain")
    behind = bool(remote["sha"]) and remote["sha"] != local
    return {
        "checked": True,
        "local": local,
        "remote": remote["sha"],
        "message": remote["message"],
        "date": remote["date"],
        "update_available": behind,
        "can_update": behind and not dirty,
        "dirty": bool(dirty),
        "why": ("There are uncommitted changes here, so the update was not applied."
                if behind and dirty else ""),
        "repo": config.REPO,
        "branch": config.BRANCH,
    }


def apply(req):
    if not _is_repo():
        raise Error("This copy of J-ong is not a git checkout, so it cannot update itself.", 409)
    dirty, _ = _git("status", "--porcelain")
    if dirty:
        raise Error("There are uncommitted changes here. Commit or discard them first, "
                    "then update.", 409)
    before, _ = _git("rev-parse", "HEAD")
    out, error = _git("pull", "--ff-only", "origin", config.BRANCH)
    if error:
        raise Error("The pull did not succeed: " + error, 502)
    after, _ = _git("rev-parse", "HEAD")
    changed = before != after
    names = []
    if changed:
        listing, _ = _git("diff", "--name-only", before, after)
        names = (listing or "").splitlines()
    return {
        "updated": changed,
        "before": before,
        "after": after,
        "files": names,
        # Python has already imported the old modules, so the new ones are on disk and
        # not in memory. Saying this is the difference between an update that worked and
        # an update that looks like it did nothing.
        "restart_required": changed and any(n.endswith(".py") for n in names),
        "message": ("Updated. Restart J-ong to run the new code."
                    if changed else "Already up to date."),
    }


def SUMMARY():
    if not _is_repo():
        return {"git": False}
    local, _ = _git("rev-parse", "--short", "HEAD")
    return {"git": True, "commit": local or "unknown"}


def ROUTES():
    return {
        ("GET", "/api/update/check"): check,
        ("POST", "/api/update/apply"): apply,
    }
