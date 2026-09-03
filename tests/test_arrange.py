"""The compositor's stored side.

The interesting part of an arrangement is not that it round trips, it is that it cannot
be written into a state the player would then choke on. A clip pointing at a section that
was deleted, a tempo of zero, a length of nothing: each of those plays as silence or a
divide by zero somewhere far from here, so they are refused at the door.

Everything is counted in beats rather than seconds on purpose. Correcting a tempo that
was guessed wrong is the common case, and seconds would mean every edge moving.
"""


def a_song(server, title="Halfway Under"):
    _, made = server.post("/api/songs", {"title": title})
    return made["song"]["id"]


SHAPE = {
    "bpm": 128,
    "offset": 0.25,
    "per_bar": 4,
    "parts": [
        {"id": "p1", "name": "Intro", "from": 0, "beats": 32, "hue": 140},
        {"id": "p2", "name": "Chorus", "from": 32, "beats": 32, "hue": 200},
    ],
    "clips": [
        {"id": "c1", "part": "p1", "from": 0, "beats": 16},
        {"id": "c2", "part": "p2", "from": 32, "beats": 32},
    ],
}


def test_a_song_starts_with_no_arrangement(server):
    song_id = a_song(server)
    status, data = server.get("/api/songs/%d/arrangement" % song_id)
    assert status == 200
    assert data["arrangement"]["clips"] == []
    assert data["arrangement"]["enabled"] == 0


def test_an_arrangement_is_written_and_read_back_whole(server):
    song_id = a_song(server)
    status, saved = server.put("/api/songs/%d/arrangement" % song_id, SHAPE)
    assert status == 200, saved

    _, data = server.get("/api/songs/%d/arrangement" % song_id)
    got = data["arrangement"]
    assert got["bpm"] == 128
    assert got["offset"] == 0.25
    assert [p["name"] for p in got["parts"]] == ["Intro", "Chorus"]
    assert [c["beats"] for c in got["clips"]] == [16, 32]
    assert got["clips"][0]["part"] == "p1"


def test_the_same_section_can_be_used_twice(server):
    """Which is the whole point: a chorus that goes round twice is one part, two clips."""
    song_id = a_song(server)
    shape = dict(SHAPE)
    shape["clips"] = [
        {"id": "c1", "part": "p2", "from": 32, "beats": 32},
        {"id": "c2", "part": "p2", "from": 32, "beats": 16},
    ]
    status, _ = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert status == 200
    _, data = server.get("/api/songs/%d/arrangement" % song_id)
    clips = data["arrangement"]["clips"]
    assert len(clips) == 2
    assert clips[0]["part"] == clips[1]["part"] == "p2"
    assert clips[1]["beats"] == 16, "the second time round could not be shortened"


def test_a_clip_pointing_at_a_section_that_is_gone_loses_the_link(server):
    """Rather than being stored and later drawn with no name and no colour, which reads
    as a broken panel instead of a deleted section."""
    song_id = a_song(server)
    shape = dict(SHAPE)
    shape["clips"] = [{"id": "c1", "part": "ghost", "from": 0, "beats": 8}]
    status, saved = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert status == 200
    assert saved["arrangement"]["clips"][0]["part"] is None


def test_a_tempo_that_could_not_be_played_is_refused(server):
    song_id = a_song(server)
    for bpm in (0, -4, 5000):
        shape = dict(SHAPE, bpm=bpm)
        status, answer = server.put("/api/songs/%d/arrangement" % song_id, shape)
        assert status == 400, "bpm %s was accepted" % bpm
        assert "bpm" in answer["error"]


def test_a_clip_of_no_length_is_refused(server):
    song_id = a_song(server)
    shape = dict(SHAPE)
    shape["clips"] = [{"id": "c1", "part": "p1", "from": 0, "beats": 0}]
    status, answer = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert status == 400
    assert "length" in answer["error"]


def test_switching_it_on_does_not_touch_the_shape(server):
    song_id = a_song(server)
    server.put("/api/songs/%d/arrangement" % song_id, SHAPE)

    status, result = server.post("/api/songs/%d/arrangement/enabled" % song_id, {"on": True})
    assert status == 200
    assert result["arrangement"]["enabled"] == 1
    assert [c["beats"] for c in result["arrangement"]["clips"]] == [16, 32], \
        "turning it on rewrote the arrangement"

    _, off = server.post("/api/songs/%d/arrangement/enabled" % song_id, {"on": False})
    assert off["arrangement"]["enabled"] == 0
    assert len(off["arrangement"]["clips"]) == 2, "turning it off lost the work"


def test_switching_on_a_song_with_no_arrangement_says_so(server):
    song_id = a_song(server)
    status, answer = server.post("/api/songs/%d/arrangement/enabled" % song_id, {"on": True})
    assert status == 404
    assert "no arrangement" in answer["error"]


def test_words_can_be_pointed_at_a_section(server):
    song_id = a_song(server)
    shape = dict(SHAPE, lyrics={"p2": 7})
    status, saved = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert status == 200
    assert saved["arrangement"]["lyrics"] == {"p2": 7}


def test_a_link_to_a_section_that_does_not_exist_is_dropped(server):
    song_id = a_song(server)
    shape = dict(SHAPE, lyrics={"p1": 3, "ghost": 9})
    _, saved = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert saved["arrangement"]["lyrics"] == {"p1": 3}


def test_the_arrangement_goes_when_the_song_does(server):
    song_id = a_song(server)
    server.put("/api/songs/%d/arrangement" % song_id, SHAPE)
    server.delete("/api/songs/%d" % song_id)

    from jong import db
    left = db.one("SELECT COUNT(*) AS n FROM arrangements WHERE song_id = ?", (song_id,))
    assert left["n"] == 0, "an arrangement outlived its song"


def test_an_arrangement_survives_a_new_render(server, wav):
    """A new bounce of the same song must not throw away the shape you worked out. That
    is the reason this is kept per song rather than per version."""
    song_id = a_song(server)
    server.put("/api/songs/%d/arrangement" % song_id, SHAPE)
    server.upload("/api/songs/%d/versions" % song_id, wav())

    _, data = server.get("/api/songs/%d/arrangement" % song_id)
    assert len(data["arrangement"]["clips"]) == 2


def test_a_runaway_number_of_clips_is_refused(server):
    song_id = a_song(server)
    shape = dict(SHAPE)
    shape["clips"] = [{"id": "c%d" % i, "part": "p1", "from": 0, "beats": 4}
                      for i in range(600)]
    status, answer = server.put("/api/songs/%d/arrangement" % song_id, shape)
    assert status == 400
    assert "more than" in answer["error"]


def test_the_state_says_how_many_songs_are_arranged(server):
    first = a_song(server, "One")
    second = a_song(server, "Two")
    server.put("/api/songs/%d/arrangement" % first, dict(SHAPE, enabled=True))
    server.put("/api/songs/%d/arrangement" % second, SHAPE)

    _, state = server.get("/api/state")
    assert state["summary"]["arrange"]["count"] == 2
    assert state["summary"]["arrange"]["on"] == 1
