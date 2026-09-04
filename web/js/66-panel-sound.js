/* Sound: the curve, the limiter, and the presets you compare them with.
 *
 * Nothing here is written into the render. It is applied while the browser plays, and
 * the stored file is never touched.
 *
 * A preset is made flat and unnamed. Naming a thing before it exists is a question with
 * no useful answer, so the new one is called Preset 2 and the pen next to it renames it
 * once it is worth a name. The two small buttons beside the chosen preset rename and
 * copy it, and nothing else, so the row stays a row of presets.
 *
 * The panel is built once and updated in place, because rebuilding it while a node is
 * under the pointer throws the canvas away mid drag.
 */
"use strict";

J.blockSound = async function (panel, ctx) {
  /* An equaliser for a song with no audio on it is a control with nothing behind it.
   *
   * It rendered in full on a brand new song: thirty knobs and a frequency curve for
   * something that cannot be played, before the person has any idea what any of it is
   * for. So until there is a render, the panel says what it is for instead. */
  if (!ctx.versions.length) {
    panel.innerHTML = `
      <div class="block-head"><h2>Sound</h2></div>
      <div class="empty">
        <h3>Nothing to listen to yet</h3>
        <p>This is where you hear the same bounce through two different equalisers and
           pick one. It is only ever applied while you listen: J-ong never writes it into
           the file, so nothing here can damage a mix.</p>
      </div>`;
    return;
  }

  let presets = [];
  let active = null;
  let editor = null;
  let limiterView = null;

  /* Both shut to begin with.
   *
   * A frequency curve and a limiter opened to full height every time a song did, which
   * put the thing you came for, the renders and the words, below the fold behind two
   * instruments most visits never touch. They are one press away and they remember
   * whether you left them open, per browser, because that is a convenience rather than
   * anything the library should hold. */
  const FOLD_KEY = "jong.sound.open";
  let open = { eq: false, limiter: false };
  try {
    const kept = JSON.parse(localStorage.getItem(FOLD_KEY) || "null");
    if (kept && typeof kept === "object") open = { eq: !!kept.eq, limiter: !!kept.limiter };
  } catch (e) { /* a private window, or nothing stored: the default stands */ }
  const remember = () => {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(open)); } catch (e) { /* fine */ }
  };

  const chevron = (isOpen) => `<svg class="fold-mark ${isOpen ? "open" : ""}" viewBox="0 0 24 24"
      width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2"
      stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>`;

  const save = J.debounce(async (preset) => {
    await J.try(() => J.put(`/api/sound/${preset.id}`, { data: preset.data }));
  }, 600);

  /* Which decks are listening to this preset right now. Editing reaches those and
   * nothing else, so shaping one song never changes what another is playing. */
  const pushToPlayer = () => J.player.presetEdited(active.id, active.data);

  /* The deck this panel is editing.
   *
   * A and B are not two views of one equaliser, they are two equalisers, and which one
   * you are shaping is whichever is selected. Before this, the panel chose a preset on
   * its own and then only made a sound if a deck happened to be holding that same
   * preset, which is why it used to have to say "put this preset in A or B above to
   * hear it": you could shape a curve at length and hear nothing at all. */
  function liveSlot() {
    const state = J.player.state;
    if (!state.song || state.song.id !== ctx.song.id) return null;
    const held = state.slots[state.active];
    return held && held.version ? state.active : null;
  }

  /* What the selected deck is playing through, if the panel can tell.
   *
   * Falls back to the deck's own copy when the panel has not heard of it. A preset can
   * come into existence after this panel loaded its list: putting a take into B forks
   * the shared preset so the two decks stop being the same equaliser, and until the list
   * catches up the only thing that knows about the new one is the deck holding it.
   * Without this fallback the panel quietly kept editing A while B was selected. */
  function presetOfSelection() {
    const slot = liveSlot();
    if (!slot) return null;
    const held = J.player.state.slots[slot].preset;
    if (!held) return null;
    return presets.find((p) => p.id === held.id) || held;
  }

  /* Choosing a preset puts it on the selected deck, rather than only changing which one
   * is on screen. Selecting B and then choosing a curve means B has that curve. */
  function choose(preset, { push = true } = {}) {
    if (!preset || (active && preset.id === active.id && !push)) return;
    active = preset;
    const slot = liveSlot();
    if (push && slot) J.player.set(slot, { preset });
    draw();
  }

  async function load() {
    const data = await J.get(`/api/songs/${ctx.songId}/sound`);
    presets = data.presets || [];
    ctx.presets = presets;
    active = presetOfSelection() || presets.find((p) => p.is_current) || presets[0];
    draw();
  }

  const FLAT = () => ({
    bands: [],
    limiter: { on: false, threshold: -6, ceiling: -0.3, release: 120, attack: 5 },
    gain: 0, bypass: false,
  });

  function draw() {
    panel.innerHTML = `
      <div class="block-head">
        <h2>Sound</h2>
        <span class="grow"></span>
        <span class="preset-row" id="presetRow"></span>
      </div>

      <button class="fold-head" data-fold="eq" aria-expanded="${open.eq}">
        ${chevron(open.eq)}
        <h3>Equaliser</h3>
        <span class="fold-sub">${(active.data.bands || []).length
          ? `${(active.data.bands || []).length} band${(active.data.bands || []).length === 1 ? "" : "s"}`
          : "flat"}${active.data.bypass ? " &middot; bypassed" : ""}</span>
      </button>

      <div class="eq-wrap" ${open.eq ? "" : "hidden"}>
        <canvas class="eq-canvas" id="eqCanvas"></canvas>
        <div class="eq-readout" id="eqReadout"></div>
        <div class="eq-hint">click to place a band &middot; drag it &middot; double click to remove</div>
      </div>

      <div class="eq-toolbar" ${open.eq ? "" : "hidden"}>
        <button class="btn sm" data-act="add" data-type="peaking">Bell</button>
        <button class="btn sm ghost" data-act="add" data-type="highpass">Low cut</button>
        <button class="btn sm ghost" data-act="add" data-type="lowpass">High cut</button>
        <button class="btn sm ghost" data-act="add" data-type="lowshelf">Low shelf</button>
        <button class="btn sm ghost" data-act="add" data-type="highshelf">High shelf</button>
        <span class="grow"></span>
        <div class="pills">
          ${[12, 18, 24, 30].map((r) =>
            `<button class="pill quiet ${r === 18 ? "on" : ""}" data-range="${r}">&plusmn;${r}</button>`).join("")}
        </div>
        <button class="pill" id="bypassPill" data-act="bypass"></button>
      </div>

      <div class="band-list" id="bandList" ${open.eq ? "" : "hidden"}></div>

      <div class="limiter-head">
        <button class="fold-head bare" data-fold="limiter" aria-expanded="${open.limiter}">
          ${chevron(open.limiter)}
          <h3>Limiter</h3>
        </button>
        <button class="switch" id="limiterSwitch" data-act="limiter-toggle"
                aria-label="Limiter on"></button>
        <span class="grow"></span>
        <span class="limiter-nums" id="limiterNums"></span>
      </div>
      <div class="limiter-wrap" ${open.limiter ? "" : "hidden"}>
        <canvas class="limiter-canvas" id="limiterCanvas"></canvas>
        <div class="limiter-hint">drag the two lines</div>
      </div>
      <div class="limiter-knobs" id="limiterKnobs" ${open.limiter ? "" : "hidden"}></div>

      <div class="row wrap" style="margin-top:var(--s5)" id="presetActions"></div>
      <p class="sound-note" id="soundNote"></p>`;

    mountEditor();
    mountLimiter();
    renderPresets();
    renderBands();
    renderKnobs();
    syncChrome();
  }

  /* The presets, and the two things you can do to the chosen one. */
  function renderPresets() {
    J.$("#presetRow", panel).innerHTML =
      presets.map((p) => `
        <button class="sheet-tab ${p.id === active.id ? "on" : ""}" data-preset="${p.id}"
                title="${J.esc(p.name)}">${J.esc(p.name)}</button>`).join("")
      + `<span class="preset-tools">
          <button class="icon-btn tiny" data-act="rename-preset" title="Rename this preset"
                  aria-label="Rename preset">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
          <button class="icon-btn tiny" data-act="clone-preset" title="Copy this preset"
                  aria-label="Copy preset">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="11" height="11" rx="2"/>
              <path d="M5 15V5a2 2 0 0 1 2-2h10"/>
            </svg>
          </button>
          <button class="icon-btn tiny" data-act="new-preset" title="A new flat preset"
                  aria-label="New preset">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
        </span>`;

    J.$("#presetActions", panel).innerHTML = `
      ${active.is_current ? "" : '<button class="btn ghost sm" data-act="make-current">Open with this one</button>'}
      <button class="btn ghost sm" data-act="reset">Flatten</button>
      <span class="grow"></span>
      ${presets.length > 1 ? '<button class="btn ghost sm danger" data-act="delete-preset">Delete preset</button>' : ""}`;
  }

  /* Band cards, each with a knob for Q. A wheel is not available on a phone, so the knob
   * is the only way to reach it there, and it is a better way to reach it anywhere. */
  function renderBands() {
    const list = J.$("#bandList", panel);
    if (!list) return;
    const bands = active.data.bands || [];
    if (!bands.length) {
      list.innerHTML = `<p class="faint" style="margin:var(--s2) 0">
        Flat. Click anywhere on the display to place a band exactly there.</p>`;
      refreshReadout();
      return;
    }
    list.innerHTML = bands.map((band) => `
      <div class="band-card ${band.on ? "" : "off"} ${editor && editor.selected === band.id ? "on" : ""}"
           data-band="${band.id}">
        <div class="head">
          <span class="kind">${J.eq.TYPE_LABEL[band.type] || band.type}</span>
          <button class="switch tiny ${band.on ? "on" : ""}" data-act="band-toggle"
                  aria-label="Band on"></button>
        </div>
        <div class="freq">${J.eq.fmtHz(band.freq)}<span class="unit">Hz</span></div>
        <div class="band-bottom">
          <span class="gain">${J.eq.FLAT.has(band.type) ? "&mdash;"
            : (band.gain > 0 ? "+" : "") + band.gain.toFixed(1) + " dB"}</span>
          <span class="q-knob" data-band="${band.id}" title="Drag for Q"
                role="slider" tabindex="0" aria-label="Q"
                aria-valuenow="${band.q.toFixed(2)}">
            <svg viewBox="0 0 34 34" width="34" height="34">
              <circle cx="17" cy="17" r="14" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="3"/>
              <circle cx="17" cy="17" r="14" fill="none" stroke="var(--accent)" stroke-width="3"
                      stroke-linecap="round" stroke-dasharray="${qArc(band.q)} 999"
                      transform="rotate(135 17 17)"/>
              <line x1="17" y1="17" x2="17" y2="7" stroke="var(--text)" stroke-width="2"
                    stroke-linecap="round" transform="rotate(${qAngle(band.q)} 17 17)"/>
            </svg>
            <span class="q-value">${band.q.toFixed(2)}</span>
          </span>
        </div>
        <select data-act="band-type" aria-label="Filter type">
          ${Object.keys(J.eq.TYPE_LABEL).map((type) =>
            `<option value="${type}" ${type === band.type ? "selected" : ""}>${J.eq.TYPE_LABEL[type]}</option>`).join("")}
        </select>
        <button class="btn ghost sm danger band-remove" data-act="band-remove">Remove</button>
      </div>`).join("");
    refreshReadout();
  }

  /* Q runs 0.05 to 30 and is felt logarithmically, so the dial is too. */
  const qFraction = (q) => J.clamp(Math.log(q / 0.05) / Math.log(30 / 0.05), 0, 1);
  const qFromFraction = (f) => 0.05 * Math.pow(30 / 0.05, J.clamp(f, 0, 1));
  const qArc = (q) => (qFraction(q) * 270 * Math.PI * 14) / 180;
  const qAngle = (q) => -135 + qFraction(q) * 270;

  const updateBandNumbers = J.debounce(() => {
    if (!panel.isConnected) return;
    for (const band of active.data.bands || []) {
      const card = J.$(`[data-band="${band.id}"]`, panel);
      if (!card) { renderBands(); return; }
      const freq = J.$(".freq", card);
      if (freq) freq.innerHTML = `${J.eq.fmtHz(band.freq)}<span class="unit">Hz</span>`;
      const gain = J.$(".gain", card);
      if (gain) {
        gain.innerHTML = J.eq.FLAT.has(band.type) ? "&mdash;"
          : `${band.gain > 0 ? "+" : ""}${band.gain.toFixed(1)} dB`;
      }
      const knob = J.$(".q-knob", card);
      if (knob) {
        J.$(".q-value", knob).textContent = band.q.toFixed(2);
        const arc = knob.querySelectorAll("circle")[1];
        const needle = knob.querySelector("line");
        if (arc) arc.setAttribute("stroke-dasharray", `${qArc(band.q)} 999`);
        if (needle) needle.setAttribute("transform", `rotate(${qAngle(band.q)} 17 17)`);
        knob.setAttribute("aria-valuenow", band.q.toFixed(2));
      }
      card.classList.toggle("on", editor && editor.selected === band.id);
      card.classList.toggle("off", !band.on);
    }
  }, 40);

  function renderKnobs() {
    const lim = active.data.limiter || {};
    J.$("#limiterKnobs", panel).innerHTML = [
      ["attack", "Attack", 0, 100, 1, "ms"],
      ["release", "Release", 1, 1000, 1, "ms"],
    ].map(([key, label, min, max, step, unit]) => `
      <div class="knob-row">
        <div class="lab"><span>${label}</span><b>${Number(lim[key]).toFixed(0)} ${unit}</b></div>
        <input class="range" type="range" data-lim="${key}" min="${min}" max="${max}"
               step="${step}" value="${lim[key]}"
               style="--fill:${((lim[key] - min) / (max - min)) * 100}%">
      </div>`).join("") + `
      <div class="knob-row">
        <div class="lab"><span>Output</span><b>${(active.data.gain || 0).toFixed(1)} dB</b></div>
        <input class="range" type="range" data-gain min="-12" max="12" step="0.1"
               value="${active.data.gain || 0}"
               style="--fill:${(((active.data.gain || 0) + 12) / 24) * 100}%">
      </div>`;
  }

  function syncChrome() {
    const pill = J.$("#bypassPill", panel);
    if (pill) {
      pill.textContent = active.data.bypass ? "Bypassed" : "Bypass";
      pill.classList.toggle("on", !!active.data.bypass);
      pill.classList.toggle("quiet", !active.data.bypass);
    }
    const note = J.$("#soundNote", panel);
    if (note) {
      const slot = liveSlot();
      note.textContent = "Playback only. Your uploaded render is never modified."
        + (slot ? ` You are shaping ${slot}.`
                : " Play this song to hear what you are shaping.");
    }
    const sw = J.$("#limiterSwitch", panel);
    if (sw) sw.classList.toggle("on", !!(active.data.limiter || {}).on);
  }

  function mountEditor() {
    const canvas = J.$("#eqCanvas", panel);
    if (!canvas) return;
    if (editor) editor.stop();
    editor = J.eq.create(canvas, {
      data: active.data,
      slot: liveSlot,
      onChange: (data) => {
        active.data = data;
        pushToPlayer();
        save(active);
        const cards = J.$$("#bandList .band-card", panel).length;
        if (cards !== (data.bands || []).length) renderBands();
        else updateBandNumbers();
      },
      onSelect: () => { refreshReadout(); updateBandNumbers(); },
      onFrame: refreshReadout,
    });
    const chosen = J.$("[data-range].on", panel);
    editor.setRange(chosen ? Number(chosen.dataset.range) : 18);
    // Folded away, it is a canvas nobody can see: measuring zero and animating it
    // sixty times a second is work with no output. It reads its own size on the
    // first frame after starting, so being started late costs nothing.
    if (open.eq) editor.start();
  }

  function mountLimiter() {
    const canvas = J.$("#limiterCanvas", panel);
    if (!canvas) return;
    if (limiterView) limiterView.stop();
    limiterView = J.limiter.create(canvas, {
      data: active.data,
      reduction: () => {
        const slot = liveSlot();
        return slot ? J.audio.reductionOf(slot) : 0;
      },
      level: () => { const at = liveSlot(); return at ? J.audio.peakDb(at) : -60; },
      onChange: (data) => {
        active.data = data;
        pushToPlayer();
        save(active);
        showLimiterNumbers();
      },
    });
    if (open.limiter) limiterView.start();
    showLimiterNumbers();
  }

  function showLimiterNumbers() {
    const nums = J.$("#limiterNums", panel);
    if (!nums) return;
    const lim = active.data.limiter || {};
    const slot = liveSlot();
    const reduction = slot ? J.audio.reductionOf(slot) : 0;
    nums.innerHTML = `<span>thr <b>${Number(lim.threshold).toFixed(1)}</b></span>
      <span>ceil <b>${Number(lim.ceiling).toFixed(1)}</b></span>
      <span>gr <b>${reduction.toFixed(1)}</b></span>`;
  }
  setInterval(() => { if (panel.isConnected) showLimiterNumbers(); }, 140);

  function refreshReadout() {
    const readout = J.$("#eqReadout", panel);
    if (!readout || !editor) return;
    const bands = active.data.bands || [];
    const band = bands.find((b) => b.id === editor.selected);
    readout.innerHTML = band
      ? `<span>${J.eq.TYPE_LABEL[band.type]}</span>
         <span><b>${J.eq.fmtHz(band.freq)}</b> Hz</span>
         ${J.eq.FLAT.has(band.type) ? "" : `<span><b>${band.gain > 0 ? "+" : ""}${band.gain.toFixed(1)}</b> dB</span>`}
         <span>Q <b>${band.q.toFixed(2)}</b></span>`
      : `<span>${bands.length} band${bands.length === 1 ? "" : "s"}</span>`;
  }

  /* Right clicking a preset. The rename, clone and new buttons are icons next to the
   * selected one; this is where the rest of it lives, including deleting one, which
   * should not be a button sitting next to the thing it deletes. */
  J.menu.on(panel, "[data-preset]", (node) => {
    const preset = presets.find((p) => String(p.id) === node.dataset.preset);
    if (!preset) return null;
    const bands = (preset.data.bands || []).length;
    return [
      { group: preset.name },
      { label: preset.id === active.id ? "Selected" : "Use this one", icon: "play",
        disabled: preset.id === active.id, run: () => node.click() },
      { label: preset.is_current ? "This is the song's own" : "Make it the song's own",
        icon: "star", disabled: !!preset.is_current,
        run: async () => {
          await J.try(() => J.post(`/api/sound/${preset.id}/current`), "Set");
          await load();
        } },
      { divider: true },
      /* These press the panel's own buttons rather than repeating what they do, so
       * there is one implementation of renaming a preset and the menu cannot drift
       * away from it. */
      { label: "Rename", icon: "edit",
        run: () => J.$('[data-act="rename-preset"]', panel)?.click() },
      { label: `Duplicate${bands ? ` (${bands} band${bands === 1 ? "" : "s"})` : ""}`,
        icon: "copy", run: () => J.$('[data-act="clone-preset"]', panel)?.click() },
      { divider: true },
      { label: "Delete this preset", icon: "drop", danger: true,
        disabled: presets.length < 2,
        run: () => J.$('[data-act="delete-preset"]', panel)?.click() },
    ];
  });

  /* Dragging a Q knob. Vertical, because that is how a knob is turned with a thumb. */
  panel.addEventListener("pointerdown", (e) => {
    const knob = e.target.closest(".q-knob");
    if (!knob) return;
    e.preventDefault();
    const band = (active.data.bands || []).find((b) => b.id === knob.dataset.band);
    if (!band) return;
    const startY = e.clientY;
    const startFraction = qFraction(band.q);
    knob.classList.add("turning");
    // Capture is a convenience, not a requirement: it keeps the drag alive when the
    // pointer leaves the knob. Letting it throw here skipped the listeners below and
    // the knob did nothing at all, so it is attempted rather than relied on.
    try { knob.setPointerCapture(e.pointerId); } catch (err) { /* drag still works */ }

    const move = (event) => {
      const delta = (startY - event.clientY) / 140;      // 140px is the full sweep
      band.q = Math.round(qFromFraction(startFraction + delta) * 100) / 100;
      pushToPlayer();
      save(active);
      updateBandNumbers();
      if (editor) editor.select(band.id);
    };
    const up = (event) => {
      knob.classList.remove("turning");
      try { knob.releasePointerCapture(event.pointerId); } catch (err) { /* already */ }
      knob.removeEventListener("pointermove", move);
      knob.removeEventListener("pointerup", up);
      knob.removeEventListener("pointercancel", up);
    };
    knob.addEventListener("pointermove", move);
    knob.addEventListener("pointerup", up);
    knob.addEventListener("pointercancel", up);
  });

  panel.addEventListener("keydown", (e) => {
    const knob = e.target.closest(".q-knob");
    if (!knob) return;
    const band = (active.data.bands || []).find((b) => b.id === knob.dataset.band);
    if (!band) return;
    const step = e.key === "ArrowUp" ? 0.04 : e.key === "ArrowDown" ? -0.04 : 0;
    if (!step) return;
    e.preventDefault();
    band.q = Math.round(qFromFraction(qFraction(band.q) + step) * 100) / 100;
    pushToPlayer(); save(active); updateBandNumbers();
  });

  panel.addEventListener("click", async (e) => {
    const presetTab = e.target.closest("[data-preset]");
    if (presetTab) {
      choose(presets.find((p) => String(p.id) === presetTab.dataset.preset));
      return;
    }

    const fold = e.target.closest("[data-fold]");
    if (fold) {
      const which = fold.dataset.fold;
      open[which] = !open[which];
      remember();
      draw();
      return;
    }

    const rangePill = e.target.closest("[data-range]");
    if (rangePill) {
      J.$$("[data-range]", panel).forEach((b) => b.classList.toggle("on", b === rangePill));
      editor.setRange(Number(rangePill.dataset.range));
      return;
    }

    const act = e.target.closest("[data-act]");
    if (!act) return;
    const what = act.dataset.act;
    const card = act.closest("[data-band]");
    const band = card ? (active.data.bands || []).find((b) => b.id === card.dataset.band) : null;

    if (what === "add") { editor.addBand(act.dataset.type); renderBands(); }
    if (what === "band-remove" && band) { editor.remove(band.id); renderBands(); }
    if (what === "band-toggle" && band) {
      editor.update(band.id, { on: !band.on });
      act.classList.toggle("on", band.on);
      card.classList.toggle("off", !band.on);
    }
    if (what === "bypass") {
      active.data.bypass = !active.data.bypass;
      pushToPlayer(); save(active); syncChrome();
    }
    if (what === "limiter-toggle") {
      active.data.limiter.on = !active.data.limiter.on;
      pushToPlayer(); save(active); syncChrome();
    }
    if (what === "reset") {
      const sure = await J.confirm("Flatten this preset?",
        "Every band goes and the limiter switches off.", "Flatten it");
      if (!sure) return;
      active.data = FLAT();
      pushToPlayer(); save.now(active); draw();
    }
    if (what === "make-current") {
      await J.try(() => J.post(`/api/sound/${active.id}/current`), "This one opens first");
      await load();
    }

    /* A new preset is flat and already named. Nothing to answer before it exists. */
    if (what === "new-preset") {
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/sound`, {
        name: `Preset ${presets.length + 1}`, data: FLAT() }));
      if (!made) return;
      await load();
      const fresh = presets.find((p) => p.id === made.preset.id);
      if (fresh) { active = fresh; draw(); }
      J.toast("Flat preset added");
    }

    /* Copying keeps the curve and takes a new name, which is the point of copying. */
    if (what === "clone-preset") {
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/sound`, {
        name: `${active.name} copy`, copy_from: active.id }));
      if (!made) return;
      await load();
      const fresh = presets.find((p) => p.id === made.preset.id);
      if (fresh) { active = fresh; draw(); }
      J.toast("Copied");
    }

    if (what === "rename-preset") {
      const values = await J.sheet({
        title: "Name this preset", confirm: "Save",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" value="${J.esc(active.name)}"
                 placeholder="Car"></label></div>`,
      });
      if (!values || !values.name.trim()) return;
      await J.try(() => J.patch(`/api/sound/${active.id}`, { name: values.name.trim() }));
      await load();
    }

    if (what === "delete-preset") {
      const sure = await J.confirm(`Delete “${active.name}”?`, "", "Delete it");
      if (!sure) return;
      await J.try(() => J.del(`/api/sound/${active.id}`), "Deleted");
      await load();
    }
  });

  panel.addEventListener("change", (e) => {
    const select = e.target.closest("[data-act='band-type']");
    if (!select) return;
    editor.update(select.closest("[data-band]").dataset.band, { type: select.value });
    renderBands();
  });

  panel.addEventListener("input", (e) => {
    const range = e.target;
    if (range.dataset.lim) {
      active.data.limiter[range.dataset.lim] = parseFloat(range.value);
      J.$("b", range.closest(".knob-row")).textContent =
        `${parseFloat(range.value).toFixed(0)} ms`;
      range.style.setProperty("--fill",
        `${((range.value - range.min) / (range.max - range.min)) * 100}%`);
      pushToPlayer(); save(active);
    }
    if (range.hasAttribute("data-gain")) {
      active.data.gain = parseFloat(range.value);
      J.$("b", range.closest(".knob-row")).textContent = `${active.data.gain.toFixed(1)} dB`;
      range.style.setProperty("--fill", `${((active.data.gain + 12) / 24) * 100}%`);
      pushToPlayer(); save(active);
    }
  });

  /* The panel follows the selection rather than holding one of its own.
   *
   * Pressing B in the player, or on the song, changes what is being shaped here. Redrawn
   * only when the preset behind the selection actually differs, because this fires on
   * every play, pause and seek and rebuilding the panel under a pointer throws the
   * canvas away mid drag. */
  J.on("player:change", function follow() {
    if (!panel.isConnected) { J.bus.removeEventListener("player:change", follow); return; }
    if (!presets.length) return;
    const theirs = presetOfSelection();
    if (theirs && active && theirs.id !== active.id) choose(theirs, { push: false });
    else syncChrome();
  });

  /* A preset came or went somewhere else on the page. Reload rather than patch: the list
   * is small and guessing which end of it moved is how a stale tab row happens. */
  J.on("sound:change", function refresh() {
    if (!panel.isConnected) { J.bus.removeEventListener("sound:change", refresh); return; }
    load();
  });

  await load();
};
