#!/usr/bin/env python3
"""The J-ong desktop agent.

Watches the folders your renders land in and puts new ones into the library. It reads
those folders and never writes to them.

    python jong_client.py add "C:\\Users\\you\\Music\\Renders"
    python jong_client.py scan            what is new, without sending anything
    python jong_client.py push            send what is new
    python jong_client.py watch           keep doing that
    python jong_client.py update          pull a newer J-ong from GitHub
    python jong_client.py install         run at logon from now on

On sending only what changed: every file is hashed locally and the server is asked which
of those hashes it already holds. Anything it has is skipped without a byte leaving the
machine. That is as far as "only the changes" honestly goes for audio, because a fresh
render of the same song shares essentially no bytes with the one before it.

Standard library only.
"""
import os
import sys
import json
import time
import hashlib
import argparse
import subprocess
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG_PATH = os.environ.get("JONG_CLIENT_CONFIG") or os.path.join(
    os.environ.get("APPDATA") or os.path.expanduser("~/.config"), "jong", "client.json")

AUDIO_EXT = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus")
CHUNK = 1024 * 1024
DEFAULTS = {"server": "http://127.0.0.1:7900", "folders": [], "interval_minutes": 5,
            "auto_new_songs": False}


# ── config ───────────────────────────────────────────────────────────────────
def load_config():
    out = dict(DEFAULTS)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            out.update(json.load(f))
    except (OSError, ValueError):
        pass
    return out


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)


# ── server ───────────────────────────────────────────────────────────────────
class Server:
    def __init__(self, base):
        self.base = base.rstrip("/")

    def _open(self, request, timeout=120):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read().decode("utf-8")
            return json.loads(body) if body else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "ignore")
            try:
                message = json.loads(detail).get("error", detail)
            except ValueError:
                message = detail
            raise SystemExit("J-ong said no (%d): %s" % (e.code, message[:300]))
        except urllib.error.URLError as e:
            raise SystemExit("Cannot reach J-ong at %s: %s\n"
                             "Start it with `python server.py`, or set the address with "
                             "`jong_client.py server <url>`." % (self.base, e.reason))

    def get(self, path):
        return self._open(urllib.request.Request(self.base + path,
                                                 headers={"Accept": "application/json"}))

    def post(self, path, payload):
        data = json.dumps(payload).encode("utf-8")
        return self._open(urllib.request.Request(
            self.base + path, data=data, method="POST",
            headers={"Content-Type": "application/json"}))

    def upload(self, path, file_path, headers=None):
        size = os.path.getsize(file_path)
        with open(file_path, "rb") as f:
            request = urllib.request.Request(
                self.base + path, data=f, method="POST",
                headers=dict({"Content-Type": "application/octet-stream",
                              "Content-Length": str(size)}, **(headers or {})))
            return self._open(request, timeout=900)


def digest_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(folders):
    for folder in folders:
        if not os.path.isdir(folder):
            print("  (missing) %s" % folder)
            continue
        for base, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in sorted(files):
                if os.path.splitext(name)[1].lower() in AUDIO_EXT:
                    yield os.path.join(base, name)


def survey(cfg, server):
    """Everything in the watched folders, split into what the library has and what it does not."""
    paths = list(walk(cfg["folders"]))
    if not paths:
        return [], []
    digests = {}
    for path in paths:
        try:
            digests[path] = digest_of(path)
        except OSError as e:
            print("  (unreadable) %s: %s" % (path, e))

    known, fresh = [], []
    items = list(digests.items())
    # Asked in batches so a folder of a few thousand renders is still one or two calls.
    for start in range(0, len(items), 400):
        batch = items[start:start + 400]
        answer = server.get("/api/versions/have?digest=" +
                            urllib.parse.quote(",".join(d for _, d in batch)))
        have = answer.get("have", {})
        for path, digest in batch:
            match = have.get(digest)
            if match:
                known.append((path, match))
            else:
                fresh.append((path, digest))
    return known, fresh


# ── commands ─────────────────────────────────────────────────────────────────
def cmd_scan(cfg, server, args):
    known, fresh = survey(cfg, server)
    print("%d file(s) already in the library" % len(known))
    if not fresh:
        print("Nothing new.")
        return 0
    print("\n%d new file(s):" % len(fresh))
    for path, _ in fresh:
        guess = server.get("/api/songs/match?name=" +
                           urllib.parse.quote(os.path.basename(path)))
        suggest = guess.get("suggest")
        print("  %s" % os.path.basename(path))
        print("      %s" % (("looks like a new render of %s" % suggest["title"])
                            if suggest else "no obvious match, would be a new song"))
    print("\nRun `push` to send them.")
    return 0


def cmd_push(cfg, server, args):
    known, fresh = survey(cfg, server)
    if not fresh:
        print("Nothing new. %d file(s) already in the library." % len(known))
        return 0

    sent = skipped = 0
    for path, _ in fresh:
        name = os.path.basename(path)
        guess = server.get("/api/songs/match?name=" + urllib.parse.quote(name))
        suggest = guess.get("suggest")

        song_id = None
        if suggest:
            if args.yes or ask("Is %s a new render of %s?" % (name, suggest["title"])):
                song_id = suggest["song_id"]
        if song_id is None:
            title = os.path.splitext(name)[0]
            if not (args.yes or cfg.get("auto_new_songs")):
                if not ask("Add %s as a new song called %s?" % (name, title)):
                    print("  skipped %s" % name)
                    skipped += 1
                    continue
            made = server.post("/api/songs", {"title": title})
            song_id = made["song"]["id"]

        print("  sending %s" % name)
        result = server.upload("/api/songs/%d/versions" % song_id, path,
                               {"X-Filename": name, "X-Source-Path": path})
        version = result.get("version", {})
        if result.get("duplicate"):
            print("      already there as v%s" % version.get("n"))
        else:
            print("      stored as v%s" % version.get("n"))
            sent += 1

    print("\n%d sent, %d skipped, %d already held." % (sent, skipped, len(known)))
    return 0


def ask(question):
    try:
        answer = input("  %s [Y/n] " % question).strip().lower()
    except EOFError:
        return False
    return answer in ("", "y", "yes")


def cmd_watch(cfg, server, args):
    minutes = max(1, int(cfg.get("interval_minutes", 5)))
    print("Watching %d folder(s), every %d minute(s). Ctrl-C to stop."
          % (len(cfg["folders"]), minutes))
    args.yes = True
    while True:
        try:
            _, fresh = survey(cfg, server)
            if fresh:
                print("[%s] %d new" % (time.strftime("%H:%M"), len(fresh)))
                cmd_push(cfg, server, args)
        except SystemExit as e:
            # A watcher that dies because the server was restarted is not a watcher.
            print("[%s] %s" % (time.strftime("%H:%M"), e))
        except Exception as e:
            print("[%s] %s: %s" % (time.strftime("%H:%M"), type(e).__name__, e))
        time.sleep(minutes * 60)


def send_one(cfg, server, path, yes=False):
    """Put one file into the library, asking what it is a new render of."""
    name = os.path.basename(path)
    digest = digest_of(path)
    answer = server.get("/api/versions/have?digest=" + digest)
    held = (answer.get("have") or {}).get(digest)
    if held:
        print("  already here as v%s of %s" % (held["n"], held["title"]))
        return True

    guess = server.get("/api/songs/match?name=" + urllib.parse.quote(name))
    suggest = guess.get("suggest")
    song_id = None
    if suggest:
        if yes or ask("Is %s a new render of %s?" % (name, suggest["title"])):
            song_id = suggest["song_id"]
    if song_id is None:
        title = os.path.splitext(name)[0]
        if not (yes or cfg.get("auto_new_songs")):
            if not ask("Add %s as a new song called %s?" % (name, title)):
                print("  skipped")
                return False
        song_id = server.post("/api/songs", {"title": title})["song"]["id"]

    print("  sending %s" % name)
    result = server.upload("/api/songs/%d/versions" % song_id, path,
                           {"X-Filename": name, "X-Source-Path": path})
    version = result.get("version", {})
    print("      %s as v%s" % ("already there" if result.get("duplicate") else "stored",
                               version.get("n")))
    return True


def cmd_push_file(cfg, server, args):
    """One file, straight from the right click menu."""
    path = os.path.abspath(args.path)
    if not os.path.isfile(path):
        print("There is no file at %s" % path)
        return 1
    if os.path.splitext(path)[1].lower() not in AUDIO_EXT:
        print("%s is not audio J-ong handles." % os.path.basename(path))
        return 1
    print("J-ong at %s" % cfg["server"])
    return 0 if send_one(cfg, server, path, args.yes) else 1


def cmd_render(cfg, server, args):
    """Render an FL project, or every project in a folder, then send the audio in.

    FL Studio's command line render is not headless. Its window opens, and on some
    versions the export dialog waits to be started by hand. That is said out loud here
    rather than discovered after a silent failure.
    """
    import flrender

    path = os.path.abspath(args.path)
    fl = flrender.find_fl(cfg.get("fl_path"))
    if not fl:
        print("FL Studio was not found. Set it once with:")
        print(r'    jong_client.py flpath "C:\Program Files\Image-Line\FL Studio 2024\FL64.exe"')
        return 1
    print("Using %s" % fl)
    print("FL will open while it renders. It is not a silent process, and on some")
    print("versions the export dialog waits for Start to be pressed.")
    print("")

    say = lambda text: print("  " + text, flush=True)
    fmt = cfg.get("render_format", "wav")
    out = cfg.get("render_out") or None

    if os.path.isdir(path):
        done, failed = flrender.render_folder(path, out, fmt, fl, on_step=say)
    elif os.path.isfile(path):
        try:
            done, failed = [flrender.render(path, out, fmt, fl, on_step=say)], []
        except RuntimeError as e:
            print("  %s" % e)
            return 1
    else:
        print("There is nothing at %s" % path)
        return 1

    print("\n%d rendered." % len(done))
    for audio in done:
        send_render(cfg, server, audio)
    if failed:
        print("\n%d did not render:" % len(failed))
        for project, why in failed:
            print("  %s" % os.path.basename(project))
            print("      %s" % why)
    return 0


def send_render(cfg, server, path):
    """Put a fresh render in the library's renders list.

    Not straight onto a song. Which song a render belongs to is a question worth asking
    while looking at the library rather than at a console that is about to close, and a
    batch of forty renders is forty questions nobody wants in a row. They go into a list
    and wait there until they are told.
    """
    name = os.path.basename(path)
    try:
        result = server.upload("/api/renders", path,
                               {"X-Filename": name, "X-Source-Path": path,
                                "X-Origin": "fl"})
    except Exception as e:
        print("  could not send %s: %s" % (name, e))
        return False
    print("  %s %s" % (name, "is waiting in Renders" if result.get("added")
                              else "was already there"))
    return True


def cmd_flpath(cfg, server, args):
    cfg["fl_path"] = args.path
    save_config(cfg)
    print("FL Studio set to %s" % args.path)
    return 0


def cmd_shell(cfg, server, args):
    """The right click menu."""
    import jong_shell
    if os.name != "nt":
        print("The right click menu is a Windows thing.")
        return 0
    if args.action == "remove":
        jong_shell.remove()
        print("Removed.")
        return 0
    written = jong_shell.install()
    print("Added %d entries under HKEY_CURRENT_USER." % len(written))
    for parent, label, _ in jong_shell.installed():
        print("  %-46s %s" % (parent, label))
    return 0


def cmd_add(cfg, server, args):
    path = os.path.abspath(os.path.expanduser(args.path))
    if not os.path.isdir(path):
        print("There is no folder at %s" % path)
        return 1
    if path in cfg["folders"]:
        print("Already watching %s" % path)
        return 0
    cfg["folders"].append(path)
    save_config(cfg)
    print("Watching %s" % path)
    return 0


def cmd_folders(cfg, server, args):
    if not cfg["folders"]:
        print("No folders yet. Add one with `add <path>`.")
    for path in cfg["folders"]:
        print("  %s%s" % (path, "" if os.path.isdir(path) else "   (missing)"))
    print("\nServer: %s" % cfg["server"])
    print("Config: %s" % CONFIG_PATH)
    return 0


def cmd_server(cfg, server, args):
    cfg["server"] = args.url.rstrip("/")
    save_config(cfg)
    print("Server set to %s" % cfg["server"])
    return 0


def cmd_update(cfg, server, args):
    """Pull a newer J-ong. Fast forward only, and never over local edits."""
    def git(*parts):
        done = subprocess.run(("git",) + parts, cwd=ROOT, capture_output=True, text=True)
        return done.returncode, (done.stdout + done.stderr).strip()

    code, _ = git("rev-parse", "--is-inside-work-tree")
    if code != 0:
        print("This copy is not a git checkout, so it cannot update itself.")
        return 1
    code, dirty = git("status", "--porcelain")
    if dirty:
        print("There are uncommitted changes here. Commit or discard them first:")
        print(dirty)
        return 1
    before = git("rev-parse", "HEAD")[1]
    code, out = git("pull", "--ff-only")
    if code != 0:
        print("The pull did not succeed:\n%s" % out)
        return 1
    after = git("rev-parse", "HEAD")[1]
    if before == after:
        print("Already up to date.")
    else:
        print("Updated %s to %s.\nRestart J-ong and this client to run the new code."
              % (before[:7], after[:7]))
    return 0


def cmd_install(cfg, server, args):
    """Make J-ong part of the machine.

    Three things, none of which needs an administrator:
      the folder watcher runs at logon
      the right click menu appears on audio, on .flp files and on folders
      a daily task pulls a newer J-ong from GitHub

    Everything lands under the current user: a per user scheduled task and HKCU registry
    keys. Nothing is written to the machine wide hive, so removing it is complete.

    --server and --folder can be passed to set up in one line:
      python jong_client.py install --server http://127.0.0.1:7900 --folder "~/Renders"
    """
    # Apply any setup flags before installing.
    if args.server:
        cfg["server"] = args.server.rstrip("/")
        save_config(cfg)
        print("Server: %s" % cfg["server"])
    if args.folder:
        added = False
        for raw in args.folder:
            path = os.path.abspath(os.path.expanduser(raw))
            if not os.path.isdir(path):
                print("  (missing) %s" % path)
                continue
            if path not in cfg["folders"]:
                cfg["folders"].append(path)
                added = True
            print("  watching %s" % path)
        if added:
            save_config(cfg)

    if not cfg["folders"]:
        print("No folders to watch. Add one with: --folder <path>")
        return 1

    server = Server(cfg["server"])

    script = os.path.abspath(__file__)
    quoted = '"%s" "%s"' % (sys.executable, script)

    if os.name != "nt":
        print("On this system, add the following to your startup:")
        print("  %s watch" % quoted)
        return 0

    def task(name, arguments, schedule):
        done = subprocess.run(
            ["schtasks", "/Create", "/TN", name, "/TR", "%s %s" % (quoted, arguments),
             "/RL", "LIMITED", "/F"] + schedule,
            capture_output=True, text=True)
        if done.returncode != 0:
            print("  could not create %s:" % name)
            print("      " + (done.stderr or done.stdout).strip().splitlines()[-1][:160])
            return False
        print("  %s" % name)
        return True

    print("Scheduled tasks:")
    task("J-ong watch", "watch", ["/SC", "ONLOGON"])
    # Daily rather than at every start: an update that needs a restart should land at a
    # predictable moment, not in the middle of a session.
    task("J-ong update", "update", ["/SC", "DAILY", "/ST", "05:00"])

    print("Right click menu:")
    try:
        import jong_shell
        written = jong_shell.install()
        for parent, label, _ in jong_shell.installed():
            print("  %-44s %s" % (parent, label))
        if not written:
            print("  nothing added")
    except Exception as e:
        print("  could not add it: %s" % e)

    print("")
    print("Remove all of it with:")
    print('  schtasks /Delete /TN "J-ong watch" /F')
    print('  schtasks /Delete /TN "J-ong update" /F')
    print("  %s shell remove" % quoted)
    return 0


COMMANDS = {
    "scan": cmd_scan, "push": cmd_push, "watch": cmd_watch, "add": cmd_add,
    "folders": cmd_folders, "server": cmd_server, "update": cmd_update,
    "install": cmd_install, "push-file": cmd_push_file, "render": cmd_render,
    "shell": cmd_shell, "flpath": cmd_flpath,
}


def main(argv=None):
    parser = argparse.ArgumentParser(description="The J-ong desktop agent")
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("scan", help="report what is new without sending it")
    push = sub.add_parser("push", help="send what is new")
    push.add_argument("-y", "--yes", action="store_true", help="do not ask about each file")
    sub.add_parser("watch", help="scan and send on a timer")
    add = sub.add_parser("add", help="watch a folder")
    add.add_argument("path")
    sub.add_parser("folders", help="list watched folders")
    where = sub.add_parser("server", help="set the J-ong address")
    where.add_argument("url")
    sub.add_parser("update", help="pull a newer J-ong from GitHub")
    install = sub.add_parser("install", help="run watch at logon, and add the right click menu")
    install.add_argument("--server", help="set the J-ong server address")
    install.add_argument("--folder", action="append", help="watch a folder (repeatable)")
    one = sub.add_parser("push-file", help="send one file, used by the right click menu")
    one.add_argument("path")
    one.add_argument("-y", "--yes", action="store_true")
    render = sub.add_parser("render", help="render an FL project, or a folder of them")
    render.add_argument("path")
    render.add_argument("-y", "--yes", action="store_true")
    where_fl = sub.add_parser("flpath", help="tell it where FL Studio is")
    where_fl.add_argument("path")
    shell = sub.add_parser("shell", help="add or remove the right click menu")
    shell.add_argument("action", nargs="?", default="install",
                       choices=["install", "remove"])
    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return 0
    if not hasattr(args, "yes"):
        args.yes = False

    cfg = load_config()
    server = Server(cfg["server"])
    return COMMANDS[args.command](cfg, server, args)


if __name__ == "__main__":
    sys.exit(main())
