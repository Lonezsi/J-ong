/* The expanded player: one job, comparing two versions.
 *
 * It raises over the content and keeps the rail, so you do not lose your place. Every
 * version of the song is one click from either slot.
 */
"use strict";

J.stage = (function () {
  let node = null;

  async function open() {
    if (node) return close();
    const state = J.player.state;
    if (!state.song) return;
    const data = await J.try(() => J.get(`/api/songs/${state.song.id}/versions`));
    const versions = (data && data.versions) || [];

    node = document.createElement("div");
    node.className = "stage";
    document.body.appendChild(node);
    draw(versions);

    node.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      if (act.dataset.act === "close") return close();
      if (act.dataset.act === "swap") { J.player.swap(); draw(versions); return; }
      if (act.dataset.act === "switch") {
        await J.player.switchTo(act.dataset.slot);
        draw(versions);
        return;
      }
      if (act.dataset.act === "assign") {
        const version = versions.find((v) => String(v.id) === act.dataset.version);
        const slot = act.dataset.slot;
        if (slot === "A") await J.player.play(state.song, version);
        else await J.player.assign("B", version);
        draw(versions);
      }
    });

    document.addEventListener("keydown", onKey);
    J.on("player:change", onPlayerChange);
  }

  function onPlayerChange() { if (node) draw(null); }

  let lastVersions = [];
  function draw(versions) {
    if (!node) return;
    if (versions) lastVersions = versions;
    const list = lastVersions;
    const state = J.player.state;
    const song = state.song;
    if (!song) return close();
    const art = song.artwork_id ? `/api/artwork/${song.artwork_id}/image` : null;

    node.innerHTML = `
      <div class="stage-head">
        <span class="eyebrow">Comparing versions</span>
        <span class="grow"></span>
        <button class="icon-btn" data-act="close" aria-label="Close">
          <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="stage-body">
        <div class="stage-grid">
          ${J.cover({ url: art, title: song.title })}
          <div>
            <h1 style="margin-bottom:var(--s2)">${J.esc(song.title)}</h1>
            <p class="muted" style="margin:0 0 var(--s5)">
              Switching keeps the playhead exactly where it is, so you hear the same bar
              of both mixes with no gap.
            </p>

            <div class="ab-bar">
              ${["A", "B"].map((slot) => {
                const version = state.slots[slot];
                return `
                  <button class="ab-slot ${state.active === slot && version ? "on" : ""}"
                          data-act="switch" data-slot="${slot}" ${version ? "" : "disabled"}>
                    <div class="k">${slot}</div>
                    <div class="v">${version ? `v${version.n}` : "not set"}</div>
                    <div class="d">${version ? (version.label ? J.esc(version.label) + " &middot; " : "") +
                      J.when(version.created_at) : "choose a version below"}</div>
                  </button>`;
              }).join('<div class="ab-mid"><button class="btn" data-act="swap">Swap</button><span class="ab-hint">or press X</span></div>')}
            </div>

            <div class="section" style="margin-top:var(--s6)">
              <div class="section-head"><h3>Every render</h3></div>
              <div class="stack">
                ${list.map((v) => {
                  const inA = state.slots.A && state.slots.A.id === v.id;
                  const inB = state.slots.B && state.slots.B.id === v.id;
                  return `
                  <div class="version-row" style="grid-template-columns:64px 1fr 96px auto">
                    <span class="n">v${v.n}</span>
                    <span class="truncate">${v.label ? J.esc(v.label) : '<span class="faint">no label</span>'}</span>
                    <span class="when">${J.when(v.created_at)}</span>
                    <span class="row" style="gap:4px">
                      <button class="ab-chip ${inA ? "on" : ""}" data-act="assign" data-slot="A" data-version="${v.id}">A</button>
                      <button class="ab-chip ${inB ? "on" : ""}" data-act="assign" data-slot="B" data-version="${v.id}">B</button>
                    </span>
                  </div>`;
                }).join("") || '<p class="faint">No renders yet.</p>'}
              </div>
            </div>
          </div>
        </div>
      </div>`;
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  function close() {
    if (!node) return;
    node.remove();
    node = null;
    document.removeEventListener("keydown", onKey);
    J.bus.removeEventListener("player:change", onPlayerChange);
  }

  return { open, close, get isOpen() { return !!node; } };
})();
