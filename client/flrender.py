#!/usr/bin/env python3
"""Rendering FL Studio projects from a script.

What this can honestly do, and what it cannot.

FL Studio takes a /R switch that renders a project, and it works, but it is not a
headless renderer. Launching it opens the application: you will see FL's window, it
loads the project, and on some versions the export dialog waits for a press of Start.
Image-Line's own forum has people asking about exactly this and getting no better
answer. So this does not pretend the render is silent. It starts FL, waits for the
output file to appear and stop growing, and reports honestly when it did not.

Waiting on the file rather than on FL's window title is deliberate. Title watching is
what most scripts do, but it breaks on a different language, a different version, and
anywhere the window is not visible. A file that has stopped growing is the same fact on
every machine.

Standard library only.
"""
import os
import re
import sys
import time
import shutil
import tempfile
import subprocess

AUDIO_OUT = (".wav", ".mp3", ".flac", ".ogg")

# Where FL Studio installs itself, newest looking first.
SEARCH = [
    r"C:\Program Files\Image-Line",
    r"C:\Program Files (x86)\Image-Line",
    os.path.expandvars(r"%LOCALAPPDATA%\Image-Line"),
    os.path.expandvars(r"%PROGRAMFILES%\Image-Line"),
]


def find_fl(explicit=None):
    """The FL Studio executable, or None.

    An explicit path wins. Otherwise the file association is asked first, because that
    is the copy Windows itself opens a project with, and only then the usual folders.
    """
    if explicit:
        return explicit if os.path.isfile(explicit) else None

    from_registry = _fl_from_registry()
    if from_registry:
        return from_registry

    found = []
    for root in SEARCH:
        if not os.path.isdir(root):
            continue
        for base, dirs, files in os.walk(root):
            if base.count(os.sep) - root.count(os.sep) > 2:
                dirs[:] = []
                continue
            for name in files:
                if name.lower() in ("fl64.exe", "fl.exe"):
                    found.append(os.path.join(base, name))
    if not found:
        return None
    # Prefer the 64 bit build, then the highest version number in the path.
    def rank(path):
        digits = re.findall(r"(\d+)", path)
        return (0 if "fl64" in os.path.basename(path).lower() else 1,
                [-int(d) for d in digits[:3]])
    found.sort(key=rank)
    return found[0]


def _fl_from_registry():
    """Whatever Windows opens a .flp with."""
    if os.name != "nt":
        return None
    try:
        import winreg
    except ImportError:
        return None
    for hive, path in ((winreg.HKEY_CLASSES_ROOT, r"FLStudio.Project\shell\open\command"),
                       (winreg.HKEY_CLASSES_ROOT, r"Image-Line.FLP\shell\open\command")):
        try:
            with winreg.OpenKey(hive, path) as key:
                command = winreg.QueryValueEx(key, "")[0]
        except OSError:
            continue
        match = re.match(r'"([^"]+)"', command) or re.match(r"(\S+)", command)
        if match and os.path.isfile(match.group(1)):
            return match.group(1)
    return None


def _settled(path, quiet_for=4.0, timeout=1800, started=None):
    """Wait until a file exists and has stopped growing.

    A render writes continuously, so "the same size for a few seconds" is the end of it.
    Nothing here reads FL's window, which means it behaves the same in any language and
    with the window off screen.
    """
    deadline = time.time() + timeout
    last_size, still_since = -1, None
    while time.time() < deadline:
        if os.path.isfile(path):
            try:
                size = os.path.getsize(path)
            except OSError:
                size = -1
            if size > 0 and size == last_size:
                if still_since and time.time() - still_since >= quiet_for:
                    return True
                if not still_since:
                    still_since = time.time()
            else:
                still_since = None
                last_size = size
        if started is not None and started.poll() is not None and not os.path.isfile(path):
            # FL exited without producing anything; no point waiting out the timeout.
            time.sleep(2)
            return os.path.isfile(path)
        time.sleep(1)
    return False


def render(project, out_dir=None, fmt="wav", fl=None, timeout=1800, on_step=None):
    """Render one .flp. Returns the path to the audio, or raises RuntimeError.

    The project is copied somewhere without spaces first. FL's command line has a long
    history of mishandling quoted paths, and a copy costs a moment against a render that
    silently does nothing.
    """
    say = on_step or (lambda text: None)
    project = os.path.abspath(project)
    if not os.path.isfile(project):
        raise RuntimeError("no project at %s" % project)
    if os.path.splitext(project)[1].lower() != ".flp":
        raise RuntimeError("%s is not an .flp" % os.path.basename(project))

    exe = find_fl(fl)
    if not exe:
        raise RuntimeError(
            "FL Studio was not found. Pass its path with --fl, for example "
            r'--fl "C:\Program Files\Image-Line\FL Studio 2024\FL64.exe"')

    out_dir = os.path.abspath(out_dir or os.path.dirname(project))
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(project))[0]

    work = tempfile.mkdtemp(prefix="jongfl")
    try:
        staged = os.path.join(work, "project.flp")
        shutil.copyfile(project, staged)
        target = os.path.join(work, "render." + fmt.lower())

        say("rendering %s with %s" % (os.path.basename(project), os.path.basename(exe)))
        command = [exe, "/R" + target, "/E" + fmt.lower(), staged]
        started = subprocess.Popen(command, cwd=work)

        produced = None
        if _settled(target, timeout=timeout, started=started):
            produced = target
        else:
            # Some versions ignore the name in /R and write beside the project instead.
            for name in os.listdir(work):
                if os.path.splitext(name)[1].lower() in AUDIO_OUT:
                    produced = os.path.join(work, name)
                    break

        if started.poll() is None:
            say("FL is still open; leaving it alone")

        if not produced or not os.path.isfile(produced):
            raise RuntimeError(
                "FL Studio did not produce a file for %s. Its command line render is "
                "not headless: it opens the application, and on some versions the "
                "export dialog waits for Start to be pressed." % os.path.basename(project))

        final = os.path.join(out_dir, "%s.%s" % (stem, fmt.lower()))
        shutil.copyfile(produced, final)
        say("wrote %s" % final)
        return final
    finally:
        shutil.rmtree(work, ignore_errors=True)


def render_folder(folder, out_dir=None, fmt="wav", fl=None, timeout=1800, on_step=None):
    """Render every project in a folder. Returns (done, failed)."""
    say = on_step or (lambda text: None)
    folder = os.path.abspath(folder)
    projects = []
    for base, dirs, files in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d.lower() != "backup"]
        for name in sorted(files):
            if name.lower().endswith(".flp"):
                projects.append(os.path.join(base, name))

    if not projects:
        say("no .flp files under %s" % folder)
        return [], []

    say("%d project%s to render" % (len(projects), "" if len(projects) == 1 else "s"))
    done, failed = [], []
    for index, project in enumerate(projects, 1):
        say("[%d/%d] %s" % (index, len(projects), os.path.basename(project)))
        try:
            done.append(render(project, out_dir, fmt, fl, timeout, say))
        except RuntimeError as e:
            say("      %s" % e)
            failed.append((project, str(e)))
    return done, failed


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Render FL Studio projects")
    parser.add_argument("path", help="an .flp file, or a folder of them")
    parser.add_argument("--out", help="where the audio goes")
    parser.add_argument("--format", default="wav", choices=["wav", "mp3", "flac", "ogg"])
    parser.add_argument("--fl", help="path to FL64.exe")
    parser.add_argument("--timeout", type=int, default=1800)
    args = parser.parse_args()

    speak = lambda text: print("  " + text, flush=True)
    if os.path.isdir(args.path):
        done, failed = render_folder(args.path, args.out, args.format, args.fl,
                                     args.timeout, speak)
        print("\n%d rendered, %d failed" % (len(done), len(failed)))
        sys.exit(1 if failed else 0)
    try:
        print(render(args.path, args.out, args.format, args.fl, args.timeout, speak))
    except RuntimeError as e:
        print(e)
        sys.exit(1)
