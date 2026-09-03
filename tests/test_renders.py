"""The renders list: audio that has arrived but has not been told what it is.

The point of this module is that the two facts arrive at different times. A render knows
the project it came out of the moment FL writes it; which song it is the next version of
is decided later, by a person, looking at the library. So the tests worth writing are
about that gap: what happens between arriving and being placed, and what happens to the
bytes when either end of it is undone.
"""
import os

from jong import blobs


def waiting(server):
    _, listing = server.get("/api/renders")
    return listing["renders"]


def test_a_render_arrives_and_waits(server, wav):
    status, result = server.upload("/api/renders", wav(seconds=2.0), filename="caramel.wav")
    assert status == 200, result
    render = result["render"]
    assert result["added"] is True
    assert render["waiting"] is True
    assert render["name"] == "caramel", "the project name did not survive the trip"
    assert abs(render["duration"] - 2.0) < 0.05, "the duration was not read from the file"
    assert render["song_id"] is None

    assert len(waiting(server)) == 1


def test_the_same_render_twice_is_one_entry(server, wav):
    path = wav()
    server.upload("/api/renders", path, filename="caramel.wav")
    status, second = server.upload("/api/renders", path, filename="caramel-again.wav")

    assert status == 200
    assert second["added"] is False
    assert second["render"]["name"] == "caramel", \
        "the second arrival renamed the entry the first one made"
    assert len(waiting(server)) == 1


def test_attaching_makes_a_version_and_copies_nothing(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    _, arrived = server.upload("/api/renders", wav(), filename="halfway.wav")
    render = arrived["render"]

    before = blobs.usage()["files"]
    status, result = server.post("/api/renders/%d/attach" % render["id"],
                                 {"song_id": song_id})
    assert status == 200, result
    assert result["version"]["n"] == 1
    assert result["already_there"] is False
    assert blobs.usage()["files"] == before, \
        "attaching duplicated the audio instead of pointing at it"

    # It leaves the waiting list, but stays readable with ?all=1.
    assert waiting(server) == []
    _, everything = server.get("/api/renders?all=1")
    assert everything["renders"][0]["song_title"] == "Halfway Under"
    assert everything["renders"][0]["waiting"] is False


def test_attaching_without_a_song_makes_one_named_after_the_render(server, wav):
    _, arrived = server.upload("/api/renders", wav(), filename="brand new thing.wav")
    status, result = server.post("/api/renders/%d/attach" % arrived["render"]["id"], {})

    assert status == 200, result
    assert result["song"]["title"] == "brand new thing"
    assert result["version"]["n"] == 1


def test_attaching_bytes_a_song_already_has_does_not_make_a_second_version(server, wav):
    path = wav()
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    server.upload("/api/songs/%d/versions" % song_id, path)

    _, arrived = server.upload("/api/renders", path, filename="halfway.wav")
    _, result = server.post("/api/renders/%d/attach" % arrived["render"]["id"],
                            {"song_id": song_id})
    assert result["already_there"] is True
    assert result["version"]["n"] == 1

    _, listing = server.get("/api/songs/%d/versions" % song_id)
    assert len(listing["versions"]) == 1, "the same bytes became two versions"


def test_putting_one_back_leaves_the_version_alone(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    _, arrived = server.upload("/api/renders", wav(), filename="halfway.wav")
    render_id = arrived["render"]["id"]
    server.post("/api/renders/%d/attach" % render_id, {"song_id": made["song"]["id"]})

    status, back = server.post("/api/renders/%d/unattach" % render_id)
    assert status == 200
    assert back["render"]["waiting"] is True
    assert len(waiting(server)) == 1

    _, listing = server.get("/api/songs/%d/versions" % made["song"]["id"])
    assert len(listing["versions"]) == 1, "putting it back took the version with it"


def test_throwing_a_waiting_render_away_takes_its_bytes(server, wav):
    _, arrived = server.upload("/api/renders", wav(), filename="mistake.wav")
    digest = None
    from jong import db
    digest = db.one("SELECT digest FROM renders WHERE id = ?",
                    (arrived["render"]["id"],))["digest"]
    assert blobs.exists(digest)

    status, _ = server.delete("/api/renders/%d" % arrived["render"]["id"])
    assert status == 200
    assert not blobs.exists(digest), "the audio was left behind with nothing pointing at it"


def test_throwing_a_used_render_away_keeps_the_audio_the_song_needs(server, wav):
    """The entry and the version are different things, and only one of them owns the bytes."""
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    _, arrived = server.upload("/api/renders", wav(), filename="halfway.wav")
    render_id = arrived["render"]["id"]
    _, result = server.post("/api/renders/%d/attach" % render_id,
                            {"song_id": made["song"]["id"]})
    version_id = result["version"]["id"]

    server.delete("/api/renders/%d" % render_id)

    status, audio = server.get("/api/versions/%d/audio" % version_id)
    assert status == 200, "deleting the render entry took the song's audio with it"
    assert len(audio) > 1000


def test_deleting_a_version_keeps_audio_a_waiting_render_still_lists(server, wav):
    """The mirror of the case above, and the one that is easy to get wrong: the version
    goes, the render entry is still in the list, and it has to still play."""
    path = wav()
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    _, uploaded = server.upload("/api/songs/%d/versions" % made["song"]["id"], path)
    _, arrived = server.upload("/api/renders", path, filename="halfway.wav")
    render_id = arrived["render"]["id"]

    server.delete("/api/versions/%d" % uploaded["version"]["id"])

    status, audio = server.get("/api/renders/%d/audio" % render_id)
    assert status == 200, "deleting the version pulled the bytes out from under the list"
    assert len(audio) > 1000


def test_taking_in_a_folder(server, wav, tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    for name, seconds in (("one.wav", 1.0), ("two.wav", 1.5), ("three.wav", 2.0)):
        os.replace(wav(name=name, seconds=seconds), str(folder / name))
    (folder / "notes.txt").write_text("not audio", encoding="utf-8")

    status, result = server.post("/api/renders/ingest", {"path": str(folder)})
    assert status == 200, result
    assert result["count"] == 3, "a text file was taken in, or a render was missed"
    assert result["looked_at"] == 3
    assert sorted(r["name"] for r in result["added"]) == ["one", "three", "two"]

    # The source path is kept, so a render can be traced back to where it came from.
    assert all(str(folder) in r["source_path"] for r in result["added"])


def test_taking_in_the_same_folder_again_adds_nothing(server, wav, tmp_path):
    folder = tmp_path / "exports"
    folder.mkdir()
    os.replace(wav(name="one.wav"), str(folder / "one.wav"))

    server.post("/api/renders/ingest", {"path": str(folder)})
    status, again = server.post("/api/renders/ingest", {"path": str(folder)})

    assert status == 200
    assert again["count"] == 0
    assert again["already_here"] == 1
    assert len(waiting(server)) == 1


def test_taking_in_somewhere_that_is_not_there_says_so(server):
    status, answer = server.post("/api/renders/ingest",
                                 {"path": os.path.join("no", "such", "folder")})
    assert status == 400
    assert "nothing at" in answer["error"]


def test_renaming_keeps_the_extension(server, wav):
    _, arrived = server.upload("/api/renders", wav(), filename="Project_17.wav")
    status, renamed = server.patch("/api/renders/%d" % arrived["render"]["id"],
                                   {"name": "Slow Exit"})
    assert status == 200
    assert renamed["render"]["name"] == "Slow Exit"
    assert renamed["render"]["filename"] == "Slow Exit.wav"


def test_a_render_can_be_played_before_anything_is_decided_about_it(server, wav):
    _, arrived = server.upload("/api/renders", wav(seconds=2.0), filename="caramel.wav")
    status, audio = server.get("/api/renders/%d/audio" % arrived["render"]["id"])
    assert status == 200
    assert audio[:4] == b"RIFF", "that is not the audio that was sent"


def test_clearing_used_ones_leaves_the_waiting_ones(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    _, used = server.upload("/api/renders", wav(seconds=1.0), filename="used.wav")
    _, kept = server.upload("/api/renders", wav(seconds=2.0), filename="kept.wav")
    server.post("/api/renders/%d/attach" % used["render"]["id"],
                {"song_id": made["song"]["id"]})

    status, result = server.post("/api/renders/clear")
    assert status == 200
    assert result["cleared"] == 1

    left = waiting(server)
    assert len(left) == 1 and left[0]["name"] == "kept"


def test_the_count_of_waiting_renders_is_on_the_state(server, wav):
    server.upload("/api/renders", wav(seconds=1.0), filename="one.wav")
    server.upload("/api/renders", wav(seconds=2.0), filename="two.wav")
    _, state = server.get("/api/state")
    assert state["summary"]["renders"]["waiting"] == 2
    assert state["summary"]["renders"]["count"] == 2


def test_something_that_is_not_audio_is_refused(server, tmp_path):
    fake = tmp_path / "notes.txt"
    fake.write_text("not audio at all", encoding="utf-8")
    status, answer = server.upload("/api/renders", str(fake))
    assert status == 400
    assert "audio" in answer["error"]
