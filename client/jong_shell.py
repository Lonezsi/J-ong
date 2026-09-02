#!/usr/bin/env python3
"""The right click menu.

Four entries, all written under HKEY_CURRENT_USER:

    an audio file   Upload to J-ong
    an .flp         Render and send to J-ong
    a folder        Render every FL project in here
    a folder        Watch this folder

HKCU rather than HKLM on purpose. Per user keys need no administrator, they are visible
in one place, and removing them takes the integration away completely. Nothing here
writes to the machine wide hive or touches file associations: opening a .mp3 still opens
whatever opened it before.

Standard library only, and a no op anywhere that is not Windows.
"""
import os
import sys

KEY_ROOT = r"Software\Classes"
AUDIO_EXT = (".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus")

# name, where it hangs, the label, and the argument Windows substitutes
ENTRIES = [
    ("JongUpload", [r"SystemFileAssociations\%s\shell" % ext for ext in AUDIO_EXT],
     "Upload to J-ong", "push-file", "%1"),
    ("JongRenderFlp", [r"SystemFileAssociations\.flp\shell"],
     "Render and send to J-ong", "render", "%1"),
    ("JongRenderFolder", [r"Directory\shell", r"Directory\Background\shell"],
     "Render every FL project in here", "render", "%V"),
    ("JongWatchFolder", [r"Directory\shell"],
     "Watch this folder with J-ong", "add", "%V"),
]


def _winreg():
    if os.name != "nt":
        return None
    try:
        import winreg
        return winreg
    except ImportError:
        return None


def _runner():
    """How to start the client from a shell entry.

    py.exe when it is there, because it survives Python being upgraded underneath the
    registry entry. A bare python.exe path stops working the day the interpreter moves.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    client = os.path.join(here, "jong_client.py")
    launcher = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "py.exe")
    if os.path.isfile(launcher):
        return '"%s" -3 "%s"' % (launcher, client)
    return '"%s" "%s"' % (sys.executable, client)


def install(keep_open=True):
    """Add the entries. Returns a list of what was written."""
    winreg = _winreg()
    if not winreg:
        return []
    runner = _runner()
    written = []
    for name, parents, label, command, argument in ENTRIES:
        for parent in parents:
            base = "%s\\%s\\%s" % (KEY_ROOT, parent, name)
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, label)
                # A folder entry is only worth showing on folders, and Windows uses this
                # to keep it out of the way elsewhere.
                winreg.SetValueEx(key, "Icon", 0, winreg.REG_SZ, sys.executable)
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\command") as key:
                # The console stays open on purpose: this is the only place the answers
                # to "is this a new render of X?" can be given.
                line = '%s %s "%s"' % (runner, command, argument)
                if keep_open:
                    line = 'cmd /c "%s & pause"' % line.replace('"', '""')
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, line)
            written.append(base)
    return written


def remove():
    """Take them all away again."""
    winreg = _winreg()
    if not winreg:
        return []
    gone = []
    for name, parents, _, _, _ in ENTRIES:
        for parent in parents:
            base = "%s\\%s\\%s" % (KEY_ROOT, parent, name)
            for path in (base + r"\command", base):
                try:
                    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
                except OSError:
                    continue
            gone.append(base)
    return gone


def installed():
    """Which entries are actually present, so the answer is read rather than assumed."""
    winreg = _winreg()
    if not winreg:
        return []
    present = []
    for name, parents, label, _, _ in ENTRIES:
        for parent in parents:
            base = "%s\\%s\\%s\\command" % (KEY_ROOT, parent, name)
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, base) as key:
                    present.append((parent, label, winreg.QueryValueEx(key, "")[0]))
            except OSError:
                pass
    return present


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    if os.name != "nt":
        print("The right click menu is a Windows thing; nothing to do here.")
        sys.exit(0)
    if action == "install":
        written = install()
        print("Added %d entries:" % len(written))
        for path in written:
            print("  HKCU\\" + path)
        print("\nRight click an mp3, an flp, or a folder.")
    elif action == "remove":
        remove()
        print("Removed. Right click menus are back to how they were.")
    else:
        rows = installed()
        if not rows:
            print("Not installed. Run: python jong_shell.py install")
        for parent, label, command in rows:
            print("  %-46s %s" % (parent, label))
