"""Lyrics, sound settings and albums."""
import pytest

from jong.modules import sound


# ── lyrics ───────────────────────────────────────────────────────────────────
def _song(server, title="Halfway Under"):
    _, made = server.post("/api/songs", {"title": title})
    return made["song"]["id"]


def test_an_alternative_keeps_its_own_history(server):
    song_id = _song(server)
    _, made = server.post("/api/songs/%d/lyrics" % song_id,
                          {"name": "Current", "text": "first words"})
    sheet_id = made["sheet"]["id"]

    server.put("/api/lyrics/%d/text" % sheet_id, {"text": "second words"})
    server.put("/api/lyrics/%d/text" % sheet_id, {"text": "third words"})

    _, listing = server.get("/api/songs/%d/lyrics" % song_id)
    assert listing["lyrics"][0]["text"] == "third words"
    assert listing["lyrics"][0]["revisions"] == 3

    _, history = server.get("/api/lyrics/%d/history" % sheet_id)
    assert len(history["revisions"]) == 3


def test_saving_the_same_words_does_not_make_a_revision(server):
    """A history full of identical snapshots is worse than no history."""
    song_id = _song(server)
    _, made = server.post("/api/songs/%d/lyrics" % song_id, {"name": "Current", "text": "same"})
    sheet_id = made["sheet"]["id"]

    _, again = server.put("/api/lyrics/%d/text" % sheet_id, {"text": "same"})
    assert again["saved"] is False
    _, history = server.get("/api/lyrics/%d/history" % sheet_id)
    assert len(history["revisions"]) == 1


def test_restoring_an_old_text_keeps_the_newer_one_in_history(server):
    song_id = _song(server)
    _, made = server.post("/api/songs/%d/lyrics" % song_id, {"name": "Current", "text": "one"})
    sheet_id = made["sheet"]["id"]
    server.put("/api/lyrics/%d/text" % sheet_id, {"text": "two"})

    _, history = server.get("/api/lyrics/%d/history" % sheet_id)
    oldest = history["revisions"][-1]["id"]

    _, restored = server.post("/api/lyrics/%d/restore" % sheet_id, {"revision_id": oldest})
    assert restored["saved"] is True
    assert restored["sheet"]["text"] == "one"
    _, after = server.get("/api/lyrics/%d/history" % sheet_id)
    assert len(after["revisions"]) == 3, "restoring threw away the text it replaced"


def test_the_first_alternative_is_the_current_one(server):
    song_id = _song(server)
    _, first = server.post("/api/songs/%d/lyrics" % song_id, {"name": "Current"})
    _, second = server.post("/api/songs/%d/lyrics" % song_id, {"name": "Other"})
    assert first["sheet"]["is_current"] == 1
    assert second["sheet"]["is_current"] == 0

    server.post("/api/lyrics/%d/current" % second["sheet"]["id"])
    _, listing = server.get("/api/songs/%d/lyrics" % song_id)
    current = [s for s in listing["lyrics"] if s["is_current"]]
    assert len(current) == 1 and current[0]["name"] == "Other"


def test_a_revision_from_another_alternative_cannot_be_restored(server):
    song_id = _song(server)
    _, a = server.post("/api/songs/%d/lyrics" % song_id, {"name": "A", "text": "alpha"})
    _, b = server.post("/api/songs/%d/lyrics" % song_id, {"name": "B", "text": "beta"})
    _, history = server.get("/api/lyrics/%d/history" % b["sheet"]["id"])
    status, answer = server.post("/api/lyrics/%d/restore" % a["sheet"]["id"],
                                 {"revision_id": history["revisions"][0]["id"]})
    assert status == 404


# ── sound ────────────────────────────────────────────────────────────────────
def test_a_song_gets_a_current_preset_the_first_time_it_is_asked(server):
    song_id = _song(server)
    _, listing = server.get("/api/songs/%d/sound" % song_id)
    assert len(listing["presets"]) == 1
    assert listing["presets"][0]["name"] == "Current"
    assert listing["presets"][0]["is_current"] == 1


def test_a_song_always_keeps_one_preset(server):
    song_id = _song(server)
    _, listing = server.get("/api/songs/%d/sound" % song_id)
    only = listing["presets"][0]["id"]
    status, answer = server.delete("/api/sound/%d" % only)
    assert status == 400
    assert "at least one" in answer["error"]


def test_a_new_preset_can_copy_the_one_you_are_on(server):
    song_id = _song(server)
    _, listing = server.get("/api/songs/%d/sound" % song_id)
    base = listing["presets"][0]
    server.put("/api/sound/%d" % base["id"], {"data": {
        "bands": [{"id": "b1", "type": "peaking", "freq": 1000, "gain": 6, "q": 1.2, "on": True}]}})

    _, made = server.post("/api/songs/%d/sound" % song_id, {"name": "Car", "copy_from": base["id"]})
    assert len(made["preset"]["data"]["bands"]) == 1
    assert made["preset"]["data"]["bands"][0]["freq"] == 1000


@pytest.mark.parametrize("given,field,expected", [
    ({"bands": [{"freq": 999999, "type": "peaking"}]}, "freq", 22000.0),
    ({"bands": [{"freq": -5, "type": "peaking"}]}, "freq", 10.0),
    ({"bands": [{"freq": 1000, "gain": 500, "type": "peaking"}]}, "gain", 30.0),
    ({"bands": [{"freq": 1000, "q": 0, "type": "peaking"}]}, "q", 0.05),
    ({"bands": [{"freq": 1000, "q": "nonsense", "type": "peaking"}]}, "q", 1.0),
    ({"bands": [{"freq": None, "type": "peaking"}]}, "freq", 1000.0),
])
def test_impossible_numbers_are_clamped(given, field, expected):
    """Web Audio does not raise on a frequency of zero or a Q of NaN. It produces a
    filter that outputs silence, which is the worst way to find out."""
    assert sound.normalise(given)["bands"][0][field] == expected


def test_an_unknown_filter_type_becomes_a_bell():
    assert sound.normalise({"bands": [{"type": "wobble", "freq": 500}]})["bands"][0]["type"] == "peaking"


def test_the_band_list_has_a_ceiling():
    many = {"bands": [{"type": "peaking", "freq": 100 + i} for i in range(80)]}
    assert len(sound.normalise(many)["bands"]) == 24


def test_rubbish_normalises_to_something_playable():
    for junk in (None, [], "hello", {"bands": "not a list"}, {"limiter": 7}):
        out = sound.normalise(junk)
        assert out["bands"] == []
        assert out["limiter"]["on"] is False
        assert -24.0 <= out["gain"] <= 24.0


# ── albums ───────────────────────────────────────────────────────────────────
def test_a_song_can_sit_on_more_than_one_album(server):
    song_id = _song(server)
    _, first = server.post("/api/albums", {"title": "Nightshift", "year": 2026})
    _, second = server.post("/api/albums", {"title": "Odds and ends"})
    server.post("/api/albums/%d/songs" % first["album"]["id"], {"song_id": song_id})
    server.post("/api/albums/%d/songs" % second["album"]["id"], {"song_id": song_id})

    _, mine = server.get("/api/songs/%d/albums" % song_id)
    assert sorted(a["title"] for a in mine["albums"]) == ["Nightshift", "Odds and ends"]


def test_adding_the_same_song_twice_changes_nothing(server):
    song_id = _song(server)
    _, album = server.post("/api/albums", {"title": "Nightshift"})
    server.post("/api/albums/%d/songs" % album["album"]["id"], {"song_id": song_id})
    _, again = server.post("/api/albums/%d/songs" % album["album"]["id"], {"song_id": song_id})
    assert again["added"] is False
    _, got = server.get("/api/albums/%d" % album["album"]["id"])
    assert len(got["songs"]) == 1


def test_album_order_is_the_albums_own(server):
    """The same song can be third on one record and first on another, so the position
    belongs to the membership rather than to the song."""
    a = _song(server, "One")
    b = _song(server, "Two")
    _, album = server.post("/api/albums", {"title": "Nightshift"})
    album_id = album["album"]["id"]
    server.post("/api/albums/%d/songs" % album_id, {"song_id": a})
    server.post("/api/albums/%d/songs" % album_id, {"song_id": b})

    _, reordered = server.post("/api/albums/%d/order" % album_id, {"order": [b, a]})
    assert [s["id"] for s in reordered["songs"]] == [b, a]


def test_reordering_refuses_songs_that_are_not_on_the_album(server):
    a = _song(server, "One")
    stranger = _song(server, "Elsewhere")
    _, album = server.post("/api/albums", {"title": "Nightshift"})
    album_id = album["album"]["id"]
    server.post("/api/albums/%d/songs" % album_id, {"song_id": a})
    status, answer = server.post("/api/albums/%d/order" % album_id, {"order": [stranger]})
    assert status == 400
    assert "not on this album" in answer["error"]


def test_deleting_a_song_takes_its_lyrics_and_versions_with_it(server, wav):
    song_id = _song(server)
    server.upload("/api/songs/%d/versions" % song_id, wav())
    server.post("/api/songs/%d/lyrics" % song_id, {"name": "Current", "text": "words"})

    server.delete("/api/songs/%d" % song_id)
    assert server.get("/api/songs/%d" % song_id)[0] == 404
    assert server.get("/api/songs/%d/versions" % song_id)[0] == 404
