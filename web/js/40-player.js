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
    preparing: null,      // 0..1 while a render is being read for the compositor
  };

  let ticking = null;
  let seeking = false;

  const el = () => J.$("#player");
  const audioOf = (slot) => J.audio.deck(slot).element;

  /* Is the compositor driving playback for the song on screen.
   *
   * When it is, the transport belongs to the arrangement: the audio elements stay
   * paused and the clips are scheduled instead. Everything else about the player, the
   * scrubber, the volume, the two chips, works exactly as it did. */
  const arranged = () => !!(J.arrange && J.arrange.state.enabled && state.song
                            && J.arrange.state.songId === state.song.id
                            && J.arrange.state.clips.length);
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
    const anywhere = arranged();
    ["A", "B"].forEach((slot) => {
      // Arranged, both decks carry the same clips, so a slot is audible on its own
      // merits rather than on whether someone chose a second version for it.
      const has = anywhere || state.slots[slot].version;
      J.audio.setDeckGain(slot, slot === state.active && has ? 1 : 0);
    });
  }

  async function startBoth() {
    if (arranged()) {
      // Arranged playback needs the whole render decoded, and that is a real wait the
      // first time. It happens with the button showing what it is doing rather than
      // behind a press that appears to have done nothing.
      if (!J.arrange.ready()) {
        state.preparing = 0;
        render();
        const got = await J.try(() => J.arrange.ensure((fraction) => {
          state.preparing = fraction;
          paintPreparing();
        }));
        state.preparing = null;
        render();
        if (!got) return;
        if (!state.playing) return;        // they gave up while it loaded, which is fair
      }
      // The elements must be quiet: the same render coming from two places at once is
      // a flam, not a mix.
      ["A", "B"].forEach((slot) => audioOf(slot).pause());
      const ok = await J.arrange.start();
      if (!ok) J.toast("The arrangement has nothing to play yet.", "bad");
      return;
    }
    const jobs = [];
    ["A", "B"].forEach((slot) => {
      if (!state.slots[slot].version) return;
      jobs.push(audioOf(slot).play().catch(() => { /* autoplay refusal */ }));
    });
    await Promise.all(jobs);
  }

  function pauseBoth() {
    if (J.arrange) J.arrange.stop();
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
    if (arranged()) {
      if (!seeking) state.position = J.arrange.position;
      state.duration = J.arrange.duration();
      if (J.arrange.finished()) {
        J.arrange.stop();
        state.playing = false;
        stopTicking();
        render();
        api.step(1);
        return;
      }
      paint();
      return;
    }
    const audio = activeAudio();
    if (!seeking) state.position = audio.currentTime || 0;
    if (audio.duration && Number.isFinite(audio.duration)) state.duration = audio.duration;
    paint();
  }
  const startTicking = () => { if (!ticking) tick(); };
  const stopTicking = () => { if (ticking) { cancelAnimationFrame(ticking); ticking = null; } };

  /* Just the loading figure, without rebuilding the bar around it. */
  function paintPreparing() {
    const node = el();
    if (!node) return;
    const label = J.$(".preparing-fill", node);
    if (label) label.style.width = `${Math.round((state.preparing || 0) * 100)}%`;
    const pct = J.$(".preparing-pct", node);
    if (pct) pct.textContent = `${Math.round((state.preparing || 0) * 100)}%`;
  }

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
    const hasB = !!state.slots.B.version || arranged();

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
        ${state.preparing !== null && state.preparing !== undefined ? `
          <div class="preparing" title="Reading the render so it can be played as arranged">
            <span>Preparing the arrangement</span>
            <span class="preparing-bar"><span class="preparing-fill"></span></span>
            <span class="preparing-pct">0%</span>
          </div>` : `
        <div class="scrubber">
          <span class="t now">0:00</span>
          <div class="bar" data-act="seek">
            <span class="track-line"></span><span class="buffered"></span>
            <span class="fill"></span><span class="knob"></span>
          </div>
          <span class="t right total">0:00</span>
        </div>`}
      </div>

      <div class="player-right">
        ${hasB ? `
          <div class="ab-chips" title="Compare two takes. Press X to swap.">
            <button class="ab-chip ${state.active === "A" ? "on" : ""}" data-act="slot" data-slot="A">A</button>
            <button class="ab-chip ${state.active === "B" ? "on" : ""}" data-act="slot" data-slot="B">B</button>
            ${arranged() ? '<span class="ab-note" title="The compositor is on, so A and B compare sounds rather than takes">sound</span>' : ""}
          </div>` : ""}
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
        // Neither of these needs the other, so they go together rather than in a queue.
        await Promise.all([
          api.loadPresets(song.id),
          (J.arrange && J.state.modules.includes("arrange"))
            ? J.try(() => J.arrange.load(song.id)) : Promise.resolve(),
        ]);
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
      if (slot === state.active) return;
      if (arranged()) {
        // Only the sound changes. There is one arrangement, so there is nothing else
        // for the other chip to be.
        state.active = slot;
        applyGains();
        render();
        J.emit("player:change");
        return;
      }
      if (!state.slots[slot].version) return;
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
      if (arranged() || state.slots[to].version) api.switchTo(to);
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
      if (!state.duration) return;
      if (arranged()) {
        const to = J.clamp(fraction, 0, 1) * state.duration;
        J.arrange.seek(to);
        state.position = to;
        paint();
        return;
      }
      const audio = activeAudio();
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

    /* Right clicking whatever is playing. The bar is the one thing on screen at all
     * times, so it is the fastest way to reach the song you are listening to. */
    J.menu.on(node, ".now-playing", () => {
      if (!state.song) return null;
      const version = state.slots[state.active].version;
      return [
        { group: state.song.title },
        { label: "Open the song", icon: "open",
          run: () => { location.hash = `#/song/${state.song.id}`; } },
        { label: state.playing ? "Pause" : "Play", icon: "play", hint: "Space",
          run: () => api.toggle() },
        { divider: true },
        { label: "Back to the start", icon: "open", run: () => api.seek(0) },
        version ? { label: `Download v${version.n}`, icon: "down",
          run: () => window.open(`/api/versions/${version.id}/download`, "_blank") } : null,
        { divider: true },
        { label: "Stop and clear the player", icon: "drop",
          run: () => {
            pauseBoth();
            state.playing = false;
            state.song = null;
            stopTicking();
            render();
            J.emit("player:change");
          } },
      ];
    });

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
    /* Nothing to play, so go where something can be done about it.
     *
     * This used to be a message telling you to upload a render, which is instructions
     * rather than help: the place to do that was one screen away and you had to know
     * that. The song page is that place, and it opens with the button on it. */
    J.toast(`${song.title} has no renders yet.`);
    location.hash = `#/song/${song.id}`;
    return;
  }
  const current = versions.find((v) => v.id === data.current_version_id) || versions[0];
  await J.player.play(song, current, queue);
};
