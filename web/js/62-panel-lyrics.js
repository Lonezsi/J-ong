/* The words, as cards you move between.
 *
 * Markdown, and the first line is the name. That is the whole naming scheme, so there is
 * no Rename button: change the heading and the card is called something else. Nothing
 * asks you to name a thing before writing it.
 *
 * The cards sit in the middle of the page and slide. Drag one and it follows your hand,
 * let go past a third of the way and it goes to the next. Arrows do the same thing for a
 * mouse, and the keyboard arrows for neither.
 *
 * History is for looking. Choosing an entry shows those words and says nothing has
 * changed; restoring is a separate press.
 */
"use strict";

J.blockLyrics = async function (block, ctx) {
  let sheets = [];
  let at = 0;
  let editing = false;
  let history = null;
  let viewing = null;

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
    const s = sheet();
    const many = sheets.length > 1;

    block.innerHTML = `
      <div class="block-head">
        <h2>Lyrics</h2>
        <span class="grow"></span>
        <span class="block-tools">
          ${s ? `<button class="btn ghost sm" data-act="history">History${
            s.revisions > 1 ? ` (${s.revisions})` : ""}</button>` : ""}
          <button class="btn ghost sm" data-act="add">${s ? "Add a version" : "Write lyrics"}</button>
        </span>
      </div>

      ${viewing ? `
        <div class="time-bar">
          <span>Looking at the words from <b>${J.date(viewing.created_at)}</b>. Nothing has changed.</span>
          <span class="grow"></span>
          <button class="btn sm" data-act="restore">Restore these</button>
          <button class="btn ghost sm" data-act="back">Back to now</button>
        </div>` : ""}

      <div class="lyric-deck">
        ${many ? `<button class="deck-arrow" data-act="prev" aria-label="Previous"
                    ${at === 0 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        </button>` : ""}

        <div class="deck-window" id="deckWindow">
          <div class="deck-track" id="deckTrack"></div>
        </div>

        ${many ? `<button class="deck-arrow" data-act="next" aria-label="Next"
                    ${at >= sheets.length - 1 ? "disabled" : ""}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
        </button>` : ""}
      </div>

      ${many ? `<div class="deck-dots">${sheets.map((sh, i) =>
        `<button class="deck-dot ${i === at ? "on" : ""}" data-go="${i}"
                 title="${J.esc(sh.name)}" aria-label="${J.esc(sh.name)}"></button>`).join("")}</div>` : ""}

      ${history ? `
        <div class="history-rail">
          ${history.map((r, i) => `
            <div class="history-entry ${viewing ? (viewing.id === r.id ? "on" : "") : (i === 0 ? "on" : "")}"
                 data-rev="${r.id}">
              <span class="when">${J.date(r.created_at)}</span>
              <span class="grow"></span>
              <span class="size">${r.length} characters</span>
              ${i === 0 ? '<span class="size">now</span>' : ""}
            </div>`).join("")}
        </div>` : ""}`;

    drawCards();
  }

  function drawCards() {
    const track = J.$("#deckTrack", block);
    if (!track) return;

    if (!sheets.length) {
      track.style.transform = "translate3d(0,0,0)";
      track.innerHTML = `<article class="lyric-card on"><div class="card-body empty-words"
        data-act="edit">Click here and write. The first line becomes the title, and a
        song can hold several sets of words at once so a rewrite never overwrites the
        one you had.</div></article>`;
      return;
    }

    if (editing) {
      const s = sheet();
      track.style.transform = "translate3d(0,0,0)";
      track.innerHTML = `<article class="lyric-card editing">
        <textarea class="card-edit" id="lyricText" spellcheck="true"
          placeholder="# Name it on the first line&#10;&#10;Then the words.">${J.esc(s.text)}</textarea>
        <div class="card-foot">
          <button class="btn primary sm" data-act="save">Save</button>
          <button class="btn ghost sm" data-act="cancel">Cancel</button>
          <span class="grow"></span>
          <span class="faint" id="lyricCount"></span>
        </div>
      </article>`;
      const box = J.$("#lyricText", block);
      const count = J.$("#lyricCount", block);
      const tally = () => {
        const lines = box.value ? box.value.split("\n").length : 0;
        count.textContent = `Markdown &middot; ${lines} line${lines === 1 ? "" : "s"}`
          .replace("&middot;", "·");
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

    track.innerHTML = sheets.map((s, i) => {
      const text = (viewing && i === at) ? viewing.text : s.text;
      const title = J.mdTitle(text, s.name);
      const body = J.mdBody(text);
      return `<article class="lyric-card ${i === at ? "on" : ""} ${viewing && i === at ? "reading" : ""}"
               data-sheet="${s.id}">
        <h3 class="card-title">${J.esc(title)}</h3>
        <div class="card-body ${text ? "" : "empty-words"}"
             ${viewing ? "" : 'data-act="edit" title="Click to edit"'}>${
          text ? J.md(body) : "Nothing written yet. Click here to start."}</div>
        <span class="card-foot-tools">
          ${partChip(s)}
          ${sheets.length > 1 ? `
            <button class="icon-btn card-drop" data-act="drop"
                    title="Delete these words" aria-label="Delete ${J.esc(title)}">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round">
                <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>
              </svg>
            </button>` : ""}
        </span>
      </article>`;
    }).join("");
    place(false);
  }

  /* Which section of the arrangement these words belong to.
   *
   * Only offered when the compositor has actually laid the song out. Before that there
   * are no sections to point at, and a control that can only say "none" is noise. */
  function partChip(sheet) {
    if (!J.arrange || !J.arrange.state.parts.length) return "";
    const part = J.arrange.partForSheet(sheet.id);
    return `<button class="card-part ${part ? "set" : ""}" data-part-for="${sheet.id}"
              style="--hue:${part ? part.hue : 140}"
              title="Which section of the arrangement these words are for">
              <span class="dot"></span>${part ? J.esc(part.name) : "no section"}
            </button>`;
  }

  /* Light up the card whose section is sounding. Driven by the compositor's playhead
   * rather than by a timer here, so the two can never disagree. */
  function sounding(partId) {
    const sheetId = partId ? J.arrange.state.lyrics[partId] : null;
    J.$$(".lyric-card", block).forEach((card) => {
      card.classList.toggle("sounding", !!sheetId && card.dataset.sheet === String(sheetId));
    });
  }

  /* Where the track sits. One card per step, so the maths is the index. */
  function place(animate) {
    const track = J.$("#deckTrack", block);
    if (!track) return;
    track.style.transition = animate ? "transform 320ms cubic-bezier(0.22,0.7,0.3,1)" : "none";
    track.style.transform = `translate3d(${-at * 100}%, 0, 0)`;
  }

  function go(index, animate) {
    const to = J.clamp(index, 0, sheets.length - 1);
    if (to === at) { place(true); return; }
    at = to;
    viewing = null;
    place(animate !== false);
    // The chrome around the deck changes with the card, but only after it has landed,
    // so the redraw never interrupts the slide.
    setTimeout(() => { if (block.isConnected) draw(); }, 320);
  }

  /* Dragging. The track follows the pointer and settles either back or onward.
   *
   * Bound to the block, not to the window inside it. draw() rewrites block.innerHTML, so
   * #deckWindow is a different element after every redraw and anything held on the old
   * one goes in the bin with it. Changing card schedules exactly that redraw, which is
   * why swiping used to work once and then never again: the arrows, the dots and the
   * keyboard kept working because they are delegated here, and only the drag was not. */
  function wireDrag() {
    let startX = 0, startY = 0, dragging = false, decided = false, width = 1;
    let win = null, track = null;

    block.addEventListener("pointerdown", (e) => {
      if (editing || sheets.length < 2) return;
      if (e.target.closest("a, button, textarea")) return;
      // Resolved per gesture, because the element that was there last time is gone.
      win = e.target.closest("#deckWindow");
      track = win && J.$("#deckTrack", block);
      if (!win || !track) { win = track = null; return; }
      dragging = true; decided = false;
      startX = e.clientX; startY = e.clientY;
      width = win.getBoundingClientRect().width || 1;
      track.style.transition = "none";
    });

    block.addEventListener("pointermove", (e) => {
      if (!dragging || !track) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!decided) {
        // Let a vertical drag scroll the page instead of swiping the card.
        if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { dragging = false; return; }
        if (Math.abs(dx) < 6) return;
        decided = true;
        try { win.setPointerCapture(e.pointerId); } catch (err) { /* gone already */ }
      }
      // Resist at the ends, so the deck feels like it has edges.
      const edge = (at === 0 && dx > 0) || (at === sheets.length - 1 && dx < 0);
      const shift = edge ? dx * 0.32 : dx;
      track.style.transform = `translate3d(calc(${-at * 100}% + ${shift}px), 0, 0)`;
    });

    const release = (e) => {
      if (!dragging) return;
      dragging = false;
      const held = win;
      win = track = null;
      if (!decided) return;
      try { held.releasePointerCapture(e.pointerId); } catch (err) { /* already */ }
      const dx = e.clientX - startX;
      if (Math.abs(dx) > width * 0.28) go(at + (dx < 0 ? 1 : -1));
      else place(true);
    };
    block.addEventListener("pointerup", release);
    block.addEventListener("pointercancel", release);
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
    const dot = e.target.closest("[data-go]");
    if (dot) { go(Number(dot.dataset.go)); return; }

    const entry = e.target.closest("[data-rev]");
    if (entry) {
      const id = Number(entry.dataset.rev);
      if (history && history[0] && history[0].id === id) { viewing = null; draw(); return; }
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

    if (what === "prev") go(at - 1);
    if (what === "next") go(at + 1);
    if (what === "edit") { viewing = null; editing = true; drawCards(); }
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
      const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/lyrics`, {}));
      if (!made) return;
      await load();
      const index = sheets.findIndex((sh) => sh.id === made.sheet.id);
      at = index < 0 ? sheets.length - 1 : index;
      viewing = null; history = null; editing = true;
      draw();
    }

    if (what === "drop") {
      // The button lives on a card now, so the card decides what is deleted rather than
      // whichever one happened to be showing when the header was pressed.
      const card = act.closest("[data-sheet]");
      const target = card ? sheets.find((sh) => String(sh.id) === card.dataset.sheet) : s;
      if (!target) return;
      const sure = await J.confirm(`Delete “${target.name}”?`, "Its history goes too.",
                                   "Delete it");
      if (!sure) return;
      await J.try(() => J.del(`/api/lyrics/${target.id}`), "Deleted");
      at = Math.max(0, at - 1);
      history = null; viewing = null;
      await load(true);
    }
  });

  /* Assigning a section to a set of words. */
  block.addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-part-for]");
    if (!chip) return;
    e.stopPropagation();
    const sheetId = Number(chip.dataset.partFor);
    const parts = J.arrange.state.parts;
    const already = J.arrange.partForSheet(sheetId);

    const chosen = await J.sheet({
      title: "Which section are these words for?",
      sub: "The card lights up when that section plays, so you can see the words land.",
      confirm: "",
      cancel: "Close",
      body: `<div class="pick-list">
        ${parts.map((part) => `
          <button class="pick-row" data-choose="${part.id}">
            <span class="pick-plus" style="background:hsl(${part.hue} 45% 45%)">&#9679;</span>
            <span class="grow truncate">
              <span class="t truncate">${J.esc(part.name)}</span>
              <span class="s">${part.beats} beats</span>
            </span>
            ${already && already.id === part.id ? '<span class="pick-go">chosen</span>' : ""}
          </button>`).join("")}
        ${already ? `<button class="pick-row" data-choose="">
          <span class="grow"><span class="t">No section</span>
          <span class="s">Unlink these words</span></span></button>` : ""}
      </div>`,
      onMount(sheet, close) {
        sheet.addEventListener("click", (event) => {
          const hit = event.target.closest("[data-choose]");
          if (hit) close({ part: hit.dataset.choose });
        });
      },
    });
    if (!chosen) return;
    J.arrange.setLyricsFor(sheetId, chosen.part || null);
    drawCards();
  });

  /* Right clicking a set of words. */
  J.menu.on(block, ".lyric-card", (card) => {
    const sheet = sheets.find((sh) => String(sh.id) === card.dataset.sheet);
    if (!sheet) return null;
    const linked = J.arrange && J.arrange.partForSheet ? J.arrange.partForSheet(sheet.id) : null;
    return [
      { label: "Edit", icon: "edit", hint: "Click",
        run: () => card.querySelector('[data-act="edit"]')?.click() },
      { label: sheet.is_current ? "This is the current one" : "Make this the current one",
        icon: "star", disabled: !!sheet.is_current,
        run: async () => {
          await J.try(() => J.post(`/api/lyrics/${sheet.id}/current`), "Made current");
          await load(true);
        } },
      { label: `History${sheet.revisions > 1 ? ` (${sheet.revisions})` : ""}`, icon: "open",
        disabled: !(sheet.revisions > 1),
        run: () => J.$('[data-act="history"]', block)?.click() },
      { divider: true },
      { label: "Copy the words", icon: "copy",
        run: async () => {
          try { await navigator.clipboard.writeText(sheet.text || ""); J.toast("Copied."); }
          catch (e) { J.toast("The browser would not let go of the clipboard.", "bad"); }
        } },
      (J.arrange && J.arrange.state.parts.length) ? {
        label: linked ? `Section: ${linked.name}` : "Point at a section", icon: "tag",
        run: () => card.querySelector("[data-part-for]")?.click(),
      } : null,
      { divider: true },
      { label: "Delete these words", icon: "drop", danger: true,
        disabled: sheets.length < 2,
        run: () => card.querySelector('[data-act="drop"]')?.click() },
    ];
  });

  /* The compositor says which section is sounding; the matching card lights up. */
  const onPlaying = (e) => {
    if (!block.isConnected) { J.bus.removeEventListener("arrange:playing", onPlaying); return; }
    sounding(e.detail && e.detail.partId);
  };
  J.on("arrange:playing", onPlaying);
  J.on("arrange:change", () => { if (block.isConnected) drawCards(); });

  const onKey = (e) => {
    if (!block.isConnected) { document.removeEventListener("keydown", onKey); return; }
    if (editing || sheets.length < 2) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowLeft") go(at - 1);
    if (e.key === "ArrowRight") go(at + 1);
  };
  document.addEventListener("keydown", onKey);

  await load();
  wireDrag();
};
