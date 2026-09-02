/* Lyrics, and the alternatives you move between sideways.
 *
 * Each alternative is a page. Left and right arrow keys move between them, and each one
 * carries its own history, so trying a different second verse never costs you the first.
 */
"use strict";

J.panelLyrics = async function (panel, ctx) {
  let sheets = [];
  let at = 0;
  let editing = false;
  let direction = 0;

  async function load(keepIndex) {
    const data = await J.get(`/api/songs/${ctx.songId}/lyrics`);
    sheets = data.lyrics || [];
    if (!keepIndex) {
      const currentIndex = sheets.findIndex((s) => s.is_current);
      at = currentIndex >= 0 ? currentIndex : 0;
    }
    at = J.clamp(at, 0, Math.max(0, sheets.length - 1));
    draw();
  }

  function draw() {
    if (!sheets.length) {
      panel.innerHTML = `
        <div class="panel empty">
          <h3>No lyrics yet</h3>
          <p>Start one, then add alternatives beside it when a line will not sit still.</p>
          <button class="btn primary" data-act="add" style="margin-top:var(--s4)">Write lyrics</button>
        </div>`;
      return;
    }

    const sheet = sheets[at];
    const prev = sheets[at - 1];
    const next = sheets[at + 1];
    const slide = direction > 0 ? "slide-left" : direction < 0 ? "slide-right" : "";

    panel.innerHTML = `
      <div class="panel">
        <div class="lyric-pager">
          <button class="btn ghost sm" data-act="prev" ${prev ? "" : "disabled"}>
            &larr; ${prev ? J.esc(prev.name) : ""}
          </button>
          <div class="center">
            <span class="lyric-name truncate">${J.esc(sheet.name)}</span>
            ${sheet.is_current ? '<span class="tag accent">Current</span>' : ""}
            <span class="lyric-dots">${sheets.map((s, i) =>
              `<i class="${i === at ? "on" : ""}"></i>`).join("")}</span>
          </div>
          <button class="btn ghost sm" data-act="next" ${next ? "" : "disabled"}>
            ${next ? J.esc(next.name) : ""} &rarr;
          </button>
        </div>

        <div class="lyric-stage">
          ${editing
            ? `<div class="lyric-edit">
                 <textarea class="field" id="lyricText" spellcheck="true"
                   placeholder="Type the words.">${J.esc(sheet.text)}</textarea>
                 <div class="row" style="margin-top:var(--s3)">
                   <button class="btn primary sm" data-act="save">Save</button>
                   <button class="btn ghost sm" data-act="cancel">Cancel</button>
                   <span class="grow"></span>
                   <span class="faint" id="lyricCount"></span>
                 </div>
               </div>`
            : `<div class="lyric-body ${slide}">${sheet.text
                 ? J.esc(sheet.text)
                 : '<span class="lyric-empty">Nothing written here yet.</span>'}</div>`}
        </div>

        ${editing ? "" : `
          <div class="row wrap" style="margin-top:var(--s6)">
            <button class="btn sm" data-act="edit">Edit</button>
            <button class="btn ghost sm" data-act="history">History (${sheet.revisions})</button>
            ${sheet.is_current ? "" : '<button class="btn ghost sm" data-act="make-current">Make current</button>'}
            <button class="btn ghost sm" data-act="rename">Rename</button>
            <button class="btn ghost sm" data-act="add">Add alternative</button>
            <span class="grow"></span>
            ${sheets.length > 1 ? '<button class="btn ghost sm danger" data-act="delete">Delete</button>' : ""}
          </div>`}
      </div>`;

    direction = 0;
    if (editing) {
      const box = J.$("#lyricText", panel);
      const count = J.$("#lyricCount", panel);
      const update = () => {
        const lines = box.value ? box.value.split("\n").length : 0;
        count.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
      };
      box.addEventListener("input", update);
      update();
      box.focus();
    }
  }

  function move(delta) {
    const to = at + delta;
    if (to < 0 || to >= sheets.length) return;
    direction = delta;
    at = to;
    draw();
  }

  async function save() {
    const box = J.$("#lyricText", panel);
    if (!box) return;
    const result = await J.try(() => J.put(`/api/lyrics/${sheets[at].id}/text`, { text: box.value }));
    if (!result) return;
    J.toast(result.saved ? "Saved" : result.message);
    editing = false;
    await load(true);
  }

  panel.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const what = act.dataset.act;
    const sheet = sheets[at];

    if (what === "prev") move(-1);
    if (what === "next") move(1);
    if (what === "edit") { editing = true; draw(); }
    if (what === "cancel") { editing = false; draw(); }
    if (what === "save") await save();

    if (what === "add") {
      const values = await J.sheet({
        title: "New alternative", confirm: "Create",
        sub: "It starts empty and keeps its own history.",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" placeholder="${sheets.length ? "Alternative " + (sheets.length + 1) : "Current"}"></label></div>`,
      });
      if (!values) return;
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/lyrics`,
                                            { name: values.name.trim() }), "Added");
      if (!made) return;
      await load();
      at = sheets.findIndex((s) => s.id === made.sheet.id);
      editing = true;
      draw();
    }

    if (what === "rename") {
      const values = await J.sheet({
        title: "Rename alternative", confirm: "Save",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" value="${J.esc(sheet.name)}"></label></div>`,
      });
      if (!values || !values.name.trim()) return;
      await J.try(() => J.patch(`/api/lyrics/${sheet.id}`, { name: values.name.trim() }), "Renamed");
      await load(true);
    }

    if (what === "make-current") {
      await J.try(() => J.post(`/api/lyrics/${sheet.id}/current`), "Set as current");
      await load(true);
    }

    if (what === "delete") {
      const sure = await J.confirm(`Delete “${sheet.name}”?`,
        "Its history goes too.", "Delete it");
      if (!sure) return;
      await J.try(() => J.del(`/api/lyrics/${sheet.id}`), "Deleted");
      at = Math.max(0, at - 1);
      await load(true);
    }

    if (what === "history") {
      const data = await J.get(`/api/lyrics/${sheet.id}/history`);
      const revisions = data.revisions || [];
      await J.sheet({
        title: `History of “${sheet.name}”`,
        sub: revisions.length ? "Choosing one brings it back as a new revision, so nothing is lost."
                              : "Nothing has been saved here yet.",
        confirm: "", cancel: "Close", wide: true,
        body: `<div class="history-list">${revisions.map((r, i) => `
          <div class="history-item" data-rev="${r.id}">
            <span class="when">${J.date(r.created_at)}</span>
            <span class="grow"></span>
            <span class="size">${r.length} characters</span>
            ${i === 0 ? '<span class="tag accent">Now</span>' : '<span class="tag">Restore</span>'}
          </div>`).join("") || '<p class="faint">No revisions.</p>'}</div>`,
        onMount(sheetNode, close) {
          sheetNode.addEventListener("click", async (event) => {
            const item = event.target.closest("[data-rev]");
            if (!item) return;
            close(null);
            const result = await J.try(() => J.post(`/api/lyrics/${sheet.id}/restore`,
                                                    { revision_id: Number(item.dataset.rev) }));
            if (result) J.toast(result.saved ? "Restored" : result.message);
            await load(true);
          });
        },
      });
    }
  });

  /* Arrow keys page between alternatives, which is the interaction the whole panel is
   * arranged around. Ignored while typing, or the editor would jump about. */
  const onKey = (e) => {
    if (!panel.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (editing || e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
  };
  document.addEventListener("keydown", onKey);

  await load();
};
