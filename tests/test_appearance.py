"""The display font.

The face used for titles is the one piece of the design the owner is expected to change,
because the one this library was drawn around is shareware and cannot ship in a public
repository. So the upload has to be forgiving about what it accepts and unforgiving about
what it writes: a font arrives with a name chosen by whoever made it, and that name is
not something to build a file path out of.
"""
import os

SIGNATURES = {
    "ttf": b"\x00\x01\x00\x00",
    "otf": b"OTTO",
    "woff": b"wOFF",
    "woff2": b"wOF2",
}


def a_font(tmp_path, name="Orena.ttf", kind="ttf", size=4096):
    """Enough of a font to be accepted. Not enough to render, which is not what is
    being tested: the server does not rasterise anything."""
    path = tmp_path / name
    path.write_bytes(SIGNATURES[kind] + b"\x00" * size)
    return str(path)


def upload(server, path, filename=None):
    with open(path, "rb") as f:
        blob = f.read()
    return server.request("POST", "/api/appearance/font", data=blob, headers={
        "Content-Type": "application/octet-stream",
        "X-Filename": filename or os.path.basename(path),
    })


def test_a_library_starts_with_no_font_of_its_own(server):
    status, state = server.get("/api/state")
    assert status == 200
    assert state["summary"]["appearance"] == {"custom_font": False}


def test_an_uploaded_font_keeps_the_name_it_arrived_with(server, tmp_path):
    """The file on disk is display.ttf, because a name chosen by a stranger is not a
    path. The settings page still has to say Orena.ttf, which is what you uploaded and
    what you will be looking for."""
    status, result = upload(server, a_font(tmp_path, "Orena.ttf"))
    assert status == 200, result
    assert result["font"]["custom_font"] is True
    assert result["font"]["font_name"] == "Orena.ttf"
    assert result["font"]["font_format"] == "font/ttf"

    _, state = server.get("/api/state")
    assert state["summary"]["appearance"]["font_name"] == "Orena.ttf"


def test_the_file_on_disk_is_not_named_by_the_uploader(server, tmp_path):
    from jong import config
    upload(server, a_font(tmp_path), filename="../../../nice try.ttf")
    here = os.path.join(config.DATA, "appearance")
    written = sorted(os.listdir(here))
    assert written, "nothing was stored"
    for name in written:
        assert name.startswith("display."), "a font was stored under a supplied name: %s" % name
        assert os.path.abspath(os.path.join(here, name)).startswith(os.path.abspath(here))


def test_the_font_is_served_back_as_a_font(server, tmp_path):
    upload(server, a_font(tmp_path, "Orena.otf", kind="otf"))
    status, body = server.get("/api/appearance/font")
    assert status == 200
    assert body[:4] == b"OTTO", "that is not the font that went in"


def test_a_file_that_is_not_a_font_is_refused(server, tmp_path):
    """The common mistake is uploading the zip a font came in, which has an html error
    page's odds of being a typeface."""
    junk = tmp_path / "Orena.ttf"
    junk.write_bytes(b"PK\x03\x04" + b"\x00" * 500)
    status, answer = upload(server, str(junk))
    assert status == 400
    assert "zip" in answer["error"]


def test_something_that_is_not_a_font_format_is_refused(server, tmp_path):
    picture = tmp_path / "cover.png"
    picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 200)
    status, answer = upload(server, str(picture))
    assert status == 400
    assert ".png" in answer["error"]


def test_only_one_display_font_at_a_time(server, tmp_path):
    from jong import config
    upload(server, a_font(tmp_path, "First.ttf"))
    status, second = upload(server, a_font(tmp_path, "Second.otf", kind="otf"))
    assert status == 200
    assert second["font"]["font_name"] == "Second.otf"

    fonts = [n for n in os.listdir(os.path.join(config.DATA, "appearance"))
             if not n.endswith(".name")]
    assert len(fonts) == 1, "the old font was left behind: %s" % fonts


def test_removing_it_leaves_nothing_behind(server, tmp_path):
    from jong import config
    upload(server, a_font(tmp_path, "Orena.ttf"))
    status, cleared = server.delete("/api/appearance/font")
    assert status == 200
    assert cleared["font"] == {"custom_font": False}

    here = os.path.join(config.DATA, "appearance")
    left = os.listdir(here) if os.path.isdir(here) else []
    assert left == [], "the font went but something stayed: %s" % left


def test_asking_for_a_font_that_was_never_uploaded(server):
    status, answer = server.get("/api/appearance/font")
    assert status == 404
    assert "no display font" in answer["error"]


def test_the_font_route_is_reachable_without_signing_in(server, tmp_path):
    """The login page uses the same display face as the app. If the font were behind the
    door, the one screen you see before opening it would be the only screen not wearing
    the library's own type."""
    from jong.http import OPEN_API
    assert "/api/appearance/font" in OPEN_API
