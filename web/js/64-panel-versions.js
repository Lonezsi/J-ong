/* Versions, and putting two of them side by side.
 *
 * Assigning A and B loads both into the player at once. After that, switching is
 * instant and keeps the playhead, which is the only way a mix comparison tells you
 * anything.
 */
"use strict";

J.blockVersions = async function (panel, ctx) {
  let versions = ctx.versions.slice();
  let currentId = ctx.song.current_version_id;

  async function reload() {
    const data = await J.get(`/api/songs/${ctx.songId}/versions`);
    versions = data.versions || [];
    currentId = data.current_version_id;
    draw();
  }

  function slotOf(versionId) {
    const slots = J.player.state.slots;
    if (slots.A && slots.A.id === versionId) return "A";
    if (slots.B && slots.B.id === versionId) return "B";
    return null;
  }

  function draw() {
    const playing = J.player.state.song && J.player.state.song.id === ctx.song.id;
    const slots = playing ? J.player.state.slots : { A: null, B: null };
    const active = J.player.state.active;

    panel.innerHTML = `
      <div>
        ${versions.length ? `
          <div class="ab-bar">
            ${["A", "B"].map((slot) => {
              const version = slots[slot];
              return `
                <button class="ab-slot ${playing && active === slot && version ? "on" : ""}"
                        data-act="switch" data-slot="${slot}" ${version ? "" : "disabled"}>
                  <div class="k">${slot}</div>
                  <div class="v">${version ? `v${version.n}` : "not set"}</div>
                  <div class="d">${version
                    ? `${J.when(version.created_at)}${version.duration ? " &middot; " + J.time(version.duration) : ""}`
                    : "choose a version below"}</div>
                </button>`;
            }).join('<div class="ab-mid"><button class="btn sm" data-act="swap">Swap</button><span class="ab-hint">or press X</span></div>')}
          </div>` : ""}

        <div class="block-head">
          <h2>Renders</h2>
          <span class="grow"></span>
          <span class="block-tools">
            <button class="btn ghost sm" data-act="upload">Upload a render</button>
          </span>
        </div>

        ${versions.length ? `
          <div class="stack">
            ${versions.map((v) => {
              const slot = slotOf(v.id);
              return `
              <div class="version-row ${v.id === currentId ? "current" : ""}" data-version="${v.id}">
                <span class="n">v${v.n}${slot ? ` <span class="tag accent">${slot}</span>` : ""}</span>
                <span class="truncate">
                  <span class="og-name truncate" title="${J.esc(v.filename || "")}">${
                    J.esc(v.filename || "no filename recorded")}</span>
                  ${v.id === currentId ? '<span class="tag" style="margin-left:6px">current</span>' : ""}
                  ${v.label ? `<span class="tag" style="margin-left:6px">${J.esc(v.label)}</span>` : ""}
                  <div class="faint" style="font-size:11.5px">${J.bytes(v.size)}${
                    v.bitrate ? " &middot; " + v.bitrate + " kbps" : ""}</div>
                </span>
                <span class="when">${J.when(v.created_at)}</span>
                <span class="dur">${v.duration ? J.time(v.duration) : ""}</span>
                <span class="acts">
                  <button class="icon-btn" data-act="play" title="Play this version" aria-label="Play v${v.n}">
                    <svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>
                  </button>
                  <button class="ab-chip" data-act="assign" data-slot="A" title="Put in slot A">A</button>
                  <button class="ab-chip" data-act="assign" data-slot="B" title="Put in slot B">B</button>
                  <button class="icon-btn" data-act="more" title="More" aria-label="More for v${v.n}">
                    <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>
                  </button>
                </span>
              </div>`;
            }).join("")}
          </div>`
          : `<div class="empty"><h3>No renders yet</h3>
               <p>Upload one, or let the folder watcher pick it up when you export.</p></div>`}
      </div>`;
  }

  panel.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const what = act.dataset.act;
    const row = act.closest("[data-version]");
    const version = row ? versions.find((v) => String(v.id) === row.dataset.version) : null;

    if (what === "upload") { J.$("#renderPick").click(); return; }
    if (what === "swap") { J.player.swap(); draw(); return; }
    if (what === "switch") { await J.player.switchTo(act.dataset.slot); draw(); return; }
    if (!version) return;

    if (what === "play") {
      await J.player.play(ctx.song, version);
      draw();
    }

    if (what === "assign") {
      const slot = act.dataset.slot;
      if (!J.player.state.song || J.player.state.song.id !== ctx.song.id) {
        await J.player.play(ctx.song, slot === "A" ? version : versions[0]);
      }
      if (slot === "A") await J.player.play(ctx.song, version);
      else await J.player.assign("B", version);
      draw();
      J.toast(`v${version.n} is ${slot}`);
    }

    if (what === "more") {
      const choice = await J.sheet({
        title: `v${version.n}`,
        sub: `${J.esc(version.filename || "")} &middot; ${J.bytes(version.size)}`.replace(/&middot;/, "·"),
        confirm: "", cancel: "Close",
        body: `<div class="stack" style="gap:var(--s2)">
          <button class="btn" data-pick="label">Set a label</button>
          ${version.id === currentId ? "" : '<button class="btn" data-pick="current">Make this the current version</button>'}
          <a class="btn" href="/api/versions/${version.id}/download" download>Download</a>
          <button class="btn danger" data-pick="delete">Delete this version</button>
        </div>`,
        onMount(sheetNode, close) {
          sheetNode.addEventListener("click", (event) => {
            const pick = event.target.closest("[data-pick]");
            if (pick) close(pick.dataset.pick);
          });
        },
      });

      if (choice === "label") {
        const values = await J.sheet({
          title: `Label for v${version.n}`, confirm: "Save",
          sub: "Something you will recognise in six months.",
          body: `<div class="sheet-fields"><label class="sheet-label">Label
            <input class="field" name="label" value="${J.esc(version.label)}"
                   placeholder="brighter top end"></label></div>`,
        });
        if (values) {
          await J.try(() => J.patch(`/api/versions/${version.id}`,
                                    { label: values.label.trim() }), "Saved");
          await reload();
        }
      }
      if (choice === "current") {
        await J.try(() => J.post(`/api/versions/${version.id}/current`), "Set as current");
        await reload();
      }
      if (choice === "delete") {
        const sure = await J.confirm(`Delete v${version.n}?`,
          "The audio file goes too, unless another version points at the same bytes.",
          "Delete it");
        if (!sure) return;
        await J.try(() => J.del(`/api/versions/${version.id}`), "Deleted");
        await reload();
        J.emit("versions:changed", { songId: ctx.songId });
      }
    }
  });

  /* Redraw while the player changes underneath, and let go once this panel is gone.
   * A listener on the bus outlives the DOM it was drawing, so it has to remove itself. */
  const onPlayerChange = () => {
    if (!panel.isConnected) {
      J.bus.removeEventListener("player:change", onPlayerChange);
      return;
    }
    draw();
  };
  J.on("player:change", onPlayerChange);
  draw();
};
