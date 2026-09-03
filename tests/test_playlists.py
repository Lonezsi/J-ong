"""Running orders that hold songs and loose renders together.

The interesting part is that the two things in a playlist are not the same kind of thing.
A song has versions and a current one; a render in the Renders list has no song yet and
may never get one. Anything that could only hold songs would miss the thing people
actually do, which is line up a finished track, a rough bounce and an idea from last week
and listen straight through.

So these are mostly about the seams: what happens to a running order when the song in it
is deleted, when the render in it is thrown away, and when an album it belongs to changes
underneath it.
"""


def a_song(server, title="Halfway Under"):
    _, made = server.post("/api/songs", {"title": title})
    return made["song"]["id"]


def a_render(server, wav, name="spare.wav"):
    _, arrived = server.upload("/api/renders", wav(seconds=1.0), filename=name)
    return arrived["render"]["id"]


def a_playlist(server, title="Friday"):
    _, made = server.post("/api/playlists", {"title": title})
    return made["playlist"]["id"]


def test_a_playlist_holds_songs_and_renders_side_by_side(server, wav):
    song = a_song(server)
    render = a_render(server, wav)
    playlist = a_playlist(server)

    status, first = server.post("/api/playlists/%d/items" % playlist, {"song_id": song})
    assert status == 200, first
    status, second = server.post("/api/playlists/%d/items" % playlist, {"render_id": render})
    assert status == 200, second

    _, got = server.get("/api/playlists/%d" % playlist)
    items = got["playlist"]["items"]
    assert [i["kind"] for i in items] == ["song", "render"]
    assert items[0]["song"]["title"] == "Halfway Under"
    assert items[1]["title"] == "spare"
    assert got["playlist"]["count"] == 2


def test_an_item_is_one_thing_or_the_other(server, wav):
    playlist = a_playlist(server)
    song = a_song(server)
    render = a_render(server, wav)

    status, answer = server.post("/api/playlists/%d/items" % playlist,
                                 {"song_id": song, "render_id": render})
    assert status == 400
    assert "not both" in answer["error"]

    status, answer = server.post("/api/playlists/%d/items" % playlist, {})
    assert status == 400


def test_the_same_thing_can_appear_twice_but_not_twice_running(server):
    """A chorus twice over is deliberate. The same track twice in a row is a slip, and
    almost always a double press."""
    playlist = a_playlist(server)
    first, second = a_song(server, "One"), a_song(server, "Two")

    server.post("/api/playlists/%d/items" % playlist, {"song_id": first})
    _, again = server.post("/api/playlists/%d/items" % playlist, {"song_id": first})
    assert again["added"] is False

    server.post("/api/playlists/%d/items" % playlist, {"song_id": second})
    _, back = server.post("/api/playlists/%d/items" % playlist, {"song_id": first})
    assert back["added"] is True, "the same song later in the order is not a mistake"

    _, got = server.get("/api/playlists/%d" % playlist)
    assert [i["title"] for i in got["playlist"]["items"]] == ["One", "Two", "One"]


def test_deleting_a_song_takes_it_out_of_every_running_order(server):
    """Rather than leaving a hole that is only discovered when it will not play."""
    playlist = a_playlist(server)
    keep, going = a_song(server, "Keep"), a_song(server, "Going")
    server.post("/api/playlists/%d/items" % playlist, {"song_id": keep})
    server.post("/api/playlists/%d/items" % playlist, {"song_id": going})

    server.delete("/api/songs/%d" % going)

    _, got = server.get("/api/playlists/%d" % playlist)
    assert [i["title"] for i in got["playlist"]["items"]] == ["Keep"]


def test_throwing_a_render_away_takes_it_out_too(server, wav):
    playlist = a_playlist(server)
    render = a_render(server, wav)
    server.post("/api/playlists/%d/items" % playlist, {"render_id": render})
    server.delete("/api/renders/%d" % render)

    _, got = server.get("/api/playlists/%d" % playlist)
    assert got["playlist"]["items"] == []


def test_the_order_can_be_rewritten_whole(server):
    playlist = a_playlist(server)
    ids = [a_song(server, "One"), a_song(server, "Two"), a_song(server, "Three")]
    for song in ids:
        server.post("/api/playlists/%d/items" % playlist, {"song_id": song})

    _, got = server.get("/api/playlists/%d" % playlist)
    items = got["playlist"]["items"]
    backwards = [i["item_id"] for i in reversed(items)]

    status, reordered = server.put("/api/playlists/%d/order" % playlist, {"items": backwards})
    assert status == 200
    assert [i["title"] for i in reordered["playlist"]["items"]] == ["Three", "Two", "One"]


def test_one_item_can_be_taken_out(server):
    playlist = a_playlist(server)
    for title in ("One", "Two"):
        server.post("/api/playlists/%d/items" % playlist, {"song_id": a_song(server, title)})
    _, got = server.get("/api/playlists/%d" % playlist)
    first = got["playlist"]["items"][0]["item_id"]

    status, left = server.delete("/api/playlists/%d/items/%d" % (playlist, first))
    assert status == 200
    assert [i["title"] for i in left["playlist"]["items"]] == ["Two"]


# ── albums ───────────────────────────────────────────────────────────────────

def test_an_album_gets_a_playlist_when_it_is_made(server):
    status, made = server.post("/api/albums", {"title": "Nights"})
    assert status == 200

    _, listing = server.get("/api/playlists")
    mine = [p for p in listing["playlists"] if p["album_id"] == made["album"]["id"]]
    assert len(mine) == 1, "an album should come with a running order"
    assert mine[0]["title"] == "Nights"


def test_an_albums_playlist_follows_its_songs(server):
    _, made = server.post("/api/albums", {"title": "Nights"})
    album = made["album"]["id"]
    first, second = a_song(server, "One"), a_song(server, "Two")

    server.post("/api/albums/%d/songs" % album, {"song_id": first})
    server.post("/api/albums/%d/songs" % album, {"song_id": second})

    _, listing = server.get("/api/playlists")
    playlist = [p for p in listing["playlists"] if p["album_id"] == album][0]
    _, got = server.get("/api/playlists/%d" % playlist["id"])
    assert [i["title"] for i in got["playlist"]["items"]] == ["One", "Two"]

    server.delete("/api/albums/%d/songs/%d" % (album, first))
    _, after = server.get("/api/playlists/%d" % playlist["id"])
    assert [i["title"] for i in after["playlist"]["items"]] == ["Two"]


def test_an_albums_playlist_cannot_be_deleted_on_its_own(server):
    """It is the album, in another shape. Deleting one without the other would leave the
    album with no running order and no way to get one back."""
    _, made = server.post("/api/albums", {"title": "Nights"})
    _, listing = server.get("/api/playlists")
    playlist = [p for p in listing["playlists"] if p["album_id"] == made["album"]["id"]][0]

    status, answer = server.delete("/api/playlists/%d" % playlist["id"])
    assert status == 400
    assert "album" in answer["error"]


def test_deleting_an_album_takes_its_playlist(server):
    _, made = server.post("/api/albums", {"title": "Nights"})
    album = made["album"]["id"]
    server.delete("/api/albums/%d" % album)

    _, listing = server.get("/api/playlists")
    assert not [p for p in listing["playlists"] if p["album_id"] == album]


def test_a_playlist_of_your_own_can_be_renamed_and_deleted(server):
    playlist = a_playlist(server, "Friday")
    status, renamed = server.patch("/api/playlists/%d" % playlist, {"title": "Saturday"})
    assert status == 200
    assert renamed["playlist"]["title"] == "Saturday"

    status, _ = server.delete("/api/playlists/%d" % playlist)
    assert status == 200
    _, listing = server.get("/api/playlists")
    assert not [p for p in listing["playlists"] if p["id"] == playlist]


def test_the_state_counts_them(server):
    a_playlist(server, "Friday")
    server.post("/api/albums", {"title": "Nights"})
    _, state = server.get("/api/state")
    assert state["summary"]["playlists"]["count"] == 2
    assert state["summary"]["playlists"]["yours"] == 1, "an album's own should not count"


def test_albums_that_predate_playlists_get_one_without_being_opened(server):
    """The backfill has to happen where a playlist would first be noticed missing, not
    only when the album is opened: a rail that lists playlists would otherwise show
    nothing for an album nobody had visited yet."""
    from jong import db
    _, made = server.post("/api/albums", {"title": "Older"})
    album = made["album"]["id"]
    # Take its playlist away, standing in for an album made before this module existed.
    db.run("DELETE FROM playlists WHERE album_id = ?", (album,))
    assert not db.one("SELECT id FROM playlists WHERE album_id = ?", (album,))

    _, listing = server.get("/api/playlists")

    assert [p for p in listing["playlists"] if p["album_id"] == album], \
        "listing playlists did not give the album the one it should have"


def test_a_render_in_a_playlist_is_named_the_way_it_is_named_everywhere_else(server, wav):
    """Without this the player showed "vigioe.wav" for something the Renders list calls
    "vigioe", which reads as two different things."""
    playlist = a_playlist(server)
    render = a_render(server, wav, name="vigioe.wav")
    server.post("/api/playlists/%d/items" % playlist, {"render_id": render})

    _, got = server.get("/api/playlists/%d" % playlist)
    item = got["playlist"]["items"][0]
    assert item["title"] == "vigioe"
    assert item["render"]["name"] == "vigioe", "the player reads name, and would show the file"
