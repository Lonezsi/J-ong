/* The song page.
 *
 * One page, top to bottom: what it is, then the words, then the sound, then the renders.
 * The things themselves are the controls, so there is no row of buttons describing them.
 *
 * A/B lives in the header, beside the version, because comparing is something you do
 * while looking at the song rather than a place you go. Each side carries a render and a
 * preset, so you can put the same mix through two equalisers or two mixes through one.
 */
"use strict";

J.views.song = {
  title: "Song",
  async render(root, params) {
    const songId = params.id;
    const has = (name) => J.state.modules.includes(name);

    const [songData, versionData, albumData, artData, titleData, soundData, arrangeData] =
      await Promise.all([
        J.get(`/api/songs/${songId}`),
        has("versions") ? J.get(`/api/songs/${songId}/versions`) : Promise.resolve({ versions: [] }),
        has("albums") ? J.get(`/api/songs/${songId}/albums`) : Promise.resolve({ albums: [] }),
        has("artwork") ? J.get(`/api/songs/${songId}/artwork`) : Promise.resolve({ artwork: [] }),
        J.get(`/api/songs/${songId}/titles`).catch(() => ({ previous: [] })),
        has("sound") ? J.get(`/api/songs/${songId}/sound`) : Promise.resolve({ presets: [] }),
        // In the same batch, so knowing whether this song plays as arranged costs
        // nothing and can be acted on straight away.
        has("arrange") ? J.get(`/api/songs/${songId}/arrangement`).catch(() => ({}))
                       : Promise.resolve({}),
      ]);
    if (has("arrange")) J.arrange.adopt(songId, arrangeData.arrangement);

    const song = songData.song;
    const versions = versionData.versions || [];
    const albums = albumData.albums || [];
    const artwork = artData.artwork || [];
    const previous = titleData.previous || [];
    const presets = soundData.presets || [];
    const current = versions.find((v) => v.id === song.current_version_id) || versions[0];
    const cover = artwork.length ? `/api/artwork/${artwork[0].id}/image` : null;

    const ctx = {
      song, songId, versions, current, artwork, presets, has,
      /* Which render everything on this page is about. The compositor lays out one
       * render, and that is the one the page is showing rather than whatever the
       * player happens to be holding from another song. */
      currentVersion: () => current || versions[0] || null,
    };
    J.songCtx = ctx;

    root.innerHTML = `
      <!-- The whole panel's ground, not just the header's. It is the song's own artwork,
           enormous and far out of focus, sitting behind everything on the page and
           moving slower than the content does. -->
      <div class="song-wash ${cover ? "" : "flat"}" id="songWash"
           style="${cover ? `background-image:url('${J.esc(cover)}')` : `--hue:${J.hue(song.title)}`}"></div>

      <div class="hero">
        <div class="hero-art ${cover ? "" : "flat"}" id="heroArt"
             style="${cover ? `background-image:url('${J.esc(cover)}')` : `--hue:${J.hue(song.title)}`}"></div>
        <div class="hero-veil"></div>
        <div class="hero-row">
          ${has("artwork") ? `
            <button class="cover-edit" id="coverEdit" aria-label="Change artwork">
              ${J.cover({ url: cover, title: song.title })}
              <span class="cover-pen">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                     stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
                </svg>
              </span>
            </button>` : J.cover({ url: cover, title: song.title, className: "cover-edit" })}

          <div class="hero-meta">
            <h1 class="song-title" id="songTitle" tabindex="0" role="textbox"
                title="Click to rename">${J.esc(song.title)}</h1>

            ${previous.length ? `
              <button class="also-known" id="alsoKnown">
                formerly <b>${J.esc(previous[0].title)}</b>${previous.length > 1
                  ? ` and ${previous.length - 1} more` : ""}
              </button>` : ""}

            <div class="hero-line">
              ${versions.length ? `
                <button class="play-btn" id="heroPlay" aria-label="Play">
                  <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>
                </button>` : ""}
              <span class="hero-facts">
                ${versions.length ? `
                  <b>v${current.n}</b>
                  ${current.duration ? `<span class="dot"></span><span>${J.time(current.duration)}</span>` : ""}
                  <span class="dot"></span>
                  <span>${versions.length} render${versions.length === 1 ? "" : "s"}</span>
                  ${has("versions") ? `
                    <button class="fact-add" data-act="addrender" title="Add a render"
                            aria-label="Add a render">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
                           stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
                        <path d="M12 5v14M5 12h14"/>
                      </svg>
                    </button>` : ""}`
                : has("versions") ? `
                  <button class="btn sm primary" data-act="addrender">Add the first render</button>`
                : "<span>no renders</span>"}
                ${albums.length ? '<span class="dot"></span>' : ""}
                ${albums.map((a) => `<a href="#/album/${a.id}" data-link>${J.esc(a.title)}</a>`)
                  .join('<span class="dot"></span>')}
                ${song.created_at ? `<span class="dot"></span>
                  <span title="Started ${J.esc(J.date(song.created_at))}${
                    song.updated_at && song.updated_at > song.created_at
                      ? `, last touched ${J.esc(J.date(song.updated_at))}` : ""}"
                  >started ${J.esc(J.when(song.created_at))}</span>` : ""}
              </span>
            </div>

            ${versions.length ? `
              <div class="ab-inline" id="abInline">
                <button class="slot-pick" data-slot="A"><span class="k">A</span><span class="v">not set</span>
                  <svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <button class="ab-switch" id="abSwitch" title="Swap A and B (X)" aria-label="Swap A and B" hidden>
                  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                       stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M17 3l4 4-4 4"/><path d="M21 7H8a4 4 0 0 0-4 4"/>
                    <path d="M7 21l-4-4 4-4"/><path d="M3 17h13a4 4 0 0 0 4-4"/>
                  </svg>
                </button>
                <button class="slot-pick" data-slot="B" hidden><span class="k">B</span><span class="v">not set</span>
                  <svg class="caret" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
                </button>
                <button class="btn sm ghost ab-add" data-slot="B" title="Listen to two takes side by side">
                  Compare
                </button>
                ${has("arrange") ? `
                  <button class="btn sm ghost comp-toggle" id="compToggle"
                          title="Cut and reorder this render by the bar"
                          aria-expanded="false">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
                         stroke="currentColor" stroke-width="1.9" stroke-linecap="round">
                      <rect x="3" y="7" width="5" height="10" rx="1.4"/>
                      <rect x="10" y="9" width="4" height="6" rx="1.2"/>
                      <rect x="16" y="6" width="5" height="12" rx="1.4"/>
                    </svg>
                    <span class="comp-toggle-label">Arrange</span>
                  </button>` : ""}
              </div>` : ""}
          </div>
        </div>
      </div>

      ${has("arrange") ? `
        <div class="comp-drawer" id="compDrawer">
          <div class="comp-inner"><div class="comp-body" id="compBody"></div></div>
        </div>` : ""}

      ${has("lyrics") ? '<div class="block" id="lyricsBlock"></div>' : ""}
      ${has("sound") ? '<div class="block" id="soundBlock"></div>' : ""}
      ${has("artwork") ? '<div class="block" id="artworkBlock"></div>' : ""}
      ${has("playlists") ? '<div class="block" id="songPlaylistsBlock"></div>' : ""}
      ${has("youtube") ? '<div class="block" id="youtubeBlock"></div>' : ""}

      <div class="block">
        <div class="block-head"><h2>Song</h2><span class="grow"></span>
          ${has("versions") ? '<button class="btn ghost sm" data-act="upload">Upload a render</button>' : ""}
          <button class="btn ghost sm" data-act="albums">Albums</button>
          <button class="btn ghost sm danger" data-act="delete">Delete</button>
        </div>
      </div>

      <input type="file" id="renderPick" accept="audio/*,.mp3,.wav,.flac,.m4a" hidden>
      <input type="file" id="artPick" accept="image/*" multiple hidden>`;

    parallax(root);
    wireTitle(root, ctx, previous);
    wireHero(root, ctx);
    wireAB(root, ctx);
    if (has("arrange")) wireCompositor(root, ctx);

    /* If this song plays as arranged, start reading the render now.
     *
     * It is the one genuinely slow thing in the app, it only has to happen once, and
     * doing it while the page is being looked at means the play button is usually
     * instant rather than usually a wait. */
    if (has("arrange") && J.arrange.state.enabled
        && J.arrange.state.songId === Number(ctx.songId)) {
      J.arrange.warm();
    }

    // Whatever this page is about is the thing most likely to be played next.
    J.player.prime(ctx.currentVersion());

    if (has("lyrics")) await J.blockLyrics(J.$("#lyricsBlock", root), ctx);
    if (has("sound")) await J.blockSound(J.$("#soundBlock", root), ctx);
    if (has("artwork")) await J.blockArtwork(J.$("#artworkBlock", root), ctx);
    if (has("playlists")) await J.blockSongPlaylists(J.$("#songPlaylistsBlock", root), ctx);
    if (has("youtube")) await J.blockYouTube(J.$("#youtubeBlock", root), ctx);
  },
};

/* A version says which render it is and what the file was called when it arrived. The
 * original name is often the only thing that says which session it came out of. */
J.versionLabel = (v) => `v${v.n}`;
J.versionSub = (v) => v.label || v.filename || "";

/* The blurred artwork drifts slower than the page. */
function parallax(root) {
  const art = J.$("#heroArt", root);
  const view = J.$("#view");
  if (!art || !view) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let ticking = false;
  const draw = () => {
    ticking = false;
    art.style.transform = `translate3d(0, ${view.scrollTop * 0.38}px, 0) scale(1.3)`;
  };
  view.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(draw);
  }, { passive: true });
}

/* ── A and B, in the header ───────────────────────────────────────────────── */
function wireAB(root, ctx) {
  const bar = J.$("#abInline", root);
  if (!bar) return;

  /* B is not a thing until there is a second take to put in it.
   *
   * Showing an empty B chip and a swap arrow next to it offered two controls that could
   * not do anything, on the screen you spend the most time on. Until a B is chosen there
   * is one button, and it says what it is for. */
  function paint() {
    const playing = J.player.state.song && J.player.state.song.id === ctx.song.id;
    for (const slot of ["A", "B"]) {
      const chip = J.$(`.slot-pick[data-slot="${slot}"]`, bar);
      if (!chip) continue;
      const held = playing ? J.player.state.slots[slot] : { version: null, preset: null };
      /* With nothing playing, A still has an answer: the render that would play. Saying
       * "not set" next to a song that plainly has three renders reads as something being
       * broken, and it made you press it to find out what it meant. */
      const shown = held.version || (slot === "A" ? ctx.currentVersion() : null);
      const label = shown
        ? `v${shown.n}${held.preset ? " &middot; " + J.esc(held.preset.name) : ""}`
        : "not set";
      J.$(".v", chip).innerHTML = label;
      chip.classList.toggle("live", playing && J.player.state.active === slot && !!held.version);
    }

    const hasB = playing && !!J.player.state.slots.B.version;
    const bChip = J.$('.slot-pick[data-slot="B"]', bar);
    const swap = J.$("#abSwitch", bar);
    const add = J.$(".ab-add", bar);
    if (bChip) bChip.hidden = !hasB;
    if (swap) swap.hidden = !hasB;
    if (add) add.hidden = hasB;
  }

  /* Right clicking a slot opens what clicking it opens. Nothing is hidden behind the
   * gesture, but nothing falls through to the browser either. */
  bar.addEventListener("contextmenu", (e) => {
    const chip = e.target.closest(".slot-pick, .ab-add");
    if (!chip) return;
    e.preventDefault();
    openSlotMenu(chip, chip.dataset.slot || "B", ctx, paint);
  });

  bar.addEventListener("click", async (e) => {
    const swap = e.target.closest("#abSwitch");
    if (swap) {
      if (!J.player.state.song || J.player.state.song.id !== ctx.song.id) return;
      J.player.swap();
      paint();
      return;
    }
    // Compare opens the same menu the B chip would, so there is one way to fill B.
    const add = e.target.closest(".ab-add");
    if (add) { openSlotMenu(add, "B", ctx, paint); return; }
    const chip = e.target.closest(".slot-pick");
    if (!chip) return;
    const slot = chip.dataset.slot;

    /* The chip selects, the caret opens the menu.
     *
     * These read as dropdowns and they had no way to choose between them: clicking
     * either one only ever opened a menu, so which deck you were listening to, and
     * therefore which equaliser the Sound panel was shaping, could only be changed from
     * the player at the bottom of the screen. Pressing B here now means B, and the panel
     * follows. The caret keeps the menu, and so does a right click. */
    if (!e.target.closest(".caret")) {
      const playing = J.player.state.song && J.player.state.song.id === ctx.song.id;
      const held = playing ? J.player.state.slots[slot] : null;
      if (held && held.version) { J.player.switchTo(slot); paint(); return; }
      // Nothing in it to select yet, so the useful thing is to put something there.
    }
    openSlotMenu(chip, slot, ctx, paint);
  });

  J.on("player:change", function onChange() {
    if (!bar.isConnected) { J.bus.removeEventListener("player:change", onChange); return; }
    paint();
  });
  paint();
}

/* Filling a slot when both were sharing one equaliser.
 *
 * A song opens with the same preset object in A and in B, and an edit is applied by id
 * to every slot holding it, so shaping the curve while B was selected reshaped A as
 * well. Hearing one take through two identical equalisers is not a comparison, and the
 * only way to get a real one was to know to go and make a second preset first.
 *
 * Putting a take into the other slot is the moment somebody says they want to compare,
 * so that is where the copy is made: B gets its own preset, named after the one it came
 * from, and A keeps what it had. Done here and not on the first drag, because forking
 * halfway through a gesture would mean a POST inside a pointermove.
 */
async function forkIfShared(slot, ctx) {
  const state = J.player.state;
  const other = slot === "A" ? "B" : "A";
  const mine = state.slots[slot];
  const theirs = state.slots[other];
  if (!mine || !theirs || !mine.preset || !theirs.preset) return;
  if (mine.preset.id !== theirs.preset.id) return;          // already their own
  if (!theirs.version) return;                              // nothing to compare against

  const made = await J.try(() => J.post(`/api/songs/${ctx.songId}/sound`,
    { name: `${mine.preset.name} ${slot}`, data: mine.preset.data }));
  if (!made || !made.preset) return;                        // it still works, just shared
  ctx.presets = (ctx.presets || []).concat([made.preset]);
  await J.player.set(slot, { preset: made.preset });
  J.emit("sound:change");
}

/* One menu holding both things a slot carries: which render, and which sound. */
/* The compositor drawer.
 *
 * It hangs off one button next to A and B, and it is closed until asked for. Opening it
 * for the first time loads the arrangement and decodes the render, which is the slow
 * part, so the panel says what it is doing rather than sitting blank.
 *
 * Turning it on is a separate act from opening it. Looking at the shape of a song should
 * not change how the song plays.
 */
function wireCompositor(root, ctx) {
  const button = J.$("#compToggle", root);
  const drawer = J.$("#compDrawer", root);
  const body = J.$("#compBody", root);
  if (!button || !drawer || !body) return;

  let panel = null;
  let open = false;

  const paintButton = () => {
    button.classList.toggle("on", J.arrange.state.enabled);
    button.setAttribute("aria-expanded", String(open));
    const label = J.$(".comp-toggle-label", button);
    if (label) label.textContent = J.arrange.state.enabled ? "Arranged" : "Arrange";
    button.title = J.arrange.state.enabled
      ? "This song plays as arranged. Press to see the arrangement."
      : "Cut and reorder this render by the bar";
  };

  async function show() {
    open = true;
    drawer.classList.add("open");
    paintButton();
    if (panel) return;

    body.innerHTML = `<div class="empty comp-empty"><h3>Reading the render…</h3>
      <p>The whole file has to be in hand before it can be drawn and cut.</p></div>`;
    const version = ctx.currentVersion();
    if (version) {
      // Decoded up front: every clip is drawn from the same peaks, and a panel that
      // appears with no waveform in it looks broken rather than busy.
      await J.try(() => J.arrange.buffer(version));
      if (!J.arrange.state.versionId) J.arrange.state.versionId = version.id;
    }
    panel = J.compositor.mount(body, ctx);
  }

  function hide() {
    open = false;
    drawer.classList.remove("open");
    paintButton();
  }

  button.addEventListener("click", () => (open ? hide() : show()));
  J.on("arrange:change", paintButton);
  paintButton();

  // Deliberately not opened on its own. Opening it reads the whole render, and doing
  // that on every visit to a song made the page feel broken.
}


function openSlotMenu(anchor, slot, ctx, done) {
  J.menu.close();          // and the other way round
  const existing = document.querySelector(".slot-menu");
  if (existing) { existing.remove(); if (existing.dataset.slot === slot) return; }

  const playing = J.player.state.song && J.player.state.song.id === ctx.song.id;
  const held = playing ? J.player.state.slots[slot] : { version: null, preset: null };

  const menu = document.createElement("div");
  menu.className = "slot-menu";
  menu.dataset.slot = slot;
  menu.innerHTML = `
    <div class="menu-group">Renders</div>
    ${ctx.versions.map((v) => `
      <div class="menu-row ${held.version && held.version.id === v.id ? "on" : ""}"
           data-version="${v.id}" role="button" tabindex="0">
        <span class="tagline">v${v.n}</span>
        <span class="grow truncate">${J.esc(J.versionSub(v))}</span>
        <span class="when">${v.duration ? J.time(v.duration) : ""}</span>
        <button class="row-drop" data-drop="${v.id}" title="Delete this render"
                aria-label="Delete v${v.n}">
          <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6L6 18"
            stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </button>
      </div>`).join("")}
    <button class="menu-row add" data-upload>
      <span class="tagline">+</span><span class="grow">Upload a render</span>
    </button>
    ${J.state.modules.includes("renders") ? `
      <button class="menu-row add" data-fromlist>
        <span class="tagline">&darr;</span><span class="grow">Take one from the renders list</span>
      </button>` : ""}
    ${ctx.presets.length ? `<div class="menu-group">Sound</div>
      ${ctx.presets.map((p) => `
        <button class="menu-row ${held.preset && held.preset.id === p.id ? "on" : ""}"
                data-preset="${p.id}">
          <span class="tagline">${(p.data.bands || []).length || "flat"}</span>
          <span class="grow truncate">${J.esc(p.name)}</span>
        </button>`).join("")}` : ""}`;

  document.body.appendChild(menu);
  place(menu, anchor);

  const close = (event) => {
    if (event && menu.contains(event.target)) return;
    menu.remove();
    document.removeEventListener("click", close);
  };
  setTimeout(() => document.addEventListener("click", close), 0);

  menu.addEventListener("click", async (e) => {
    const drop = e.target.closest("[data-drop]");
    if (drop) {
      e.stopPropagation();
      const version = ctx.versions.find((v) => String(v.id) === drop.dataset.drop);
      close();
      const sure = await J.confirm(`Delete v${version.n}?`,
        "The audio goes too, unless another version points at the same bytes.", "Delete it");
      if (!sure) return;
      await J.try(() => J.del(`/api/versions/${version.id}`), "Deleted");
      J.emit("versions:changed", { songId: ctx.songId });
      J.router.reload();
      return;
    }
    if (e.target.closest("[data-upload]")) {
      close();
      J.$("#renderPick").click();
      return;
    }
    if (e.target.closest("[data-fromlist]")) {
      close();
      const made = await J.renders.pickFor(ctx.song);
      if (made) J.router.reload();
      return;
    }
    const row = e.target.closest("[data-version], [data-preset]");
    if (!row) return;
    if (!playing) {
      // Nothing is loaded yet, so the first choice starts this song rather than doing
      // nothing and looking broken.
      await J.playSong(ctx.song);
    }
    if (row.dataset.version) {
      const version = ctx.versions.find((v) => String(v.id) === row.dataset.version);
      await J.player.set(slot, { version });
      await forkIfShared(slot, ctx);
    } else {
      const preset = ctx.presets.find((p) => String(p.id) === row.dataset.preset);
      await J.player.set(slot, { preset });
    }
    if (slot === "B" && J.player.state.active !== "B" && J.player.state.slots.B.version) {
      // Choosing a B is asking to hear it.
      await J.player.switchTo("B");
    }
    close();
    if (done) done();
  });
}

/* Put a menu under its chip and inside the window.
 *
 * Fixed rather than absolute, because the header clips its children to keep the blurred
 * artwork tidy and that clipping was cutting the menu in half. */
function place(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const size = menu.getBoundingClientRect();
  const gap = 6;
  let top = rect.bottom + gap;
  if (top + size.height > window.innerHeight - 8) {
    // No room below: hang it above the chip instead of off the bottom of the screen.
    top = Math.max(8, rect.top - size.height - gap);
  }
  const left = J.clamp(rect.left, 8, Math.max(8, window.innerWidth - size.width - 8));
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.minWidth = `${Math.round(Math.max(rect.width, 240))}px`;
}

/* The title is the control. Click it, type, press Enter. */
function wireTitle(root, ctx, previous) {
  const heading = J.$("#songTitle", root);
  if (!heading) return;

  J.menu.on(root, "#songTitle", () => [
    { label: "Rename", icon: "edit", hint: "Click", run: edit },
    previous.length ? { label: `Names it has had (${previous.length})`, icon: "open",
      run: () => J.$("#alsoKnown", root)?.click() } : null,
    { divider: true },
    { label: "Copy the name", icon: "copy",
      run: async () => {
        try { await navigator.clipboard.writeText(ctx.song.title); J.toast("Copied."); }
        catch (e) { J.toast(ctx.song.title); }
      } },
  ]);

  const edit = () => {
    if (J.$(".song-title-input", root)) return;
    const input = document.createElement("input");
    input.className = "song-title-input";
    input.value = ctx.song.title;
    heading.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(heading);
      if (!save || !value || value === ctx.song.title) return;
      const result = await J.try(() => J.patch(`/api/songs/${ctx.songId}`, { title: value }));
      if (!result) return;
      ctx.song.title = value;
      heading.textContent = value;
      J.emit("songs:changed");
      J.router.reload();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
  };

  heading.addEventListener("click", edit);
  heading.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); edit(); }
  });

  const known = J.$("#alsoKnown", root);
  if (!known) return;
  known.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = J.$(".name-list", root);
    if (open) { open.remove(); return; }
    const list = document.createElement("div");
    list.className = "name-list";
    list.innerHTML = `<ul>${previous.map((p) => `
      <li><span>${J.esc(p.title)}</span><span class="when">${J.when(p.changed_at)}</span></li>`)
      .join("")}</ul>`;
    known.appendChild(list);
    const close = (event) => {
      if (list.contains(event.target) || known.contains(event.target)) return;
      list.remove();
      document.removeEventListener("click", close);
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  });
}

function wireHero(root, ctx) {
  const play = J.$("#heroPlay", root);
  if (play) play.addEventListener("click", () => J.playSong(ctx.song));

  const cover = J.$("#coverEdit", root);
  if (cover && cover.tagName === "BUTTON") {
    cover.addEventListener("click", () => J.$("#artPick", root).click());

    /* The artwork can be replaced, and it can be taken away, and only one of those was
     * reachable. Removing it is not a button anybody wants next to a picture. */
    J.menu.on(root, "#coverEdit", () => [
      { label: ctx.artwork.length ? "Change the artwork" : "Add artwork", icon: "art",
        hint: "Click", run: () => J.$("#artPick", root).click() },
      ctx.artwork.length > 1 ? {
        label: `Pick from the ${ctx.artwork.length} it has`, icon: "copy",
        run: () => J.$("#artworkBlock", root)?.scrollIntoView({ behavior: "smooth" }),
      } : null,
      ctx.artwork.length ? { divider: true } : null,
      ctx.artwork.length ? {
        label: "Remove the artwork", icon: "drop", danger: true,
        run: async () => {
          const sure = await J.confirm("Remove this artwork?",
            "The song keeps everything else. You can upload another whenever.", "Remove it");
          if (!sure) return;
          await J.try(() => J.del(`/api/artwork/${ctx.artwork[0].id}`), "Removed");
          J.router.reload();
        },
      } : null,
    ]);
  }

  const renders = J.$("#renderPick", root);
  if (renders) {
    renders.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (file) await J.uploadRender(ctx.songId, file);
      e.target.value = "";
    });
  }

  const art = J.$("#artPick", root);
  if (art) {
    art.addEventListener("change", async (e) => {
      const files = Array.from(e.target.files || []).filter((f) => f.type.startsWith("image/"));
      e.target.value = "";
      if (!files.length) return;
      for (const file of files) {
        await J.try(() => J.upload(`/api/songs/${ctx.songId}/artwork`, file));
      }
      J.toast(files.length === 1 ? "Artwork set" : `${files.length} images added`);
      J.emit("artwork:changed", { songId: ctx.songId });
      J.router.reload();
    });
  }

  root.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "upload") J.$("#renderPick", root).click();

    /* The plus beside the render count. Two ways in, because a render either comes off
     * this machine or is already waiting in the list. */
    if (act.dataset.act === "addrender") {
      /* Straight to the list when there is one.
       *
       * This used to ask "from a file, or from the list?" first, which is a whole extra
       * press to answer a question the answer to which is almost always "the list", and
       * which cannot be answered at all until you know there is a list. The list opens,
       * with uploading a file offered inside it. */
      if (!J.state.modules.includes("renders")) { J.$("#renderPick", root).click(); return; }
      const made = await J.renders.pickFor(ctx.song, () => J.$("#renderPick", root).click());
      if (made) J.router.reload();
      return;
    }
    if (act.dataset.act === "albums") J.pickAlbums(ctx.song);
    if (act.dataset.act === "delete") {
      const sure = await J.confirm(
        `Delete “${ctx.song.title}”?`,
        "Every version, lyric and setting goes with it. The audio files stay on disk.",
        "Delete the song");
      if (!sure) return;
      await J.try(() => J.del(`/api/songs/${ctx.songId}`), "Deleted");
      location.hash = "#/";
    }
  });
}

J.uploadRender = async function (songId, file) {
  J.toast(`Uploading ${file.name}…`);
  const duration = await J.durationOf(file).catch(() => 0);
  const result = await J.try(() => J.upload(`/api/songs/${songId}/versions`, file,
    duration ? { "X-Duration": String(duration) } : {}));
  if (!result) return;
  if (result.duplicate) J.toast(result.message);
  else J.toast(`Saved as v${result.version.n}`);
  J.emit("versions:changed", { songId });
  J.router.reload();
};

J.durationOf = (file) => new Promise((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const audio = new Audio();
  const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
  audio.addEventListener("loadedmetadata", () =>
    done(Number.isFinite(audio.duration) ? audio.duration : 0), { once: true });
  audio.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error("unreadable")); },
    { once: true });
  audio.src = url;
  setTimeout(() => done(0), 6000);
});

J.pickAlbums = async function (song) {
  const [all, mine] = await Promise.all([J.get("/api/albums"), J.get(`/api/songs/${song.id}/albums`)]);
  const inAlbum = new Set((mine.albums || []).map((a) => a.id));
  const albums = all.albums || [];
  if (!albums.length) { J.toast("There are no albums yet."); return; }
  const picked = await J.sheet({
    title: "Albums", sub: "A song can sit on more than one.", confirm: "Save",
    body: `<div class="stack" style="gap:2px">
      ${albums.map((a) => `
        <label class="candidate" style="cursor:pointer">
          <input type="checkbox" name="a${a.id}" ${inAlbum.has(a.id) ? "checked" : ""}>
          <span class="grow"><span class="name">${J.esc(a.title)}</span></span>
        </label>`).join("")}
    </div>`,
  });
  if (!picked) return;
  for (const album of albums) {
    const want = !!picked[`a${album.id}`];
    if (want && !inAlbum.has(album.id)) {
      await J.try(() => J.post(`/api/albums/${album.id}/songs`, { song_id: song.id }));
    } else if (!want && inAlbum.has(album.id)) {
      await J.try(() => J.del(`/api/albums/${album.id}/songs/${song.id}`));
    }
  }
  J.toast("Saved");
  J.emit("albums:changed");
  J.router.reload();
};

/* ── artwork, as a strip rather than a screen ─────────────────────────────── */
J.blockArtwork = async function (block, ctx) {
  block.innerHTML = `
    <div class="block-head"><h2>Artwork</h2></div>
    <div class="art-strip">
      ${ctx.artwork.map((image, i) => `
        <div class="art-tile ${i === 0 ? "is-cover" : ""}" data-image="${image.id}"
             tabindex="0" role="button"
             title="${i === 0 ? "The cover" : "Make this the cover"}">
          <img src="/api/artwork/${image.id}/image" alt="" loading="lazy">
          ${i === 0 ? '<span class="art-badge">Cover</span>' : ""}
          <button class="art-drop" data-act="remove" aria-label="Remove this artwork"
                  title="Remove this artwork">
            <svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
          </button>
        </div>`).join("")}
      <button class="art-add" data-act="add" aria-label="Add artwork">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>`;

  block.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    const tile = e.target.closest("[data-image]");
    if (act && act.dataset.act === "add") { J.$("#artPick").click(); return; }
    if (!tile) return;
    const id = Number(tile.dataset.image);
    if (act && act.dataset.act === "remove") {
      e.stopPropagation();
      await removeArt(id);
      return;
    }
    await makeCover(id);
  });

  async function makeCover(id) {
    const order = [id].concat(ctx.artwork.filter((i) => i.id !== id).map((i) => i.id));
    await J.try(() => J.post(`/api/songs/${ctx.songId}/artwork/order`, { order }), "Cover set");
    J.emit("artwork:changed", { songId: ctx.songId });
    J.router.reload();
  }

  async function removeArt(id) {
    const sure = await J.confirm("Remove this artwork?",
      "The picture goes. Nothing else about the song changes.", "Remove it");
    if (!sure) return;
    await J.try(() => J.del(`/api/artwork/${id}`), "Removed");
    J.emit("artwork:changed", { songId: ctx.songId });
    J.router.reload();
  }

  // Choosing is the click; removing is somewhere you have to mean to go.
  J.menu.on(block, "[data-image]", (tile) => {
    const id = Number(tile.dataset.image);
    const isCover = ctx.artwork.length && ctx.artwork[0].id === id;
    return [
      isCover ? { label: "This is the cover", icon: "star", disabled: true, run: () => {} }
              : { label: "Make this the cover", icon: "star", run: () => makeCover(id) },
      { label: "Open the picture", icon: "open",
        run: () => window.open(`/api/artwork/${id}/image`, "_blank", "noopener") },
      { divider: true },
      { label: "Remove this artwork", icon: "drop", danger: true, run: () => removeArt(id) },
    ];
  });

  block.addEventListener("keydown", (e) => {
    const tile = e.target.closest("[data-image]");
    if (!tile || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    makeCover(Number(tile.dataset.image));
  });
};
