"""How long is this file, and at what bitrate.

Enough MP3 and WAV parsing to fill in a duration without a third party library. Anything
it cannot read comes back as a duration of 0, which the web player quietly corrects the
first time the file is played, because the browser has already decoded it by then.
"""
import os
import struct
import wave

# MPEG 1 Layer III, the only combination a rendered song realistically arrives in, plus
# MPEG 2 for the low sample rate case.
_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
_RATES = {
    3: [44100, 48000, 32000, 0],   # MPEG 1
    2: [22050, 24000, 16000, 0],   # MPEG 2
    0: [11025, 12000, 8000, 0],    # MPEG 2.5
}


def probe(path, ext=None):
    """Return {duration, bitrate, kind}. Never raises: an unreadable file is not an error
    worth failing an upload over.

    The extension is a separate argument because stored files are named by their hash and
    have none. Reading the type off the path works for a file still sitting in a watched
    folder and silently reads nothing for one already in the store.
    """
    ext = (ext or os.path.splitext(path)[1]).lower()
    try:
        if ext == ".wav":
            return _wav(path)
        if ext == ".mp3":
            return _mp3(path)
    except Exception:
        pass
    return {"duration": 0.0, "bitrate": 0, "kind": ext.lstrip(".") or "audio"}


def _wav(path):
    with wave.open(path, "rb") as w:
        frames, rate = w.getnframes(), w.getframerate()
        duration = frames / float(rate) if rate else 0.0
        bitrate = int(rate * w.getnchannels() * w.getsampwidth() * 8 / 1000)
    return {"duration": round(duration, 3), "bitrate": bitrate, "kind": "wav"}


def _skip_id3(f):
    """ID3v2 sits in front of the first frame and its size is a syncsafe integer, meaning
    seven bits per byte. Reading it as a normal integer is the classic way to land in the
    middle of the tag and find no frames at all."""
    head = f.read(10)
    if len(head) < 10 or head[:3] != b"ID3":
        f.seek(0)
        return 0
    size = 0
    for byte in head[6:10]:
        size = (size << 7) | (byte & 0x7F)
    f.seek(10 + size)
    return 10 + size


def _parse_header(word):
    if (word & 0xFFE00000) != 0xFFE00000:
        return None
    version = (word >> 19) & 0x3        # 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    layer = (word >> 17) & 0x3          # 1 = Layer III
    bitrate_ix = (word >> 12) & 0xF
    rate_ix = (word >> 10) & 0x3
    padding = (word >> 9) & 0x1
    if layer != 1 or version == 1 or bitrate_ix in (0, 15) or rate_ix == 3:
        return None
    table = _BITRATES_V1_L3 if version == 3 else _BITRATES_V2_L3
    bitrate = table[bitrate_ix]
    rate = _RATES[version][rate_ix]
    if not bitrate or not rate:
        return None
    samples = 1152 if version == 3 else 576
    length = int((samples // 8) * 1000 * bitrate / rate) + padding
    return {"bitrate": bitrate, "rate": rate, "samples": samples,
            "length": length, "version": version}


def _mp3(path):
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        start = _skip_id3(f)
        first = None
        # Scan for the first real frame. Junk between the tag and the audio is common.
        window = f.read(65536)
        for i in range(len(window) - 4):
            word = struct.unpack(">I", window[i:i + 4])[0]
            first = _parse_header(word)
            if first:
                start += i
                break
        if not first:
            return {"duration": 0.0, "bitrate": 0, "kind": "mp3"}

        # A Xing or VBRI header gives the exact frame count for a variable bitrate file,
        # which is the only way to get its length right without decoding the whole thing.
        f.seek(start)
        head = f.read(first["length"] + 4 if first["length"] > 4 else 1024)
        frames = _xing_frames(head)
        if frames:
            duration = frames * first["samples"] / float(first["rate"])
            audio_bytes = size - start
            bitrate = int(audio_bytes * 8 / duration / 1000) if duration else first["bitrate"]
            return {"duration": round(duration, 3), "bitrate": bitrate, "kind": "mp3"}

    # Constant bitrate: the arithmetic is the whole story.
    duration = (size - start) * 8 / float(first["bitrate"] * 1000)
    return {"duration": round(duration, 3), "bitrate": first["bitrate"], "kind": "mp3"}


def _xing_frames(head):
    for tag in (b"Xing", b"Info"):
        at = head.find(tag)
        if at != -1 and len(head) >= at + 12:
            flags = struct.unpack(">I", head[at + 4:at + 8])[0]
            if flags & 0x1:
                return struct.unpack(">I", head[at + 8:at + 12])[0]
    at = head.find(b"VBRI")
    if at != -1 and len(head) >= at + 22:
        return struct.unpack(">I", head[at + 14:at + 18])[0]
    return 0
