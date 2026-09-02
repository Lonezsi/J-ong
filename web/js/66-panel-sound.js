/* Sound: the curve, the limiter, and the presets you compare them with.
 *
 * Nothing here is written into the render. The settings are applied while the browser
 * plays, and the stored file is never touched.
 *
 * The panel is built once and then updated in place. An earlier version redrew the whole
 * thing whenever a band was added, which replaced the canvas underneath the pointer: you
 * could add a node by double clicking but never add one and drag it in the same motion,
 * because the element the drag belonged to had already been thrown away.
 */
"use strict";

J.panelSound = async function (panel, ctx) {
  let presets = [];
  let active = null;
  let editor = null;
  let meterTimer = null;

  const save = J.debounce(async (preset) => {
    await J.try(() => J.put(`/api/sound/${preset.id}`, { data: preset.data }));
  }, 600);

  /* Edits only reach the speakers when this is the song currently playing. Shaping one
   * song's curve while another sounds must not change what you are hearing. */
  const isLive = () => J.player.state.song && J.player.state.song.id === ctx.song.id;
  const pushToPlayer = () => { if (isLive()) J.player.applySound(active.data); };

  async function load() {
    const data = await J.get(`/api/songs/${ctx.songId}/sound`);
    presets = data.presets || [];
    active = presets.find((p) => p.is_current) || presets[0];
    draw();
  }

  const LIMITER_FIELDS = [
    ["threshold", "Threshold", -60, 0, 0.5, "dB"],
    ["ceiling", "Ceiling", -30, 0, 0.1, "dB"],
    ["attack", "Attack", 0, 100, 1, "ms"],
    ["release", "Release", 1, 1000, 1, "ms"],
  ];

  /* Full build. Only on load and when the chosen preset changes, so the canvas survives
   * everything else. */
  function draw() {
    const lim = active.data.limiter || {};
    panel.innerHTML = `
      <div class="panel">
        <div class="pills" id="presetPills" style="margin-bottom:var(--s4)"></div>

        <div class="eq-wrap">
          <canvas class="eq-canvas" id="eqCanvas"></canvas>
          <div class="eq-readout" id="eqReadout"></div>
          <div class="eq-hint">double click to add &middot; drag to move &middot; wheel for Q</div>
        </div>

        <div class="eq-toolbar">
          <button class="btn sm" data-act="add" data-type="peaking">Add bell</button>
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

        <div class="band-list" id="bandList"></div>

        <div class="section" style="margin-top:var(--s6)">
          <div class="section-head">
            <h3>Limiter</h3>
            <button class="switch ${lim.on ? "on" : ""}" id="limiterSwitch"
                    data-act="limiter-toggle" aria-label="Limiter on"></button>
            <span class="grow"></span>
            <span class="faint" id="grLabel">0.0 dB</span>
          </div>
          <div class="gr-meter"><i id="grBar"></i></div>
          <div class="limiter-grid">
            ${LIMITER_FIELDS.map(([key, label, min, max, step, unit]) => `
              <div class="knob-row">
                <div class="lab"><span>${label}</span><b>${Number(lim[key]).toFixed(unit === "dB" ? 1 : 0)} ${unit}</b></div>
                <input class="range" type="range" data-lim="${key}" min="${min}" max="${max}"
                       step="${step}" value="${lim[key]}"
                       style="--fill:${((lim[key] - min) / (max - min)) * 100}%">
              </div>`).join("")}
            <div class="knob-row">
              <div class="lab"><span>Output</span><b>${(active.data.gain || 0).toFixed(1)} dB</b></div>
              <input class="range" type="range" data-gain min="-12" max="12" step="0.1"
                     value="${active.data.gain || 0}"
                     style="--fill:${(((active.data.gain || 0) + 12) / 24) * 100}%">
            </div>
          </div>
        </div>

        <div class="row wrap" style="margin-top:var(--s5)" id="presetActions"></div>

        <p class="sound-note" id="soundNote"></p>
      </div>`;

    mountEditor();
    renderPresets();
    renderBands();
    syncChrome();
  }

  function renderPresets() {
    J.$("#presetPills", panel).innerHTML =
      presets.map((p) => `
        <button class="pill ${p.id === active.id ? "on" : ""}" data-preset="${p.id}">
          ${J.esc(p.name)}${p.is_current ? " &middot;" : ""}
        </button>`).join("") +
      '<button class="pill quiet" data-act="new-preset">+ Preset</button>';

    J.$("#presetActions", panel).innerHTML = `
      ${active.is_current ? "" : '<button class="btn sm" data-act="make-current">Use this preset by default</button>'}
      <button class="btn ghost sm" data-act="rename-preset">Rename</button>
      <button class="btn ghost sm" data-act="reset">Flatten</button>
      <span class="grow"></span>
      ${presets.length > 1 ? '<button class="btn ghost sm danger" data-act="delete-preset">Delete preset</button>' : ""}`;
  }

  /* Only this region is replaced when bands change. The canvas is untouched. */
  function renderBands() {
    const list = J.$("#bandList", panel);
    if (!list) return;
    const bands = active.data.bands || [];
    if (!bands.length) {
      list.innerHTML = `<p class="faint" style="margin:var(--s2) 0">
        No bands yet. Double click the display where you want one, or use the buttons above.</p>`;
      refreshReadout();
      return;
    }
    list.innerHTML = bands.map((band) => `
      <div class="band-card ${band.on ? "" : "off"} ${editor && editor.selected === band.id ? "on" : ""}"
           data-band="${band.id}">
        <div class="head">
          <span class="kind">${J.eq.TYPE_LABEL[band.type] || band.type}</span>
          <button class="switch ${band.on ? "on" : ""}" data-act="band-toggle"
                  style="width:30px;height:17px" aria-label="Band on"></button>
        </div>
        <div class="freq">${J.eq.fmtHz(band.freq)} <span class="faint" style="font-size:11px">Hz</span></div>
        <div class="nums">
          <span>${J.eq.FLAT.has(band.type) ? "&mdash;" : (band.gain > 0 ? "+" : "") + band.gain.toFixed(1) + " dB"}</span>
          <span>Q ${band.q.toFixed(2)}</span>
        </div>
        <select data-act="band-type" aria-label="Filter type">
          ${Object.keys(J.eq.TYPE_LABEL).map((type) =>
            `<option value="${type}" ${type === band.type ? "selected" : ""}>${J.eq.TYPE_LABEL[type]}</option>`).join("")}
        </select>
        <button class="btn ghost sm danger" data-act="band-remove"
                style="width:100%;margin-top:6px;height:26px">Remove</button>
      </div>`).join("");
    refreshReadout();
  }

  /* Numbers only, while a node is being dragged. No nodes are added or removed here, so
   * the cards stay put and the pointer keeps its target. */
  const updateBandNumbers = J.debounce(() => {
    if (!panel.isConnected) return;
    for (const band of active.data.bands || []) {
      const card = J.$(`[data-band="${band.id}"]`, panel);
      if (!card) { renderBands(); return; }
      J.$(".freq", card).innerHTML =
        `${J.eq.fmtHz(band.freq)} <span class="faint" style="font-size:11px">Hz</span>`;
      const nums = J.$$(".nums span", card);
      nums[0].innerHTML = J.eq.FLAT.has(band.type)
        ? "&mdash;" : `${band.gain > 0 ? "+" : ""}${band.gain.toFixed(1)} dB`;
      nums[1].textContent = `Q ${band.q.toFixed(2)}`;
      card.classList.toggle("on", editor && editor.selected === band.id);
      card.classList.toggle("off", !band.on);
    }
  }, 40);

  function syncChrome() {
    const pill = J.$("#bypassPill", panel);
    if (pill) {
      pill.textContent = active.data.bypass ? "Bypassed" : "Bypass";
      pill.classList.toggle("on", !!active.data.bypass);
      pill.classList.toggle("quiet", !active.data.bypass);
    }
    const note = J.$("#soundNote", panel);
    if (note) {
      note.textContent = "Playback only. Your uploaded render is never modified."
        + (isLive() ? "" : " Play this song to hear these settings.");
    }
    const limiterSwitch = J.$("#limiterSwitch", panel);
    if (limiterSwitch) limiterSwitch.classList.toggle("on", !!(active.data.limiter || {}).on);
  }

  function mountEditor() {
    const canvas = J.$("#eqCanvas", panel);
    if (!canvas) return;
    if (editor) editor.stop();
    editor = J.eq.create(canvas, {
      data: active.data,
      onChange: (data) => {
        active.data = data;
        pushToPlayer();
        save(active);
        // The band count only changes on add and remove, and those are the only times
        // the cards need rebuilding.
        const cards = J.$$("#bandList .band-card", panel).length;
        if (cards !== (data.bands || []).length) renderBands();
        else updateBandNumbers();
      },
      onSelect: () => { refreshReadout(); updateBandNumbers(); },
      onFrame: refreshReadout,
    });
    const chosen = J.$("[data-range].on", panel);
    editor.setRange(chosen ? Number(chosen.dataset.range) : 18);
    editor.start();
    startMeter();
  }

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

  function startMeter() {
    clearInterval(meterTimer);
    meterTimer = setInterval(() => {
      if (!panel.isConnected) { clearInterval(meterTimer); return; }
      const bar = J.$("#grBar", panel);
      const label = J.$("#grLabel", panel);
      if (!bar) return;
      const reduction = isLive() ? J.audio.reduction : 0;
      bar.style.width = `${J.clamp((reduction / 12) * 100, 0, 100)}%`;
      label.textContent = `${reduction.toFixed(1)} dB`;
    }, 90);
  }

  panel.addEventListener("click", async (e) => {
    const presetPill = e.target.closest("[data-preset]");
    if (presetPill) {
      active = presets.find((p) => String(p.id) === presetPill.dataset.preset);
      if (isLive()) J.player.usePreset(active);
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
      active.data = { bands: [], limiter: Object.assign({}, active.data.limiter, { on: false }),
                      gain: 0, bypass: false };
      pushToPlayer(); save.now(active); draw();
    }
    if (what === "make-current") {
      await J.try(() => J.post(`/api/sound/${active.id}/current`), "Set as default");
      await load();
    }
    if (what === "new-preset") {
      const values = await J.sheet({
        title: "New preset", confirm: "Create",
        sub: "It starts as a copy of the one you are on, so you can change one thing and compare.",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" placeholder="Car"></label></div>`,
      });
      if (!values || !values.name.trim()) return;
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/sound`, {
        name: values.name.trim(), copy_from: active.id }), "Preset added");
      if (!made) return;
      await load();
      const fresh = presets.find((p) => p.id === made.preset.id);
      if (fresh) { active = fresh; draw(); }
    }
    if (what === "rename-preset") {
      const values = await J.sheet({
        title: "Rename preset", confirm: "Save",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" value="${J.esc(active.name)}"></label></div>`,
      });
      if (!values || !values.name.trim()) return;
      await J.try(() => J.patch(`/api/sound/${active.id}`, { name: values.name.trim() }), "Renamed");
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
    const card = select.closest("[data-band]");
    editor.update(card.dataset.band, { type: select.value });
    renderBands();
  });

  panel.addEventListener("input", (e) => {
    const range = e.target;
    if (range.dataset.lim) {
      active.data.limiter[range.dataset.lim] = parseFloat(range.value);
      const unit = range.dataset.lim === "threshold" || range.dataset.lim === "ceiling" ? "dB" : "ms";
      J.$("b", range.closest(".knob-row")).textContent =
        `${parseFloat(range.value).toFixed(unit === "dB" ? 1 : 0)} ${unit}`;
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

  await load();
};
