"""Content addressed storage, and reading a file's length.

Both of these had a bug that only showed up on a real file, so both are tested against
one rather than against a mock.
"""
import os

from jong import blobs, audio_meta


def test_the_same_bytes_are_stored_once():
    first, new_first = blobs.put_bytes(b"a render")
    second, new_second = blobs.put_bytes(b"a render")
    assert first == second
    assert new_first is True
    assert new_second is False, "the second copy was written again"


def test_different_bytes_get_different_homes():
    one, _ = blobs.put_bytes(b"take one")
    two, _ = blobs.put_bytes(b"take two")
    assert one != two
    assert os.path.isfile(blobs.path_for(one))
    assert os.path.isfile(blobs.path_for(two))


def test_a_stored_file_is_the_file_that_went_in(wav):
    path = wav()
    with open(path, "rb") as f:
        original = f.read()
    digest, size, was_new = blobs.put_path(path)
    assert was_new and size == len(original)
    with open(blobs.path_for(digest), "rb") as f:
        assert f.read() == original


def test_usage_counts_what_is_there(wav):
    assert blobs.usage()["files"] == 0
    blobs.put_path(wav("one.wav"))
    blobs.put_path(wav("two.wav", seconds=1.0))
    usage = blobs.usage()
    assert usage["files"] == 2
    assert usage["bytes"] > 0


def test_a_partial_upload_leaves_nothing_behind(wav):
    """put_stream writes to a temporary name first. A stream that ends early must not
    leave that temporary file counted as a blob."""
    class ShortStream:
        def read(self, n):
            return b""

    digest, size, was_new = blobs.put_stream(ShortStream(), 1000)
    assert size == 0
    leftovers = [n for _, _, files in os.walk(blobs.config.BLOBS) for n in files
                 if n.endswith(".part")]
    assert not leftovers, "a partial upload was left in the store"


# ── reading durations ────────────────────────────────────────────────────────
def test_a_wav_reports_its_real_length(wav):
    meta = audio_meta.probe(wav(seconds=2.0))
    assert abs(meta["duration"] - 2.0) < 0.01
    assert meta["kind"] == "wav"
    assert meta["bitrate"] > 0


def test_it_can_be_told_the_type_when_the_path_has_none(wav, tmp_path):
    """Stored files are named by their hash and have no extension.

    Reading the type off the path made every upload report a duration of zero, because
    the file in the store is called something like 3f9a2c... with nothing after it.
    """
    path = wav(seconds=1.5)
    nameless = str(tmp_path / "3f9a2c8e")
    os.replace(path, nameless)

    assert audio_meta.probe(nameless)["duration"] == 0.0, "guessed a type it cannot know"
    told = audio_meta.probe(nameless, ".wav")
    assert abs(told["duration"] - 1.5) < 0.01, "the explicit type was ignored"


def test_an_unreadable_file_is_not_an_error(tmp_path):
    """A file J-ong cannot parse still uploads. The browser fills the duration in later."""
    junk = tmp_path / "broken.mp3"
    junk.write_bytes(b"this is not an mp3 at all")
    meta = audio_meta.probe(str(junk))
    assert meta["duration"] == 0.0
    assert meta["kind"] == "mp3"


def test_a_missing_file_is_not_an_error():
    assert audio_meta.probe("no-such-file.wav")["duration"] == 0.0


def test_two_uploads_at_once_do_not_write_into_the_same_temporary_file(tmp_path):
    """The store is content addressed, so a wrong file under a right name is permanent.

    put_stream names its temporary file after the process id. The server is a
    ThreadingHTTPServer with daemon_threads on, so two uploads arriving together are two
    threads in this function with one filename between them: they interleave their bytes
    into one file while each hashes its own stream in memory. Both then rename that file
    to their own digest, and whichever lands second wins.

    Nothing raises. Both callers are told their upload succeeded. The bytes on disk are a
    mixture of two songs, and because exists() only stats the path, that file shadows
    every future correct upload of the same audio forever.
    """
    import hashlib
    import io
    import threading

    from jong import blobs

    class Slow(io.RawIOBase):
        """A body that arrives in pieces, the way one off a socket does."""

        def __init__(self, payload, gate):
            self.rest = payload
            self.gate = gate
            self.first = True

        def read(self, n=-1):
            chunk = self.rest[:8192]
            self.rest = self.rest[8192:]
            if self.first:
                self.first = False
                self.gate.wait(timeout=5)      # both threads are now inside the write
            return chunk

    one = b"AAAA" * 60000
    two = b"BBBB" * 60000
    gate = threading.Barrier(2)
    got = {}

    def send(name, payload):
        got[name] = blobs.put_stream(Slow(payload, gate), len(payload))

    threads = [threading.Thread(target=send, args=("one", one)),
               threading.Thread(target=send, args=("two", two))]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=20)

    assert len(got) == 2, "both uploads should have finished"
    for name, payload in (("one", one), ("two", two)):
        digest = got[name][0]
        assert digest == hashlib.sha256(payload).hexdigest(), "the digest is of the stream"
        stored = open(blobs.path_for(digest), "rb").read()
        assert stored == payload, (
            "%s was stored as %d bytes that hash to %s, not to its own name"
            % (name, len(stored), hashlib.sha256(stored).hexdigest()[:12]))
