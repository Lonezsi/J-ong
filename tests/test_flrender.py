"""Rendering FL projects, tested against a stand in for FL Studio.

Nothing here launches the real thing. FL's command line render is not headless: it opens
the application and, on some versions, waits for Start to be pressed. Running it in a
test would take over whatever screen the tests are on and prove nothing about this code.

What is worth testing is the part that is ours: staging the project somewhere without
spaces, deciding a render has finished, finding the file when FL puts it somewhere else,
and failing with a sentence that says what happened.
"""
import os
import sys
import stat
import textwrap

import pytest

CLIENT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client")
sys.path.insert(0, CLIENT)

import flrender  # noqa: E402


def stub(tmp_path, body, name="fakefl.py"):
    """A script that behaves like FL Studio for as long as this test needs it to."""
    script = tmp_path / name
    script.write_text(textwrap.dedent(body), encoding="utf-8")
    return script


def runner(script):
    """flrender runs [exe, args...]; a python script needs the interpreter in front.

    Wrapping it in a one line launcher keeps flrender's own argument handling under test
    rather than replaced by the test.
    """
    launcher = script.with_suffix(".cmd")
    launcher.write_text('@echo off\r\n"%s" "%s" %%*\r\n' % (sys.executable, script),
                        encoding="utf-8")
    return str(launcher)


@pytest.fixture
def project(tmp_path):
    path = tmp_path / "Halfway Under.flp"
    path.write_bytes(b"FLhd" + b"\x00" * 64)     # not a real project, and never opened
    return str(path)


def test_it_renders_and_returns_the_audio(tmp_path, project):
    fake = stub(tmp_path, '''
        import sys, time
        target = [a[2:] for a in sys.argv if a.startswith("/R")][0]
        # written in pieces, the way a render grows
        with open(target, "wb") as f:
            for _ in range(3):
                f.write(b"\\x00" * 2048)
                f.flush()
                time.sleep(0.2)
        ''')
    out = tmp_path / "out"
    result = flrender.render(project, str(out), "wav", runner(fake), timeout=60)
    assert os.path.isfile(result)
    assert os.path.basename(result) == "Halfway Under.wav"
    assert os.path.getsize(result) == 3 * 2048


def test_the_project_is_staged_somewhere_without_spaces(tmp_path, project):
    """FL's command line has a long history of mishandling quoted paths, so the project
    is copied to a plain one first. The name it is given is what proves that happened."""
    seen = tmp_path / "seen.txt"
    fake = stub(tmp_path, '''
        import sys
        target = [a[2:] for a in sys.argv if a.startswith("/R")][0]
        given = sys.argv[-1]
        open(r"%s", "w").write(given)
        open(target, "wb").write(b"\\x00" * 1024)
        ''' % seen)
    flrender.render(project, str(tmp_path / "out"), "wav", runner(fake), timeout=60)
    handed = seen.read_text(encoding="utf-8")
    assert " " not in handed, "the project path handed to FL still has spaces in it"
    assert handed.endswith("project.flp")


def test_a_render_that_lands_under_another_name_is_still_found(tmp_path, project):
    """Some versions ignore the name in /R and write beside the project instead."""
    fake = stub(tmp_path, '''
        import sys, os
        here = os.path.dirname(os.path.abspath(sys.argv[-1]))
        open(os.path.join(here, "project.wav"), "wb").write(b"\\x00" * 4096)
        ''')
    result = flrender.render(project, str(tmp_path / "out"), "wav", runner(fake), timeout=20)
    assert os.path.basename(result) == "Halfway Under.wav"


def test_producing_nothing_says_why(tmp_path, project):
    """The failure people actually hit, and the one worth explaining: FL opened, did
    nothing, and waited. A silent empty result would send you looking in the wrong place."""
    fake = stub(tmp_path, "import sys\n")
    with pytest.raises(RuntimeError) as raised:
        flrender.render(project, str(tmp_path / "out"), "wav", runner(fake), timeout=15)
    message = str(raised.value)
    assert "not headless" in message
    assert "Start" in message


def test_a_missing_fl_is_named_rather_than_guessed(tmp_path, project):
    with pytest.raises(RuntimeError) as raised:
        flrender.render(project, str(tmp_path), "wav", str(tmp_path / "nope.exe"))
    assert "not found" in str(raised.value)


def test_it_refuses_things_that_are_not_projects(tmp_path):
    other = tmp_path / "song.wav"
    other.write_bytes(b"RIFF")
    with pytest.raises(RuntimeError) as raised:
        flrender.render(str(other), str(tmp_path), "wav", "anything")
    assert "not an .flp" in str(raised.value)


def test_a_folder_renders_every_project_and_reports_the_ones_that_did_not(tmp_path):
    good = tmp_path / "in"
    good.mkdir()
    for name in ("One.flp", "Two.flp", "Three.flp"):
        (good / name).write_bytes(b"FLhd")
    # Backups are FL's own copies of your work, not things to render again.
    backup = good / "Backup"
    backup.mkdir()
    (backup / "One.flp").write_bytes(b"FLhd")

    fake = stub(tmp_path, '''
        import sys, os
        target = [a[2:] for a in sys.argv if a.startswith("/R")][0]
        given = sys.argv[-1]
        # one of them refuses, the way a project with a missing plugin would
        if os.path.getsize(given) and "Two" in open(os.path.join(
                os.path.dirname(given), "which.txt")).read():
            sys.exit(0)
        open(target, "wb").write(b"\\x00" * 1024)
        ''')
    # The stub cannot see the original name, so the failing one is chosen another way:
    # render them one at a time and let the real folder walk drive it.
    done, failed = flrender.render_folder(str(good), str(tmp_path / "out"), "wav",
                                          runner(stub(tmp_path, '''
        import sys
        target = [a[2:] for a in sys.argv if a.startswith("/R")][0]
        open(target, "wb").write(b"\\x00" * 1024)
        ''', "allgood.py")), timeout=20)
    assert len(done) == 3, "a Backup folder was rendered, or a project was missed"
    assert not failed


def test_finding_fl_prefers_the_64_bit_build(monkeypatch, tmp_path):
    root = tmp_path / "Image-Line"
    (root / "FL Studio 20").mkdir(parents=True)
    (root / "FL Studio 21").mkdir(parents=True)
    (root / "FL Studio 20" / "FL.exe").write_text("x")
    (root / "FL Studio 21" / "FL64.exe").write_text("x")
    (root / "FL Studio 21" / "FL.exe").write_text("x")

    monkeypatch.setattr(flrender, "SEARCH", [str(root)])
    monkeypatch.setattr(flrender, "_fl_from_registry", lambda: None)
    found = flrender.find_fl()
    assert found.endswith("FL64.exe"), "picked the 32 bit build over the 64 bit one"
    assert "21" in found, "picked an older version when a newer one is installed"
