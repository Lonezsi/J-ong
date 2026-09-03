"""One connection, many requests.

The server speaks HTTP/1.1, so a browser opens one connection and sends every request
down it. That makes the request body the whole connection's problem rather than one
handler's: bytes a handler never read are still sitting in the socket when the next
request arrives, and the server parses them as that request's opening line.

The symptom is horrible to chase. A perfectly good GET comes back 501, the failure lands
on a request that did nothing wrong, and which request actually caused it depends on
which connection the browser happened to reuse. It looked like "J-ong is not answering"
at random.

These go through http.client rather than urllib because urllib opens a fresh connection
per request and would never see it.
"""
import json
import http.client


def conn(server):
    host, port = server.base.replace("http://", "").split(":")
    return http.client.HTTPConnection(host, int(port), timeout=20)


def send(c, method, path, body=None):
    headers = {}
    if body is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(body)
    c.request(method, path, body=body, headers=headers)
    response = c.getresponse()
    raw = response.read()
    return response.status, raw


def test_a_post_whose_handler_ignores_the_body_does_not_break_the_next_request(server, wav):
    """The exact shape of the bug: every one of these routes is sent a JSON body by the
    browser and has no reason to read it."""
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    _, first = server.upload("/api/songs/%d/versions" % song_id, wav(seconds=1.0))
    _, second = server.upload("/api/songs/%d/versions" % song_id, wav(seconds=1.5),
                              filename="take2.wav")

    c = conn(server)
    try:
        # make_current reads nothing, and the browser sends "{}" with it
        status, _ = send(c, "POST", "/api/versions/%d/current" % first["version"]["id"], {})
        assert status == 200

        status, raw = send(c, "GET", "/api/songs")
        assert status == 200, (
            "the request after a body-ignoring POST got %d on the same connection; "
            "unread bytes were parsed as the next request line" % status)
        assert json.loads(raw)["songs"], "the body came back mangled"
    finally:
        c.close()


def test_every_verb_leaves_the_connection_usable(server, wav):
    """A run through the routes that answer without reading, in one conversation."""
    _, made = server.post("/api/songs", {"title": "Halfway Under"})
    song_id = made["song"]["id"]
    _, uploaded = server.upload("/api/songs/%d/versions" % song_id, wav())
    _, arrived = server.upload("/api/renders", wav(seconds=2.0), filename="spare.wav")
    _, album = server.post("/api/albums", {"title": "Nights"})

    calls = [
        ("POST", "/api/renders/%d/attach" % arrived["render"]["id"], {"song_id": song_id}),
        ("POST", "/api/renders/%d/unattach" % arrived["render"]["id"], {}),
        ("POST", "/api/versions/%d/current" % uploaded["version"]["id"], {}),
        ("DELETE", "/api/albums/%d" % album["album"]["id"], {}),
        ("DELETE", "/api/renders/%d" % arrived["render"]["id"], {}),
    ]

    c = conn(server)
    try:
        for method, path, body in calls:
            status, _ = send(c, method, path, body)
            assert status in (200, 204), "%s %s answered %d" % (method, path, status)
            # The check that matters: the very next request on this same connection.
            after, raw = send(c, "GET", "/api/state")
            assert after == 200, (
                "%s %s left %d unread bytes behind: the following GET got %d"
                % (method, path, len(json.dumps(body)), after))
            assert "modules" in json.loads(raw)
    finally:
        c.close()


def test_a_body_too_large_to_swallow_closes_the_connection_instead(server, tmp_path):
    """A refused upload should not be read to the end just to be polite. Closing is the
    honest answer, and the browser simply opens another connection."""
    from jong.http import Body

    junk = tmp_path / "notes.txt"
    junk.write_bytes(b"x" * (Body.DRAIN_LIMIT + 1024))

    c = conn(server)
    try:
        with open(junk, "rb") as f:
            c.request("POST", "/api/renders", body=f.read(),
                      headers={"Content-Type": "application/octet-stream",
                               "X-Filename": "notes.txt"})
        response = c.getresponse()
        response.read()
        assert response.status == 400, "a text file was accepted as a render"
    finally:
        c.close()

    # A fresh connection still works, which is all that is promised after a close.
    status, listing = server.get("/api/renders")
    assert status == 200
    assert listing["renders"] == []


def test_reading_the_body_twice_over_does_not_run_into_the_next_request(server):
    """A handler that reads its body normally must leave the connection exactly at the
    boundary, not a byte either side of it."""
    c = conn(server)
    try:
        for index in range(4):
            status, raw = send(c, "POST", "/api/songs", {"title": "Song %d" % index})
            assert status == 200, "request %d answered %d" % (index, status)
            assert json.loads(raw)["song"]["title"] == "Song %d" % index
    finally:
        c.close()

    _, listing = server.get("/api/songs")
    assert len(listing["songs"]) == 4
