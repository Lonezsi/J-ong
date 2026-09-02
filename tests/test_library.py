"""The library through its own API, on a real socket.

These go through HTTP rather than calling the handlers, because the bugs worth catching
here were in the wiring: a route that does not exist, a header that is not read, a shape
one caller expects and another does not send.
"""
import os


def test_a_song_can_be_made_and_read_back(server):
    status, made = server.post("/api/songs", {"title": "Halfway Under"})
    assert status == 200, made
    song_id = made["song"]["id"]

    status, got = server.get("/api/songs/%d" % song_id)
    assert status == 200
    assert got["song"]["title"] == "Halfway Under"
    assert got["song"]["version_count"] == 0


def test_a_song_needs_a_title(server):
    status, answer = server.post("/api/songs", {"title": "   "})
    assert status == 400
    assert "title" in answer["error"]


def test_asking_for_a_song_that_is_not_there(server):
    status, answer = server.get("/api/songs/999")
    assert status == 404
    assert "999" in answer["error"]


def test_uploading_a_render_reads_its_length(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]

    status, result = server.upload("/api/songs/%d/versions" % song_id, wav(seconds=2.0))
    assert status == 200, result
    version = result["version"]
    assert version["n"] == 1
    assert result["duplicate"] is False
    assert abs(version["duration"] - 2.0) < 0.05, "the duration was not read from the file"
    assert version["bitrate"] > 0


def test_the_same_render_twice_is_not_a_new_version(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    path = wav()

    server.upload("/api/songs/%d/versions" % song_id, path)
    status, second = server.upload("/api/songs/%d/versions" % song_id, path,
                                   filename="renamed.wav")
    assert status == 200
    assert second["duplicate"] is True
    assert second["version"]["n"] == 1, "a duplicate was given a new number"

    _, listing = server.get("/api/songs/%d/versions" % song_id)
    assert len(listing["versions"]) == 1


def test_versions_count_up_and_the_newest_becomes_current(server, wav):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    server.upload("/api/songs/%d/versions" % song_id, wav("a.wav", level=0.4))
    _, second = server.upload("/api/songs/%d/versions" % song_id, wav("b.wav", level=0.6))

    assert second["version"]["n"] == 2
    _, listing = server.get("/api/songs/%d/versions" % song_id)
    assert [v["n"] for v in listing["versions"]] == [2, 1], "not newest first"
    assert listing["current_version_id"] == second["version"]["id"]


def test_a_file_that_is_not_audio_is_refused(server, tmp_path):
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    document = tmp_path / "notes.txt"
    document.write_text("lyrics, maybe")
    status, answer = server.upload("/api/songs/%d/versions" % made["song"]["id"], str(document))
    assert status == 400
    assert ".txt" in answer["error"]


def test_audio_comes_back_and_supports_ranges(server, wav):
    import urllib.request
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    _, result = server.upload("/api/songs/%d/versions" % made["song"]["id"], wav())
    url = "%s/api/versions/%d/audio" % (server.base, result["version"]["id"])

    request = urllib.request.Request(url, headers={"Range": "bytes=0-99"})
    with urllib.request.urlopen(request, timeout=10) as response:
        body = response.read()
        assert response.status == 206, "seeking would refetch the whole file"
        assert len(body) == 100
        assert response.headers["Content-Range"].startswith("bytes 0-99/")


def test_deleting_a_version_keeps_bytes_another_one_still_uses(server, wav):
    """Two songs can hold the same render. Removing one must not take the file out from
    under the other."""
    path = wav()
    _, one = server.post("/api/songs", {"title": "First"})
    _, two = server.post("/api/songs", {"title": "Second"})
    _, a = server.upload("/api/songs/%d/versions" % one["song"]["id"], path)
    _, b = server.upload("/api/songs/%d/versions" % two["song"]["id"], path)
    assert a["version"]["digest"] == b["version"]["digest"]

    server.delete("/api/versions/%d" % a["version"]["id"])
    status, still = server.get("/api/versions/%d/audio" % b["version"]["id"])
    assert status == 200, "deleting one song's version deleted the other song's audio"


# ── what the desktop client depends on ───────────────────────────────────────
def test_the_server_says_which_files_it_already_holds(server, wav):
    """The client asks this before sending anything. It is what stops a folder of two
    hundred unchanged renders being uploaded on every scan."""
    from jong import blobs
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    path = wav()
    server.upload("/api/songs/%d/versions" % made["song"]["id"], path)

    held = blobs.hash_file(path)
    missing = "0" * 64
    status, answer = server.get("/api/versions/have?digest=%s,%s" % (held, missing))
    assert status == 200
    assert answer["have"][held]["title"] == "Halfway Under"
    assert answer["have"][missing] is None


def test_both_suggestion_endpoints_name_the_song_the_same_way(server, wav):
    """/api/songs/match and /api/sync/scan answer the same question, and both are read by
    the same client. One used to say id and the other song_id, which raised KeyError the
    first time a real render was pushed."""
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    status, answer = server.get("/api/songs/match?name=Halfway%20Under%20v18.wav")
    assert status == 200
    assert answer["suggest"] is not None, "an obvious match was not suggested"
    assert answer["suggest"]["song_id"] == made["song"]["id"]
    assert set(answer["suggest"]) == {"song_id", "title", "score"}


def test_a_filename_with_no_match_suggests_nothing(server):
    server.post("/api/songs", {"title": "Halfway Under"})
    _, answer = server.get("/api/songs/match?name=completely%20different%20thing.mp3")
    assert answer["suggest"] is None


# ── state ────────────────────────────────────────────────────────────────────
def test_state_says_what_is_switched_on(server):
    status, state = server.get("/api/state")
    assert status == 200
    assert "songs" in state["modules"]
    assert state["failed"] == {}
    assert "storage" in state


def test_an_unknown_endpoint_says_so(server):
    status, answer = server.get("/api/not-a-thing")
    assert status == 404
    assert "path" in answer
