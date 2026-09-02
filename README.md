# J-ong

A personal, self-hosted music workspace where the thing you work with is a **song**, not a file.

A song holds every render you have made of it, the lyrics and their alternatives, artwork,
album membership, and its own playback settings. The website is where you browse, listen,
compare mixes and organise. The desktop agent watches the folder your exports land in and
puts new renders where they belong.

Standard library Python and plain browser JavaScript. Nothing to install, no build step.

```
python server.py --open
```

Then open http://127.0.0.1:7900.

---

## What it does

**Versions.** Every render of a song is kept and numbered. Upload one and it becomes v14;
the ones before it stay exactly where they were.

**A/B comparison.** Put two versions in slots A and B and switch between them. Both decks
play at once with one of them silent, so the switch is a gain change on the next audio
block: the same bar of the other mix, no gap and no fade. That is the feature the player
is built around. Press **X** to swap.

**Lyrics with alternatives.** A song has several lyric sheets and one of them is current.
Arrow keys page between them sideways. Each alternative keeps its own history, so trying a
different second verse never costs you the first, and restoring an old text is a new
revision rather than an overwrite.

**A real equaliser.** Not a bank of fixed sliders. Double click the display to add a node,
drag it to move it in frequency and gain, roll the wheel over it to change Q, right click
to remove it. Bells, shelves, cuts and notches, up to 24 bands. The curve drawn is the
actual response of the filter chain, read back from the audio graph, with a spectrum
analyser behind it. There is a limiter with a gain reduction meter, and per-song presets
(Current, Car, Headphones, Loud) you can A/B.

All of that is **playback processing**. Your uploaded render is never modified.

**Albums.** Cover, year, ordered songs. A song can sit on several albums, and its position
belongs to the album rather than to the song.

**YouTube.** J-ong does not upload for you. It records which render went up, so six
versions later you still know what is actually online.

---

## The desktop agent

```
cd client
python jong_client.py server http://127.0.0.1:7900
python jong_client.py add "C:\Users\you\Music\Renders"
python jong_client.py scan      # what is new, without sending anything
python jong_client.py push      # send it
python jong_client.py watch     # keep doing that
python jong_client.py install   # run watch at logon
```

It reads those folders and never writes to them. When it finds something new it asks the
library which song it looks like a new render of, and offers that rather than making a
second song every time you export.

### On "only send the changes"

Every file is hashed locally and the server is asked which of those hashes it already
holds. Anything it has is skipped without a byte leaving the machine, so a folder of two
hundred unchanged renders costs one small request.

What J-ong deliberately does **not** do is store binary deltas between renders. Two MP3s
of the same song share essentially no bytes, because re-encoding rewrites the whole
stream, so a delta would save close to nothing while making every read depend on a chain
of patches. Deduplication by content is the honest version of the same idea, and it is
what the storage does: identical bytes are stored once, whatever they are called and
whichever song they belong to.

---

## On your machine

```
cd client
python jong_client.py install
```

That does three things, none of which needs an administrator:

- the folder watcher runs at logon
- a **right click menu** appears on audio files, on `.flp` projects, and on folders
- a daily task pulls a newer J-ong from GitHub at 05:00

The right click entries are:

| where | what it says |
|---|---|
| an mp3, wav, flac, m4a, ogg | **Upload to J-ong** |
| an `.flp` | **Render and send to J-ong** |
| a folder | **Render every FL project in here** |
| a folder | **Watch this folder with J-ong** |

All of it is written under `HKEY_CURRENT_USER`, so it belongs to you rather than the
machine, no file associations are touched (an mp3 still opens with whatever opened it
before), and `jong_client.py shell remove` takes it away completely.

---

## Rendering FL Studio projects

```
python jong_client.py render "C:\Users\you\Projects"
```

**FL Studio's command line render is not headless, and this does not pretend otherwise.**
FL takes a `/R` switch that renders a project, and it works, but launching it opens the
application: you see its window, it loads the project, and on some versions the export
dialog waits for Start to be pressed. Image-Line's own forum has people asking about
exactly this and not getting a better answer. So J-ong tells you that before it starts
rather than leaving you to discover it.

What it does do reliably: it finds FL for you, copies each project somewhere without
spaces first (FL's command line has a long history of mishandling quoted paths), waits
for the audio to appear and stop growing, finds the file even when FL writes it under a
different name, skips FL's own `Backup` folders, and hands each finished render to the
library with the usual "is this a new render of X?" question.

Waiting on the file rather than on FL's window title is deliberate. Title watching is
what most scripts do and it breaks on a different language, a different version, and
anywhere the window is not visible. A file that has stopped growing is the same fact
everywhere.

If FL is somewhere unusual:

```
python jong_client.py flpath "C:\Program Files\Image-Line\FL Studio 2024\FL64.exe"
```

---

## Updating itself

Settings has a **Check for updates** button. It compares this checkout against the branch
on GitHub and, if it is behind, offers a fast forward pull. It refuses when there are
uncommitted changes rather than throwing them away, and it says plainly when it could not
reach GitHub instead of reporting that you are up to date.

Python has already imported the running code, so after an update that touches `.py` files
the app tells you to restart. It does not pretend a reload was enough.

The client has the same thing: `python jong_client.py update`.

---

## The password

One password for the whole library, and **no rules about what it may be**. Length limits
and "must contain a symbol" mostly push people towards one bad password reused everywhere,
and this library has one user who already knows what it is worth.

What guards it instead is a limit on guessing: six wrong answers from an address and that
address waits, for 30 seconds, then 2 minutes, 10, 30, an hour. A limit like that costs
the person who knows the password nothing and makes even a very short one impractical to
brute force. Each address is counted separately, so somebody else guessing badly cannot
lock you out of your own library.

The password is never stored. It goes through scrypt, which is deliberately slow and
memory hungry, and only the result is kept, salted per library.

**The first password.** A fresh library has none, and the server prints a one time setup
code at startup. That code has to be presented to choose the first password, which is what
stops the first stranger who finds a public J-ong from choosing it for you. The code stops
existing the moment a password is set.

Changing the password signs every device out. Settings has both buttons.

To run with no door at all, which is what you want on a machine only you can reach, take
`"auth"` out of `MODULES`.

---

## Everything is a module

Each feature is a file in `jong/modules/` listed in `jong/config.py`:

```python
MODULES = [
    "core", "auth", "appearance", "songs", "versions", "artwork",
    "lyrics", "albums", "sound", "sync", "updater",
]
```

A module owns its own tables and its own routes. Take a name out of that list and the
feature is gone: its tables stop being created, its endpoints stop existing, and the
**web interface stops drawing it**, because the front end asks `/api/state` what is
switched on rather than assuming. No dead buttons that return 404.

A module that fails to load is named out loud at startup and in the interface, and the
rest of the library still opens.

The browser side works the same way. `web/css/*.css` and `web/js/*.js` are concatenated in
filename order into `/jong.css` and `/jong.js`, so a feature is a file, the numeric prefix
is the load order, and deleting the file removes the feature. There is no bundler.

To add a feature, write `jong/modules/yours.py` with `SCHEMA` and `ROUTES()`, add a
`web/js/NN-view-yours.js` that registers `J.views.yours`, and put the name in the list.

---

## Where things live

```
server.py              start it
jong/
  config.py            paths, and the module list
  db.py                sqlite, one connection per thread
  blobs.py             content addressed storage
  http.py              routing, static bundling, byte ranges for audio
  registry.py          loads whichever modules are switched on
  wire.py              what a route handler receives and returns
  audio_meta.py        duration and bitrate, without a third party library
  modules/             one file per feature
web/
  index.html
  css/                 bundled in filename order
  js/                  bundled in filename order
client/
  jong_client.py       the desktop agent
tests/                 111 tests, run with: python -m pytest tests -q
data/                  your library. Not in git.
```

`data/` holds the database and every file you have uploaded, so a backup is one copy of
one directory.

---

## Keyboard

| | |
|---|---|
| `Space` | play or pause |
| `X` | swap A and B |
| `/` | search |
| `←` `→` | page between lyric alternatives |
| `Shift` `←` `→` | previous or next song |

---

## Settings

`JONG_DATA` moves the library. `JONG_PORT` and `JONG_HOST` move the server.
`JONG_REPO` and `JONG_BRANCH` point the updater somewhere else.

The accent colour and the library name are in Settings. Everything in the interface
derives from the one accent value.
