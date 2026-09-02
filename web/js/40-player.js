/* The player.
 *
 * A slot is a version and a preset together, because that is what you actually compare:
 * this mix through this equaliser against that mix through that one. Both decks run at
 * once with one silent, so switching is a gain swap and the playhead never moves.
 */
"use strict";

J.player = (function () {
  const state = {
    song: null,
    queue: [],
    index: -1,
    slots: { A: { version: null, preset: null }, B: { version: null, preset: null } },
    presets: [],
    active: "A",
    playing: false,
    duration: 0,
    position: 0,
    volume: 0.9,
  };

  let ticking = null;
  let seeking = false;

  const el = () => J.$("#player");
  const audioOf = (slot) => J.audio.deck(slot).element;
  const activeAudio = () => audioOf(state.active);
  const other = () => (state.active === "A" ? "B" : "A");

  async function ensureContext() {
    await J.audio.resume();
    ["A", "B"].forEach((slot) => J.audio.wire(slot));
    J.audio.setVolume(state.volume);
  }

  async function loadVersion(slot, version) {
    state.slots[slot].version = version || null;
    const deck = J.audio.deck(slot);
    if (!version) {
      deck.element.removeAttribute("src");
      deck.element.load();
      deck.versionId = null;
      return;
    }
    if (deck.versionId !== version.id) {
      deck.versionId = version.id;
      deck.element.src = `/api/versions/${version.id}/audio`;
      deck.element.load();
    }
  }

  function applyPreset(slot, preset) {
    state.slots[slot].preset = preset || null;
    J.audio.applyTo(slot, preset ? preset.data : null);
  }

  function applyGains() {
    ["A", "B"].forEach((slot) => {
      J.audio.setDeckGain(slot, slot === state.active && state.slots[slot].version ? 1 : 0);
    });
  }

  async function startBoth() {
    const jobs = [];
    ["A", "B"].forEach((slot) => {
      if (!state.slots[slot].version) return;
      jobs.push(audioOf(slot).play().catch(() => { /* autoplay refusal */ }));
    });
    await Promise.all(jobs);
  }

  function pauseBoth() {
    ["A", "B"].forEach((slot) => audioOf(slot).pause());
  }

  function syncOther() {
    const slot = other();
    if (!state.slots[slot].version) return;
    const from = activeAudio();
    const to = audioOf(slot);
    if (Math.abs(to.currentTime - from.currentTime) > 0.05) to.currentTime = from.currentTime;
  }

  function tick() {
    ticking = requestAnimationFrame(tick);
    const audio = activeAudio();
    if (!seeking) state.position = audio.currentTime || 0;
    if (audio.duration && Number.isFinite(audio.duration)) state.duration = audio.duration;
    paint();
  }
  const startTicking = () => { if (!ticking) tick(); };
  const stopTicking = () => { if (ticking) { cancelAnimationFrame(ticking); ticking = null; } };

  function paint() {
    const node = el();
    if (!node || node.hidden) return;
    const pct = state.duration ? (state.position / state.duration) * 100 : 0;
    const set = (sel, fn) => { const n = J.$(sel, node); if (n) fn(n); };
    set(".bar .fill", (n) => { n.style.width = `${pct}%`; });
    set(".bar .knob", (n) => { n.style.left = `${pct}%`; });
    set(".scrubber .now", (n) => { n.textContent = J.time(state.position); });
    set(".scrubber .total", (n) => { n.textContent = J.time(state.duration); });
    set(".bar .buffered", (n) => {
      const audio = activeAudio();
      let end = 0;
      try { if (audio.buffered.length) end = audio.buffered.end(audio.buffered.length - 1); }
      catch (e) { end = 0; }
      n.style.width = state.duration ? `${(end / state.duration) * 100}%` : "0%";
    });
  }

  function render() {
    const node = el();
    if (!node) return;
    if (!state.song) { node.hidden = true; return; }
    node.hidden = false;

    const slot = state.slots[state.active];
    const version = slot.version;
    const art = state.song.artwork_id ? `/api/artwork/${state.song.artwork_id}/image` : null;
    const hasB = !!state.slots.B.version;

    node.innerHTML = `
      <div class="now-playing">
        ${J.cover({ url: art, title: state.song.title })}
        <div class="truncate">
          <div class="t truncate"><a href="#/song/${state.song.id}" data-link>${J.esc(state.song.title)}</a></div>
          <div class="s truncate">${version ? `v${version.n}` : "no version"}${
            slot.preset ? ` &middot; ${J.esc(slot.preset.name)}` : ""}</div>
        </div>
      </div>

      <div class="transport">
        <div class="transport-row">
          <button class="icon-btn" data-act="prev" title="Previous" aria-label="Previous">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M7 6v12M19 6l-9 6 9 6z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          </button>
          <button class="play-btn sm" data-act="toggle" aria-label="${state.playing ? "Pause" : "Play"}">
            ${state.playing
              ? '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor"/></svg>'
              : '<svg viewBox="0 0 24 24" width="17" height="17"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>'}
          </button>
          <button class="icon-btn" data-act="next" title="Next" aria-label="Next">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M17 6v12M5 6l9 6-9 6z" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="scrubber">
          <span class="t now">0:00</span>
          <div class="bar" data-act="seek">
            <span class="track-line"></span><span class="buffered"></span>
            <span class="fill"></span><span class="knob"></span>
          </div>
          <span class="t right total">0:00</span>
        </div>
      </div>

      <div class="player-right">
        <div class="ab-chips" title="Compare two takes. Press X to swap.">
          <button class="ab-chip ${state.active === "A" ? "on" : ""}" data-act="slot" data-slot="A">A</button>
          <button class="ab-chip ${state.active === "B" ? "on" : ""}" data-act="slot" data-slot="B"
                  ${hasB ? "" : "disabled title='Set a B on the song page'"}>B</button>
        </div>
        <div class="volume">
          <button class="icon-btn" data-act="mute" aria-label="Mute">
            <svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/>${
              state.volume > 0 ? '<path d="M16 9.5a4 4 0 0 1 0 5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>' : ""}</svg>
          </button>
          <input class="range" type="range" min="0" max="1" step="0.01" value="${state.volume}"
                 aria-label="Volume" data-act="volume" style="--fill:${state.volume * 100}%">
        </div>
      </div>`;
    paint();
  }

  const api = {
    get state() { return state; },

    async play(song, version, queue) {
      await ensureContext();
      const changed = !state.song || state.song.id !== song.id;
      state.song = song;
      if (queue) { state.queue = queue; state.index = queue.findIndex((s) => s.id === song.id); }
      if (changed) {
        state.slots.B = { version: null, preset: null };
        await loadVersion("B", null);
        await api.loadPresets(song.id);
      }
      state.active = "A";
      await loadVersion("A", version);
      applyPreset("A", state.slots.A.preset || defaultPreset());
      applyGains();
      await startBoth();
      state.playing = true;
      render();
      startTicking();
      J.emit("player:change");
    },

    defaultPreset,

    async loadPresets(songId) {
      try {
        const data = await J.get(`/api/songs/${songId}/sound`);
        state.presets = data.presets || [];
      } catch (e) {
        state.presets = [];   // sound is optional; a song still plays flat without it
      }
      const chosen = defaultPreset();
      applyPreset("A", chosen);
      applyPreset("B", chosen);
      J.emit("sound:change");
    },

    /* Give one slot a version, a preset, or both. */
    async set(slot, what) {
      await ensureContext();
      if (what.preset !== undefined) applyPreset(slot, what.preset);
      if (what.version !== undefined) {
        await loadVersion(slot, what.version);
        // Line the deck up with where the music already is, so choosing a B while
        // something plays does not restart it.
        const audio = audioOf(slot);
        const at = activeAudio().currentTime || 0;
        const place = () => { try { audio.currentTime = at; } catch (e) { /* not seekable */ } };
        if (audio.readyState >= 1) place();
        else audio.addEventListener("loadedmetadata", place, { once: true });
        if (state.playing) await audio.play().catch(() => {});
      }
      applyGains();
      render();
      J.emit("player:change");
    },

    async switchTo(slot) {
      if (!state.slots[slot].version || slot === state.active) return;
      syncOther();
      state.active = slot;
      applyGains();
      const audio = activeAudio();
      if (state.playing && audio.paused) await audio.play().catch(() => {});
      render();
      J.emit("player:change");
    },

    swap() {
      const to = other();
      if (state.slots[to].version) api.switchTo(to);
    },

    /* An edit to a preset reaches whichever slots are using it, and nothing else. */
    presetEdited(presetId, data) {
      for (const slot of ["A", "B"]) {
        const preset = state.slots[slot].preset;
        if (preset && preset.id === presetId) {
          preset.data = data;
          J.audio.applyTo(slot, data);
        }
      }
      const known = state.presets.find((p) => p.id === presetId);
      if (known) known.data = data;
    },

    async toggle() {
      if (!state.song) return;
      await ensureContext();
      if (state.playing) {
        pauseBoth();
        state.playing = false;
        stopTicking();
      } else {
        await startBoth();
        state.playing = true;
        startTicking();
      }
      render();
      J.emit("player:change");
    },

    seek(fraction) {
      const audio = activeAudio();
      if (!state.duration) return;
      const at = J.clamp(fraction, 0, 1) * state.duration;
      audio.currentTime = at;
      state.position = at;
      const slot = other();
      if (state.slots[slot].version) {
        try { audioOf(slot).currentTime = at; } catch (e) { /* not ready */ }
      }
      paint();
    },

    setVolume(value) {
      state.volume = J.clamp(value, 0, 1);
      J.audio.setVolume(state.volume);
    },

    step(delta) {
      if (!state.queue.length) return;
      const next = state.index + delta;
      if (next < 0 || next >= state.queue.length) return;
      state.index = next;
      J.playSong(state.queue[next], state.queue);
    },

    render,
  };

  function defaultPreset() {
    return state.presets.find((p) => p.is_current) || state.presets[0] || null;
  }

  J.on("boot", () => {
    const node = el();
    node.addEventListener("click", async (e) => {
      const hit = e.target.closest("[data-act]");
      if (!hit) return;
      const act = hit.dataset.act;
      if (act === "toggle") api.toggle();
      if (act === "next") api.step(1);
      if (act === "prev") { if (state.position > 3) api.seek(0); else api.step(-1); }
      if (act === "slot") api.switchTo(hit.dataset.slot);
      if (act === "mute") { api.setVolume(state.volume > 0 ? 0 : 0.9); render(); }
    });

    node.addEventListener("input", (e) => {
      const hit = e.target.closest("[data-act='volume']");
      if (!hit) return;
      api.setVolume(parseFloat(hit.value));
      hit.style.setProperty("--fill", `${hit.value * 100}%`);
    });

    node.addEventListener("pointerdown", (e) => {
      const bar = e.target.closest("[data-act='seek']");
      if (!bar) return;
      seeking = true;
      bar.classList.add("scrubbing");
      const move = (event) => {
        const rect = bar.getBoundingClientRect();
        const fraction = J.clamp((event.clientX - rect.left) / rect.width, 0, 1);
        state.position = fraction * state.duration;
        paint();
        return fraction;
      };
      const fraction = move(e);
      const onMove = (event) => move(event);
      const onUp = (event) => {
        api.seek(move(event));
        seeking = false;
        bar.classList.remove("scrubbing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      api.seek(fraction);
    });

    ["A", "B"].forEach((slot) => {
      const audio = J.audio.deck(slot).element;
      audio.addEventListener("ended", () => {
        if (slot !== state.active) return;
        state.playing = false;
        stopTicking();
        render();
        api.step(1);
      });
      audio.addEventListener("error", () => {
        if (slot === state.active && state.slots[slot].version) {
          J.toast("That version would not play. The file may be missing.", "bad");
        }
      });
      /* The server cannot always work out a duration, so the browser tells it once. */
      audio.addEventListener("loadedmetadata", async () => {
        const version = state.slots[slot].version;
        if (!version || !Number.isFinite(audio.duration)) return;
        if (Math.abs((version.duration || 0) - audio.duration) < 0.6) return;
        version.duration = audio.duration;
        await J.try(() => J.patch(`/api/versions/${version.id}`, { duration: audio.duration }));
        J.emit("versions:changed", { songId: state.song && state.song.id });
      });
    });
  });

  return api;
})();

/* Play a song at its current version, which is what clicking a row means everywhere. */
J.playSong = async function (song, queue) {
  const same = J.player.state.song && J.player.state.song.id === song.id;
  if (same && J.player.state.slots.A.version) return J.player.toggle();
  const data = await J.try(() => J.get(`/api/songs/${song.id}/versions`));
  if (!data) return;
  const versions = data.versions || [];
  if (!versions.length) {
    J.toast("That song has no renders yet. Upload one first.", "bad");
    return;
  }
  const current = versions.find((v) => v.id === data.current_version_id) || versions[0];
  await J.player.play(song, current, queue);
};
