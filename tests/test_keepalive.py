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
        try:
            response = c.getresponse()
            response.read()
            assert response.status == 400, "a text file was accepted as a render"
        except (ConnectionAbortedError, ConnectionResetError,
                http.client.RemoteDisconnected):
            # Closing is the point, and on Windows the close can reach the client before
            # the refusal does. What is promised is that the upload is refused and the
            # next connection is clean, not that a client still writing gets to read why.
            pass
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


def test_a_second_server_cannot_take_a_port_that_is_already_served():
    """Two copies serving one port is worse than one copy failing to start.

    On Windows SO_REUSEADDR lets a later process bind a port an earlier one is already
    listening on, and the two then divide the incoming connections between them. With a
    scheduled task retrying every minute that produced several servers at once, requests
    landing on whichever happened to catch them, and a library that appeared to crash
    constantly while every individual process was perfectly healthy.
    """
    import socket
    from jong.http import Server, Handler

    first = Server(("127.0.0.1", 0), Handler)
    port = first.server_address[1]
    try:
        try:
            second = Server(("127.0.0.1", port), Handler)
        except OSError:
            return                      # refused, which is the whole point
        second.server_close()
        raise AssertionError(
            "a second server bound port %d while the first was serving it" % port)
    finally:
        first.server_close()


def test_a_connection_that_goes_quiet_does_not_hold_its_thread_forever(tmp_path):
    """The thing that made the host look like it kept crashing.

    Every kept alive connection holds a thread parked in a read. A browser opens several
    per tab and hands none of them back while the tab is open, and one that dies without
    saying so, which is what a phone going to sleep or a tunnel dropping looks like,
    holds its thread for the life of the process. Nothing raises, nothing is logged, and
    eventually the library stops answering for no visible reason.

    Measured before the fix: forty idle connections took the server from eight threads to
    forty eight, and it stayed there until the clients closed.

    Run against a server of its own, with the wait turned down, so that proving a minute
    long timeout does not cost a minute.
    """
    import socket
    import threading
    from http.server import ThreadingHTTPServer

    from jong.http import Handler

    assert Handler.timeout, "an idle connection must eventually be closed"
    assert Handler.timeout <= 300, "an idle connection held for minutes is the same bug"

    class Impatient(Handler):
        timeout = 1

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Impatient)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=20)
        c.request("GET", "/api/health")
        assert c.getresponse().read()

        # Then say nothing. The server has to be the one to hang up.
        c.sock.settimeout(15)
        try:
            left = c.sock.recv(1)
        except socket.timeout:
            raise AssertionError("the server held a connection that had gone quiet")
        assert left == b"", "expected a close, got %r" % left
        c.close()
    finally:
        srv.shutdown()
        srv.server_close()


def test_the_backlog_is_deeper_than_the_handful_the_stdlib_allows():
    """Opening the library fires a page, a stylesheet, a script and a dozen calls at
    once, several on new connections. A backlog of five overflows, and what overflows is
    dropped rather than refused, so the caller waits until it gives up."""
    from jong.http import Server

    assert Server.request_queue_size >= 64,         "a backlog of %d is a handful of parallel requests" % Server.request_queue_size
