/* The player.
 *
 * Both decks run at once whenever two versions are loaded, one of them silent. That
 * costs a second stream from a server sitting on the same machine and buys a switch
 * between mixes with no gap, which is the point of the whole feature.
 */
"use strict";

J.player = (function () {
  const state = {
    song: null,
    queue: [],          // songs, for next and previous
    index: -1,
    slots: { A: null, B: null },   // version objects
    active: "A",
    playing: false,
    duration: 0,
    position: 0,
    volume: 0.9,
    sound: null,        // the preset in force
    presetId: null,
  };

  let ticking = null;
  let seeking = false;

  const el = () => J.$("#player");
  const deckOf = (slot) => J.audio.deck(slot);
  const activeAudio = () => deckOf(state.active).element;

  function otherSlot() { return state.active === "A" ? "B" : "A"; }

  async function ensureContext() {
    await J.audio.resume();
    ["A", "B"].forEach((slot) => J.audio.wire(deckOf(slot)));
    J.audio.setVolume(state.volume);
  }

  function srcFor(version) {
    return version ? `/api/versions/${version.id}/audio` : "";
  }

  async function loadSlot(slot, version) {
    state.slots[slot] = version || null;
    const deck = deckOf(slot);
    const wanted = srcFor(version);
    if (!wanted) {
      deck.element.removeAttribute("src");
      deck.element.load();
      return;
    }
    if (deck.versionId !== (version && version.id)) {
      deck.versionId = version.id;
      deck.element.src = wanted;
      deck.element.load();
    }
  }

  function applyGains() {
    ["A", "B"].forEach((slot) => {
      J.audio.setDeckGain(slot, slot === state.active && state.slots[slot] ? 1 : 0);
    });
  }

  async function startBoth() {
    const jobs = [];
    ["A", "B"].forEach((slot) => {
      if (!state.slots[slot]) return;
      const audio = deckOf(slot).element;
      jobs.push(audio.play().catch(() => { /* autoplay refusal, handled by the button */ }));
    });
    await Promise.all(jobs);
  }

  function pauseBoth() {
    ["A", "B"].forEach((slot) => { deckOf(slot).element.pause(); });
  }

  function syncOther() {
    const other = otherSlot();
    if (!state.slots[other]) return;
    const from = activeAudio();
    const to = deckOf(other).element;
    if (Math.abs(to.currentTime - from.currentTime) > 0.05) to.currentTime = from.currentTime;
  }

  function tick() {
    ticking = requestAnimationFrame(tick);
    const audio = activeAudio();
    if (!seeking) state.position = audio.currentTime || 0;
    if (audio.duration && Number.isFinite(audio.duration)) state.duration = audio.duration;
    paint();
  }

  function startTicking() { if (!ticking) tick(); }
  function stopTicking() { if (ticking) { cancelAnimationFrame(ticking); ticking = null; } }

  // ── painting ──────────────────────────────────────────────────────────────
  function paint() {
    const node = el();
    if (!node || node.hidden) return;
    const pct = state.duration ? (state.position / state.duration) * 100 : 0;
    const fill = J.$(".bar .fill", node);
    const knob = J.$(".bar .knob", node);
    const now = J.$(".scrubber .now", node);
    if (fill) fill.style.width = `${pct}%`;
    if (knob) knob.style.left = `${pct}%`;
    if (now) now.textContent = J.time(state.position);
    const total = J.$(".scrubber .total", node);
    if (total) total.textContent = J.time(state.duration);
    const buffered = J.$(".bar .buffered", node);
    if (buffered) {
      const audio = activeAudio();
      let end = 0;
      try { if (audio.buffered.length) end = audio.buffered.end(audio.buffered.length - 1); }
      catch (e) { end = 0; }
      buffered.style.width = state.duration ? `${(end / state.duration) * 100}%` : "0%";
    }
  }

  function render() {
    const node = el();
    if (!node) return;
    if (!state.song) { node.hidden = true; return; }
    node.hidden = false;

    const version = state.slots[state.active];
    const art = state.song.artwork_id ? `/api/artwork/${state.song.artwork_id}/image` : null;
    const hasB = !!state.slots.B;

    node.innerHTML = `
      <div class="now-playing">
        ${J.cover({ url: art, title: state.song.title })}
        <div class="truncate">
          <div class="t truncate"><a href="#/song/${state.song.id}" data-link>${J.esc(state.song.title)}</a></div>
          <div class="s truncate">${version ? `v${version.n}` : "no version"}${
            version && version.label ? ` &middot; ${J.esc(version.label)}` : ""}</div>
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
        <div class="ab-chips" title="Compare two versions. Press X to swap.">
          <button class="ab-chip ${state.active === "A" ? "on" : ""}" data-act="slot" data-slot="A">A</button>
          <button class="ab-chip ${state.active === "B" ? "on" : ""}" data-act="slot" data-slot="B"
                  ${hasB ? "" : "disabled title='Pick a second version on the song page'"}>B</button>
        </div>
        <div class="volume">
          <button class="icon-btn" data-act="mute" aria-label="Mute">
            <svg viewBox="0 0 24 24" width="17" height="17"><path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor"/>${
              state.volume > 0 ? '<path d="M16 9.5a4 4 0 0 1 0 5" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round"/>' : ""}</svg>
          </button>
          <input class="range" type="range" min="0" max="1" step="0.01" value="${state.volume}"
                 aria-label="Volume" data-act="volume" style="--fill:${state.volume * 100}%">
        </div>
        <button class="icon-btn" data-act="expand" title="Compare versions" aria-label="Expand player">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M8 14l-4 4m0 0h4m-4 0v-4M16 10l4-4m0 0h-4m4 0v4" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>`;
    paint();
  }

  // ── public ────────────────────────────────────────────────────────────────
  const api = {
    get state() { return state; },

    async play(song, version, queue) {
      await ensureContext();
      const changedSong = !state.song || state.song.id !== song.id;
      state.song = song;
      if (queue) { state.queue = queue; state.index = queue.findIndex((s) => s.id === song.id); }
      if (changedSong) {
        state.slots.B = null;
        await loadSlot("B", null);
        await api.loadSound(song.id);
      }
      state.active = "A";
      await loadSlot("A", version);
      applyGains();
      await startBoth();
      state.playing = true;
      render();
      startTicking();
      J.emit("player:change");
    },

    async loadSound(songId) {
      try {
        const data = await J.get(`/api/songs/${songId}/sound`);
        const presets = data.presets || [];
        const current = presets.find((p) => p.is_current) || presets[0];
        state.sound = current ? current.data : null;
        state.presetId = current ? current.id : null;
        if (state.sound) J.audio.apply(state.sound);
        else J.audio.apply({ bands: [], limiter: { on: false }, gain: 0 });
      } catch (e) {
        // Sound is optional. A song still plays flat if the module is switched off.
        state.sound = null;
        J.audio.apply({ bands: [], limiter: { on: false }, gain: 0 });
      }
      J.emit("sound:change");
    },

    usePreset(preset) {
      state.sound = preset ? preset.data : null;
      state.presetId = preset ? preset.id : null;
      J.audio.apply(state.sound || { bands: [], limiter: { on: false }, gain: 0 });
      J.emit("sound:change");
    },

    applySound(data) {
      state.sound = data;
      J.audio.apply(data);
    },

    async assign(slot, version) {
      await ensureContext();
      await loadSlot(slot, version);
      const audio = deckOf(slot).element;
      // Line the new deck up with where the music already is, so choosing a B while
      // something is playing does not restart it.
      const from = activeAudio();
      const at = from.currentTime || 0;
      const place = () => { try { audio.currentTime = at; } catch (e) { /* not seekable yet */ } };
      if (audio.readyState >= 1) place();
      else audio.addEventListener("loadedmetadata", place, { once: true });
      if (state.playing) await audio.play().catch(() => {});
      applyGains();
      render();
      J.emit("player:change");
    },

    async switchTo(slot) {
      if (!state.slots[slot] || slot === state.active) return;
      syncOther();
      state.active = slot;
      applyGains();
      const audio = activeAudio();
      if (state.playing && audio.paused) await audio.play().catch(() => {});
      render();
      J.emit("player:change");
    },

    swap() {
      const other = otherSlot();
      if (state.slots[other]) api.switchTo(other);
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
      const other = otherSlot();
      if (state.slots[other]) {
        try { deckOf(other).element.currentTime = at; } catch (e) { /* not ready */ }
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
      const song = state.queue[next];
      state.index = next;
      J.playSong(song, state.queue);
    },

    render,
  };

  /* Wiring the bar once. The markup is replaced often, so every handler is delegated. */
  J.on("boot", () => {
    const node = el();
    node.addEventListener("click", async (e) => {
      const hit = e.target.closest("[data-act]");
      if (!hit) return;
      const act = hit.dataset.act;
      if (act === "toggle") api.toggle();
      if (act === "next") api.step(1);
      if (act === "prev") {
        if (state.position > 3) api.seek(0);
        else api.step(-1);
      }
      if (act === "slot") api.switchTo(hit.dataset.slot);
      if (act === "mute") {
        api.setVolume(state.volume > 0 ? 0 : 0.9);
        render();
      }
      if (act === "expand") J.stage.open();
    });

    node.addEventListener("input", (e) => {
      const hit = e.target.closest("[data-act='volume']");
      if (!hit) return;
      api.setVolume(parseFloat(hit.value));
      hit.style.setProperty("--fill", `${hit.value * 100}%`);
    });

    /* Dragging the scrubber: pointer capture so it keeps following outside the bar. */
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
      const audio = deckOf(slot).element;
      audio.addEventListener("ended", () => {
        if (slot !== state.active) return;
        state.playing = false;
        stopTicking();
        render();
        api.step(1);
      });
      audio.addEventListener("error", () => {
        if (slot === state.active && state.slots[slot]) {
          J.toast("That version would not play. The file may be missing.", "bad");
        }
      });
      /* The server cannot always work out a duration, so the browser tells it once. */
      audio.addEventListener("loadedmetadata", async () => {
        const version = state.slots[slot];
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
  if (same && J.player.state.slots.A) return J.player.toggle();
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
