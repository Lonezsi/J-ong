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
