"""Routing and the module registry.

The registry is what makes a feature removable, so the test that matters most is that
switching a module off actually removes it rather than leaving a dead button.
"""
import pytest

from jong import registry
from jong.http import resolve, _match


@pytest.mark.parametrize("pattern,path,expected", [
    ("/api/songs", "/api/songs", {}),
    ("/api/songs", "/api/songs/4", None),
    ("/api/songs/<id>", "/api/songs/4", {"id": "4"}),
    ("/api/songs/<id>", "/api/songs", None),
    ("/api/songs/<id>/versions", "/api/songs/12/versions", {"id": "12"}),
    ("/api/albums/<id>/songs/<song_id>", "/api/albums/2/songs/9", {"id": "2", "song_id": "9"}),
    ("/api/songs/<id>", "/api/songs/hello%20there", {"id": "hello there"}),
])
def test_patterns_capture_what_they_should(pattern, path, expected):
    assert _match(pattern, path) == expected


def test_an_exact_route_beats_a_pattern():
    """/api/songs/match and /api/songs/<id> both match the same path. The literal one has
    to win, or searching for a match would look up a song with the id "match"."""
    handler, params = resolve("GET", "/api/songs/match")
    assert handler.__name__ == "match"
    assert params == {}

    handler, params = resolve("GET", "/api/songs/7")
    assert handler.__name__ == "get_song"
    assert params == {"id": "7"}


def test_the_method_is_part_of_the_route():
    get_handler, _ = resolve("GET", "/api/songs")
    post_handler, _ = resolve("POST", "/api/songs")
    assert get_handler.__name__ == "list_songs"
    assert post_handler.__name__ == "create_song"
    assert resolve("DELETE", "/api/songs")[0] is None


def test_an_unknown_path_resolves_to_nothing():
    assert resolve("GET", "/api/nope")[0] is None


# ── the registry ─────────────────────────────────────────────────────────────
def test_every_configured_module_loads():
    from jong import config
    registry.load()
    assert not registry.failures(), registry.failures()
    assert set(registry.enabled()) == set(config.MODULES)


def test_switching_a_module_off_removes_its_routes():
    """The point of the module list. With sound gone, nothing answers on its endpoints
    and the web UI stops drawing the panel because /api/state no longer names it."""
    registry.load(["core", "songs", "versions"])
    try:
        assert registry.has("songs")
        assert not registry.has("sound")
        assert resolve("GET", "/api/songs/1/sound")[0] is None
        assert resolve("GET", "/api/songs/1/versions")[0] is not None
        assert "sound" not in registry.enabled()
    finally:
        registry.load()


def test_a_broken_module_is_reported_rather_than_fatal():
    """A module that cannot import must not take the library down with it. It gets named
    in failures() and the server starts without it."""
    registry.load(["core", "songs", "does_not_exist"])
    try:
        assert "does_not_exist" in registry.failures()
        assert registry.has("songs"), "one bad module took the good ones down"
        assert resolve("GET", "/api/songs")[0] is not None
    finally:
        registry.load()


def test_songs_survives_versions_being_switched_off():
    """The library view asks the registry rather than importing, so a song row is just
    thinner when versions are gone instead of raising."""
    from jong.modules import songs
    from jong import db
    import time

    registry.load(["core", "songs"])
    try:
        now = time.time()
        db.insert("songs", {"title": "Halfway Under", "notes": "",
                            "created_at": now, "updated_at": now})
        rows = songs.decorate(db.query("SELECT * FROM songs"))
        assert rows[0]["version_count"] == 0
        assert rows[0]["artwork_id"] is None
    finally:
        registry.load()
