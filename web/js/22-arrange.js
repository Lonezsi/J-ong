/* The compositor's engine: holding an arrangement, and playing a render through it.
 *
 * An arrangement is a list of clips. Each one says which stretch of the render it takes
 * and how long it is, both counted in beats, and they play back to back in order. One
 * track, no gaps, no overlaps. That is the whole model, and it is enough for the two
 * things this exists for: dropping bars out of an intro, and going round a chorus twice.
 *
 * Playback schedules a buffer source per clip rather than moving an audio element's
 * currentTime. Seeking an element takes an unpredictable moment and would put a gap at
 * every join, which is exactly where you are listening hardest.
 *
 * Each source feeds both decks at once:
 *
 *      clip 1 ─┐                    ┌─ deck A filters ─ gain A ─┐
 *      clip 2 ─┼─ scheduled in time ─┤                          ├─ master
 *      clip 3 ─┘                    └─ deck B filters ─ gain B ─┘
 *
 * so switching A to B changes which equaliser the same audio passes through, instantly
 * and without restarting anything. When the compositor is on that is all A and B do,
 * which is the point: you are comparing sounds, not takes, because there is only one
 * arrangement.
 */
"use strict";

J.arrange = (function () {
  const state = {
    songId: null,
    versionId: null,
    bpm: 120,
    offset: 0,
    perBar: 4,
    enabled: false,
    parts: [],
    clips: [],
    lyrics: {},          // part id -> lyric sheet id
    confidence: 0,
    loaded: false,
  };

  const buffers = new Map();        // version id -> AudioBuffer
  const loading = new Map();        // version id -> the fetch already in flight
  let sources = [];
  let startedAt = 0;                // ctx time when the current run began
  let startedFrom = 0;              // timeline seconds at that moment
  let running = false;
  let saveTimer = null;
  let resyncTimer = null;   // coalesces the reschedule an edit needs
  let watching = null;          // the interval that announces section changes
  let sounding = null;          // the section last announced

  /* Put a stored arrangement into state. One place, so a fetched one and one handed
   * over by the page cannot end up meaning different things. */
  function fill(a) {
    state.versionId = a.version_id || null;
    state.bpm = a.bpm || 120;
    state.offset = a.offset || 0;
    state.perBar = a.per_bar || 4;
    state.enabled = !!a.enabled;
    state.parts = a.parts || [];
    state.clips = a.clips || [];
    state.lyrics = a.lyrics || {};
    state.loaded = true;
  }

  const beatSeconds = () => 60 / (state.bpm || 120);
  const totalBeats = () => state.clips.reduce((sum, clip) => sum + clip.beats, 0);

  /* Where each clip sits on the timeline, in seconds. Computed rather than stored, so a
   * tempo correction moves everything at once and nothing can fall out of step. */
  function laid() {
    const beat = beatSeconds();
    let at = 0;
    return state.clips.map((clip) => {
      const row = {
        clip,
        at,
        seconds: clip.beats * beat,
        sourceAt: state.offset + clip.from * beat,
        part: state.parts.find((p) => p.id === clip.part) || null,
      };
      at += row.seconds;
      return row;
    });
  }

  function stopSources() {
    for (const source of sources) {
      try { source.onended = null; source.stop(); } catch (e) { /* already done */ }
      try { source.disconnect(); } catch (e) { /* already gone */ }
    }
    sources = [];
  }

  /* Put every clip on the schedule, starting from `from` seconds into the timeline. */
  function schedule(from) {
    const ctx = J.audio.context();
    const buffer = buffers.get(state.versionId);
    if (!ctx || !buffer) return false;
    stopSources();

    const inputs = ["A", "B"].map((slot) => J.audio.inputOf(slot)).filter(Boolean);
    if (!inputs.length) return false;

    // A small lead so the first clip is scheduled rather than started late.
    const begin = ctx.currentTime + 0.06;
    let started = false;

    for (const row of laid()) {
      const endsAt = row.at + row.seconds;
      if (endsAt <= from) continue;                     // already behind the playhead
      const into = Math.max(0, from - row.at);          // part way through this clip
      const when = begin + Math.max(0, row.at - from);
      const sourceStart = row.sourceAt + into;
      const length = row.seconds - into;
      if (length <= 0.001) continue;
      if (sourceStart >= buffer.duration) continue;     // clip points past the end

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      for (const input of inputs) source.connect(input);
      // Never ask for more than the file holds: a clip that runs off the end simply
      // stops, which is honest, rather than throwing and killing the whole run.
      const playable = Math.min(length, Math.max(0, buffer.duration - sourceStart));
      if (playable <= 0.001) continue;
      source.start(when, sourceStart, playable);
      sources.push(source);
      started = true;
    }

    if (!started) return false;
    startedAt = begin;
    startedFrom = from;
    return true;
  }

  function positionNow() {
    const ctx = J.audio.context();
    if (!running || !ctx) return startedFrom;
    return Math.max(0, Math.min(duration(), startedFrom + (ctx.currentTime - startedAt)));
  }

  function duration() {
    return totalBeats() * beatSeconds();
  }

  /* Fresh ids that do not collide with what is already there. */
  function nextId(prefix, existing) {
    let n = existing.length + 1;
    const taken = new Set(existing.map((item) => item.id));
    while (taken.has(prefix + n)) n++;
    return prefix + n;
  }

  const api = {
    get state() { return state; },
    get running() { return running; },
    laid,
    duration,
    beatSeconds,
    totalBeats,
    get position() { return positionNow(); },

    /* Which clip is playing at a given moment, and which part it came from. */
    at(seconds) {
      for (const row of laid()) {
        if (seconds >= row.at && seconds < row.at + row.seconds) return row;
      }
      return null;
    },

    peaks() { return J.wave.known(state.versionId); },

    /* How long the decoded render is. The waveform peaks span exactly this, so it is
     * what turns a clip's beats into a slice of the picture. */
    sourceSeconds() {
      const buffer = buffers.get(state.versionId);
      return buffer ? buffer.duration : 0;
    },

    /* Take an arrangement the page already fetched, without asking for it again.
     *
     * The song page loads everything it needs in one parallel batch. Making the
     * compositor fetch its own copy afterwards added a round trip to every visit, and
     * meant the decision to start reading the render came a beat too late to help. */
    adopt(songId, arrangement) {
      // A number, always. The id arrives as a string from the address bar and as a
      // number from the API, and the player decides whether the compositor is running
      // by comparing the two. "2" !== 2 meant it quietly never ran.
      state.songId = Number(songId);
      fill(arrangement || {});
      J.emit("arrange:change");
      return state;
    },

    async load(songId) {
      songId = Number(songId);
      if (state.songId === songId && state.loaded) return state;
      state.songId = songId;
      const data = await J.get(`/api/songs/${songId}/arrangement`);
      fill(data.arrangement || {});
      J.emit("arrange:change");
      return state;
    },


    /* Put the running audio back in step with an arrangement that has just changed.
     *
     * Not immediately, and not once per pointermove. Rescheduling tears down every
     * source and builds ten new ones, which took three quarters of a second in the
     * middle of a drag and restarted the audio seventy times over the course of one
     * trim: the timeline stuttered and the app felt broken at exactly the moment you
     * were listening to the edit.
     *
     * So edits coalesce. The last one within a beat of quiet is the one that gets
     * played, which is also the only one anybody meant. */
    resync() {
      if (!running) return;
      if (resyncTimer) clearTimeout(resyncTimer);
      resyncTimer = setTimeout(() => {
        resyncTimer = null;
        if (running) schedule(J.clamp(positionNow(), 0, Math.max(0, duration() - 0.01)));
      }, 140);
    },

    /* Written whole, and not on every pixel of a drag. */
    touch() {
      J.emit("arrange:change");
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => { saveTimer = null; api.save(); }, 600);
    },

    async save() {
      if (!state.songId) return null;
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      return J.try(() => J.put(`/api/songs/${state.songId}/arrangement`, {
        version_id: state.versionId,
        bpm: state.bpm, offset: state.offset, per_bar: state.perBar,
        enabled: state.enabled, parts: state.parts, clips: state.clips,
        lyrics: state.lyrics,
      }));
    },

    async setEnabled(on) {
      state.enabled = !!on;
      if (!on) api.stop();
      await api.save();
      J.emit("arrange:change");
      J.emit("player:change");
    },

    /* Decode a version once, and keep both the audio and its picture.
     *
     * A four minute wav is forty five megabytes, and arranged playback needs all of it
     * before it can schedule a single clip: you cannot cut a file you have not got. So
     * this reports progress as it goes, is only ever done once per render, and nothing
     * that could carry on without it is made to wait for it.
     */
    async buffer(version, onProgress) {
      if (!version) return null;
      if (buffers.has(version.id)) return buffers.get(version.id);
      if (loading.has(version.id)) return loading.get(version.id);

      const job = (async () => {
        const ctx = await J.audio.resume();
        if (!ctx) return null;
        const response = await fetch(`/api/versions/${version.id}/audio`);
        if (!response.ok) throw new Error("That render would not load.");

        const total = Number(response.headers.get("Content-Length")) || version.size || 0;
        let bytes;
        if (response.body && total) {
          // Read it in pieces so the wait can be shown rather than guessed at.
          const reader = response.body.getReader();
          const parts = [];
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            got += value.length;
            if (onProgress) onProgress(got / total, got, total);
          }
          bytes = new Uint8Array(got);
          let at = 0;
          for (const part of parts) { bytes.set(part, at); at += part.length; }
          bytes = bytes.buffer;
        } else {
          bytes = await response.arrayBuffer();
        }
        if (onProgress) onProgress(1, total, total);

        const buffer = await ctx.decodeAudioData(bytes);
        buffers.set(version.id, buffer);
        J.wave.remember(version.id, J.wave.peaksOf(buffer));
        J.emit("arrange:ready", { versionId: version.id });
        return buffer;
      })();

      loading.set(version.id, job);
      try {
        return await job;
      } finally {
        loading.delete(version.id);
      }
    },

    /* Is the audio for this arrangement in hand yet. */
    ready(versionId) {
      return buffers.has(versionId === undefined ? state.versionId : versionId);
    },

    /* The render this arrangement is built from, ready to be read.
     *
     * Which render that is belongs to the arrangement, not to whatever the song's
     * current version happens to be. A newer bounce landing does not silently repoint
     * an arrangement at a file whose bars are somewhere else, and asking the player
     * which version it holds got that wrong the moment a render was added.
     */
    async ensure(onProgress) {
      if (!state.versionId) return null;
      return api.buffer({ id: state.versionId }, onProgress);
    },

    /* Start reading it without waiting. Called when a song page opens, so that by the
     * time anyone presses play the wait has usually already happened. */
    warm() {
      if (!state.versionId || buffers.has(state.versionId)
          || loading.has(state.versionId)) return;
      api.ensure().catch(() => { /* pressing play will report it properly */ });
    },

    /* Guess the tempo and the sections, and lay the whole song out as it stands.
     *
     * The result is a starting point. Everything it decided is editable, and the panel
     * says out loud that it was a guess. */
    async detect(version) {
      const buffer = await api.buffer(version);
      if (!buffer) throw new Error("There is nothing to listen to yet.");
      const read = J.beats.read(buffer, state.perBar);
      state.versionId = version.id;
      state.bpm = read.bpm;
      state.offset = read.offset;
      state.confidence = read.confidence;
      state.parts = read.parts;
      // One clip per part, in order: the arrangement starts as the song already is.
      state.clips = read.parts.map((part, index) => ({
        id: "c" + (index + 1), part: part.id, from: part.from, beats: part.beats,
      }));
      api.touch();
      return read;
    },

    /* Tempo changes keep the music, not the numbers: beats stay where they are. */
    setTempo(bpm) {
      state.bpm = J.clamp(bpm, 20, 400);
      api.touch();
      api.resync();
    },

    setOffset(seconds) {
      state.offset = Math.max(-60, Math.min(600, seconds));
      api.touch();
      api.resync();
    },

    // ── editing ──────────────────────────────────────────────────────────────
    move(clipId, toIndex) {
      const from = state.clips.findIndex((c) => c.id === clipId);
      if (from < 0) return;
      const [clip] = state.clips.splice(from, 1);
      state.clips.splice(J.clamp(toIndex, 0, state.clips.length), 0, clip);
      api.touch();
      api.resync();
    },

    duplicate(clipId) {
      const index = state.clips.findIndex((c) => c.id === clipId);
      if (index < 0) return null;
      const copy = Object.assign({}, state.clips[index], {
        id: nextId("c", state.clips),
      });
      state.clips.splice(index + 1, 0, copy);
      api.touch();
      api.resync();
      return copy;
    },

    remove(clipId) {
      state.clips = state.clips.filter((c) => c.id !== clipId);
      api.touch();
      api.resync();
    },

    /* Trim a clip. `edge` is "start" or "end"; beats is the new whole number of beats. */
    resize(clipId, edge, beats) {
      const clip = state.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const wanted = Math.max(1, Math.round(beats));
      if (edge === "start") {
        // Pulling the left edge moves where in the render the clip begins, so the music
        // under the right hand edge does not shift while you drag the left one.
        const delta = clip.beats - wanted;
        clip.from = Math.max(0, clip.from + delta);
      }
      clip.beats = wanted;
      api.touch();
      api.resync();
    },

    renamePart(partId, name) {
      const part = state.parts.find((p) => p.id === partId);
      if (!part) return;
      part.name = String(name || "").trim().slice(0, 60) || part.name;
      api.touch();
    },

    /* Point one sheet of words at one section, or at none.
     *
     * A sheet belongs to at most one section, so any earlier link for it is dropped
     * first. Doing that here rather than at the call site is what keeps the two ends
     * from disagreeing about which card lights up.
     */
    setLyricsFor(sheetId, partId) {
      for (const [part, id] of Object.entries(state.lyrics)) {
        if (id === sheetId) delete state.lyrics[part];
      }
      if (partId) state.lyrics[partId] = sheetId;
      api.touch();
      J.emit("arrange:lyrics");
    },

    partForSheet(sheetId) {
      const found = Object.entries(state.lyrics).find(([, id]) => id === sheetId);
      return found ? state.parts.find((p) => p.id === found[0]) : null;
    },

    // ── transport ────────────────────────────────────────────────────────────

    /* Announce the section being heard, as it changes.
     *
     * This lives here rather than in the compositor panel because the words light up
     * during ordinary listening, and the panel is a drawer that is usually shut. A
     * feature that only worked while you were looking at the editor would be the wrong
     * feature. */
    _watch() {
      if (watching) return;
      watching = setInterval(() => {
        if (!running) {
          if (sounding !== null) { sounding = null; J.emit("arrange:playing", { partId: null }); }
          clearInterval(watching);
          watching = null;
          return;
        }
        const row = api.at(positionNow());
        const partId = row && row.part ? row.part.id : null;
        if (partId !== sounding) {
          sounding = partId;
          J.emit("arrange:playing", { partId });
        }
      }, 80);
    },

    async start(from) {
      const ctx = await J.audio.resume();
      if (!ctx) return false;
      ["A", "B"].forEach((slot) => J.audio.wire(slot));
      const at = from === undefined ? positionNow() : from;
      const ok = schedule(at >= duration() - 0.02 ? 0 : at);
      running = ok;
      if (ok) api._watch();
      return ok;
    },

    stop() {
      if (running) startedFrom = positionNow();
      if (resyncTimer) { clearTimeout(resyncTimer); resyncTimer = null; }
      stopSources();
      running = false;
      if (sounding !== null) { sounding = null; J.emit("arrange:playing", { partId: null }); }
    },

    seek(seconds) {
      const at = J.clamp(seconds, 0, Math.max(0, duration() - 0.01));
      if (running) {
        schedule(at);
      } else {
        startedFrom = at;
      }
    },

    /* Has the run reached the end. The player asks each frame rather than relying on an
     * ended event, because the last clip ending is not the same as the arrangement
     * finishing when a clip was cut short. */
    finished() {
      return running && positionNow() >= duration() - 0.02;
    },

    forget(versionId) {
      buffers.delete(versionId);
      J.wave.forget(versionId);
    },
  };

  return api;
})();
