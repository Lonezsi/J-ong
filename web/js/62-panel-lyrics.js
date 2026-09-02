/* The words.
 *
 * Click them and they become editable. Nothing asks you to name anything: a second set
 * of words is v2, and while there is only one set no name is shown at all, because there
 * is nothing to tell it apart from.
 *
 * History is for looking. Choosing an entry shows you that text and says so; it does not
 * touch what is saved. Restoring is a separate, deliberate press, and it only writes when
 * the words actually differ from what is already current.
 */
"use strict";

J.blockLyrics = async function (block, ctx) {
  let sheets = [];
  let at = 0;
  let editing = false;
  let history = null;      // the list, when it is open
  let viewing = null;      // { revision, text } while looking at an older version

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

  const sheet = () => sheets[at];

  function draw() {
    const one = sheets.length <= 1;
    const s = sheet();

    block.innerHTML = `
      <div class="block-head">
        <h2>Lyrics</h2>
        ${one ? "" : `
          <span class="sheet-tabs">
            ${sheets.map((sh, i) =>
              `<button class="sheet-tab ${i === at ? "on" : ""}" data-sheet="${i}">${J.esc(sh.name)}</button>`).join("")}
          </span>`}
        <span class="grow"></span>
        <span class="block-tools">
          ${s ? `<button class="btn ghost sm" data-act="history">History${
            s.revisions > 1 ? ` (${s.revisions})` : ""}</button>` : ""}
          ${s ? '<button class="btn ghost sm" data-act="rename">Rename</button>' : ""}
          <button class="btn ghost sm" data-act="add">${one && !s ? "Write lyrics" : "Add a version"}</button>
          ${sheets.length > 1 ? '<button class="btn ghost sm danger" data-act="drop">Delete</button>' : ""}
        </span>
      </div>

      ${viewing ? `
        <div class="time-bar">
          <span>Looking at the words from <b>${J.date(viewing.created_at)}</b>. Nothing has changed.</span>
          <span class="grow"></span>
          <button class="btn sm" data-act="restore">Restore these words</button>
          <button class="btn ghost sm" data-act="back">Back to now</button>
        </div>` : ""}

      <div id="lyricStage"></div>

      ${history ? `
        <div class="history-rail" style="margin-top:var(--s4)">
          ${history.map((r, i) => `
            <div class="history-entry ${viewing && viewing.id === r.id ? "on" : (!viewing && i === 0 ? "on" : "")}"
                 data-rev="${r.id}">
              <span class="when">${J.date(r.created_at)}</span>
              <span class="grow"></span>
              <span class="size">${r.length} characters</span>
              ${i === 0 ? '<span class="size">now</span>' : ""}
            </div>`).join("")}
        </div>` : ""}`;

    drawStage();
  }

  function drawStage() {
    const stage = J.$("#lyricStage", block);
    const s = sheet();
    if (!s) {
      stage.innerHTML = `<div class="lyrics empty-words" data-act="add">
        Nothing written yet. Click here to start.</div>`;
      return;
    }
    if (editing) {
      stage.innerHTML = `
        <textarea class="lyrics-edit" id="lyricText" spellcheck="true"
          placeholder="Type the words.">${J.esc(s.text)}</textarea>
        <div class="row" style="margin-top:var(--s3)">
          <button class="btn primary sm" data-act="save">Save</button>
          <button class="btn ghost sm" data-act="cancel">Cancel</button>
          <span class="grow"></span>
          <span class="faint" id="lyricCount"></span>
        </div>`;
      const box = J.$("#lyricText", block);
      const count = J.$("#lyricCount", block);
      const tally = () => {
        const lines = box.value ? box.value.split("\n").length : 0;
        count.textContent = `${lines} line${lines === 1 ? "" : "s"}`;
      };
      box.addEventListener("input", tally);
      box.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
        if (e.key === "Escape") { e.preventDefault(); editing = false; draw(); }
      });
      tally();
      box.focus();
      return;
    }

    const text = viewing ? viewing.text : s.text;
    stage.innerHTML = `<div class="lyrics ${viewing ? "reading" : ""} ${text ? "" : "empty-words"}"
      ${viewing ? "" : 'data-act="edit" title="Click to edit"'}>${
        text ? J.esc(text) : "Nothing written yet. Click here to start."}</div>`;
  }

  async function save() {
    const box = J.$("#lyricText", block);
    if (!box) return;
    const result = await J.try(() => J.put(`/api/lyrics/${sheet().id}/text`, { text: box.value }));
    if (!result) return;
    if (result.saved) J.toast("Saved");
    editing = false;
    history = null;
    await load(true);
  }

  block.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-sheet]");
    if (tab) {
      at = Number(tab.dataset.sheet);
      viewing = null; history = null; editing = false;
      draw();
      return;
    }

    const entry = e.target.closest("[data-rev]");
    if (entry) {
      // Looking, not restoring. This was the whole complaint: a glance rewrote the file.
      const id = Number(entry.dataset.rev);
      const newest = history && history[0] && history[0].id === id;
      if (newest) { viewing = null; draw(); return; }
      const data = await J.try(() => J.get(`/api/lyric-revisions/${id}`));
      if (!data) return;
      viewing = data.revision;
      draw();
      return;
    }

    const act = e.target.closest("[data-act]");
    if (!act) return;
    const what = act.dataset.act;
    const s = sheet();

    if (what === "edit") { viewing = null; editing = true; drawStage(); }
    if (what === "cancel") { editing = false; draw(); }
    if (what === "save") await save();
    if (what === "back") { viewing = null; draw(); }

    if (what === "history") {
      if (history) { history = null; viewing = null; draw(); return; }
      const data = await J.try(() => J.get(`/api/lyrics/${s.id}/history`));
      if (!data) return;
      history = data.revisions || [];
      draw();
    }

    if (what === "restore") {
      const result = await J.try(() => J.post(`/api/lyrics/${s.id}/restore`,
                                              { revision_id: viewing.id }));
      if (!result) return;
      J.toast(result.saved ? "Restored" : result.message);
      viewing = null; history = null;
      await load(true);
    }

    if (what === "add") {
      // No name asked for. It is v2 until it earns something better.
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/lyrics`, {}));
      if (!made) return;
      await load();
      at = sheets.findIndex((sh) => sh.id === made.sheet.id);
      if (at < 0) at = sheets.length - 1;
      viewing = null; history = null; editing = true;
      draw();
    }

    if (what === "rename") {
      const values = await J.sheet({
        title: "Name these words", confirm: "Save",
        sub: "Something you will recognise. Leave it and it stays a number.",
        body: `<div class="sheet-fields"><label class="sheet-label">Name
          <input class="field" name="name" value="${J.esc(s.name)}"
                 placeholder="second verse, other way"></label></div>`,
      });
      if (!values || !values.name.trim()) return;
      await J.try(() => J.patch(`/api/lyrics/${s.id}`, { name: values.name.trim() }), "Named");
      await load(true);
    }

    if (what === "drop") {
      const sure = await J.confirm(`Delete “${s.name}”?`, "Its history goes too.", "Delete it");
      if (!sure) return;
      await J.try(() => J.del(`/api/lyrics/${s.id}`), "Deleted");
      at = Math.max(0, at - 1);
      history = null; viewing = null;
      await load(true);
    }
  });

  /* Arrows page between sets of words when there is more than one. */
  const onKey = (e) => {
    if (!block.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (editing || sheets.length < 2) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft" && at > 0) { at--; viewing = null; draw(); }
    if (e.key === "ArrowRight" && at < sheets.length - 1) { at++; viewing = null; draw(); }
  };
  document.addEventListener("keydown", onKey);

  await load();
};
