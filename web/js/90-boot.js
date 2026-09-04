/* Starting up.
 *
 * Ask the server what it can do, build the navigation from the answer, then hand over
 * to the router. Nothing in the interface assumes a module exists.
 */
"use strict";

J.applyAccent = function (hex) {
  if (!hex) return;
  const root = document.documentElement;
  root.style.setProperty("--accent", hex);
  // The hover and soft variants are derived so one setting stays one setting.
  root.style.setProperty("--accent-hi", J.lighten(hex, 0.14));
  root.style.setProperty("--accent-lo", J.lighten(hex, -0.18));
  root.style.setProperty("--accent-soft", J.alpha(hex, 0.14));
  root.style.setProperty("--accent-line", J.alpha(hex, 0.4));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).backgroundColor || "#0F1311";
};

J.rgb = (hex) => {
  const value = String(hex || "").replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const n = parseInt(full, 16);
  return Number.isFinite(n) ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
                            : { r: 84, g: 179, b: 122 };
};
J.lighten = (hex, amount) => {
  const { r, g, b } = J.rgb(hex);
  const mix = (c) => Math.round(J.clamp(amount > 0 ? c + (255 - c) * amount : c * (1 + amount), 0, 255));
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
};
J.alpha = (hex, a) => {
  const { r, g, b } = J.rgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
};

/* Register an uploaded display face under one name, so the whole stylesheet can ask for
 * "Jong Display" and get either your font or the open one behind it. */
J.wearFont = function (info) {
  const already = document.getElementById("jong-display-face");
  if (already) already.remove();
  if (!info || !info.custom_font) return;
  const format = { "font/ttf": "truetype", "font/otf": "opentype",
                   "font/woff": "woff", "font/woff2": "woff2" }[info.font_format] || "truetype";
  const style = document.createElement("style");
  style.id = "jong-display-face";
  style.textContent = `@font-face {
    font-family: "Jong Display";
    src: url("/api/appearance/font?v=${Math.floor(info.uploaded_at || 0)}") format("${format}");
    font-display: swap;
  }`;
  document.head.appendChild(style);
};

J.markNav = function (view) {
  J.$$("#nav a").forEach((link) => {
    link.classList.toggle("on", link.dataset.view === view);
  });
};

const NAV_ICONS = {
  library: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>',
  sync: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 7h6l2 2h10v10H3z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/></svg>',
  renders: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 3v10m0 0l3.5-3.5M12 13L8.5 9.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M4 15v3a2 2 0 002 2h12a2 2 0 002-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

async function buildRail(state) {
  const nav = J.$("#nav");
  const items = [["library", "Library"]];
  if (state.modules.includes("renders")) items.push(["renders", "Renders"]);
  if (state.modules.includes("sync")) items.push(["sync", "Folders"]);
  items.push(["settings", "Settings"]);
  nav.innerHTML = items.map(([view, label]) =>
    `<a href="#/${view === "library" ? "" : view}" data-link data-view="${view}">
       ${NAV_ICONS[view] || ""}<span>${label}</span>
       ${view === "renders" ? `<span class="nav-badge" id="renderBadge" hidden></span>` : ""}</a>`).join("");

  refreshRenderBadge();
  await refreshRailAlbums(state);
  await refreshRailPlaylists(state);
}

/* How many renders are still waiting to be told what they are. Read from the server
 * rather than counted in the page, because the desktop client adds to that list too. */
async function refreshRenderBadge() {
  const badge = document.getElementById("renderBadge");
  if (!badge) return;
  try {
    const data = await J.get("/api/renders");
    badge.textContent = data.waiting || "";
    badge.hidden = !data.waiting;
  } catch (e) {
    badge.hidden = true;
  }
}

/* Playlists of your own in the rail. An album's own is reached through the album, which
 * is where the songs in it are decided, so listing it separately would be two doors to
 * one room. */
async function refreshRailPlaylists(state) {
  const holder = J.$("#railPlaylists");
  if (!holder) return;
  if (!state.modules.includes("playlists")) { holder.innerHTML = ""; return; }
  try {
    const data = await J.get("/api/playlists");
    const mine = (data.playlists || []).filter((p) => !p.album_id);
    holder.innerHTML = mine.length
      ? `<div class="eyebrow">Playlists</div>` + mine.map((p) => `
          <a class="rail-album" href="#/playlist/${p.id}" data-link>
            ${J.cover({ title: p.title, className: "cover" })}
            <span class="truncate">
              <span class="t truncate">${J.esc(p.title)}</span>
              <span class="s truncate">${p.count} item${p.count === 1 ? "" : "s"}</span>
            </span>
          </a>`).join("")
      : "";
  } catch (e) {
    holder.innerHTML = "";
  }
}

async function refreshRailAlbums(state) {
  const holder = J.$("#railAlbums");
  if (!state.modules.includes("albums")) { holder.innerHTML = ""; return; }
  try {
    const data = await J.get("/api/albums");
    const albums = data.albums || [];
    holder.innerHTML = albums.length
      ? `<div class="eyebrow">Albums</div>` + albums.map((album) => `
          <a class="rail-album" href="#/album/${album.id}" data-link>
            ${J.cover({
              url: album.has_cover ? `/api/albums/${album.id}/cover` : null,
              title: album.title, className: "cover",
            })}
            <span class="truncate">
              <span class="t truncate">${J.esc(album.title)}</span>
              <span class="s truncate">${album.song_count} song${album.song_count === 1 ? "" : "s"}</span>
            </span>
          </a>`).join("")
      : "";
  } catch (e) {
    holder.innerHTML = "";
  }
}

async function boot() {
  let state;
  try {
    state = await J.get("/api/state");
  } catch (e) {
    document.body.innerHTML =
      `<div style="padding:48px;font-family:system-ui;color:#E8EDE9">
         <h1 style="font-family:Syne,sans-serif">J-ong is not answering</h1>
         <p>${J.esc(e.message)}</p>
         <p style="color:#9BA8A0">Start it with <code>python server.py</code> and reload.</p>
       </div>`;
    return;
  }

  J.state = state;
  J.state.modules = state.modules || [];
  document.title = state.name || "J-ong";
  J.$(".wordmark").textContent = state.name || "J-ong";
  J.applyAccent(state.settings && state.settings.accent);
  J.wearFont(state.summary && state.summary.appearance);

  const version = J.$("#railVersion");
  const commit = state.summary && state.summary.updater && state.summary.updater.commit;
  if (version) version.textContent = commit ? commit : "";

  for (const [name, detail] of Object.entries(state.failed || {})) {
    J.toast(`The ${name} module did not load, so that feature is missing.`, "bad");
    console.warn(`[j-ong] module ${name} failed to load\n`, detail);
  }

  await buildRail(state);

  // ── shell wiring ─────────────────────────────────────────────────────────
  /* The rail can be put away at any width. On a wide screen its column collapses and
   * the library takes the room; on a narrow one it slides off as an overlay. One class
   * covers both, so the two buttons always do something rather than only doing something
   * below a breakpoint. */
  const shell = J.$("#app");
  const RAIL_KEY = "jong.rail.shut";
  const narrow = () => window.matchMedia("(max-width: 900px)").matches;

  function setRail(shut) {
    shell.classList.toggle("rail-shut", shut);
    // Only a deliberate choice on a wide screen is worth remembering. On a phone the
    // rail always starts out of the way.
    if (!narrow()) localStorage.setItem(RAIL_KEY, shut ? "1" : "0");
  }
  setRail(narrow() ? true : localStorage.getItem(RAIL_KEY) === "1");

  /* Swiping sideways opens or closes the rail.
   *
   * Anywhere that does not already use a sideways drag, which on a phone is nearly
   * everywhere: a list is mostly rows, and a row has no horizontal gesture of its own,
   * so requiring genuinely blank space would have meant almost nowhere to do it. Only
   * the handful of things that are dragged across on purpose are left out, and each is
   * named below with the reason.
   *
   * Vertical wins ties, because pages scroll up and down and a swipe even slightly more
   * up than across was meant to scroll. Fifty five pixels is far enough that a press
   * that wandered is not mistaken for one of these.
   */
  const KEEPS_ITS_GESTURES = [
    // Things that are dragged sideways on purpose.
    ".deck-window",      // lyric cards are swiped between
    ".comp-scroll",      // the arrangement scrolls across
    "canvas",            // the equaliser and the limiter are dragged in both axes
    ".range", ".bar",    // sliders and the scrub bar
    ".q-knob",
    // Things that scroll inside themselves.
    ".sheet", ".slot-menu", ".pick-list",
    // And the rail, which is the thing being opened.
    ".rail",
  ].join(", ");

  //: How far across before it counts, in pixels.
  const SWIPE = 55;

  /* Empty means nothing here does anything when you press it.
   *
   * Not a list of class names, which was the first attempt and was wrong twice over: it
   * named containers like the hero and the block heads, which cover most of a song page
   * on a phone, and it could never keep up with markup that changes. The question that
   * actually matters is whether the thing under the finger has a press of its own, and
   * an element that does says so: it is a link or a control, it carries an action, or it
   * is drawn with a pointer cursor. Anything else is background, and background is where
   * this gesture lives.
   */
  const INTERACTIVE = "a, button, input, textarea, select, label, summary, [role=button],"
    + " [data-act], [data-link], [data-image], [data-play], [data-preset], [data-slot],"
    + " [data-go], [data-sort-list], [data-new-song], [data-new-album], [data-song],"
    + " [data-render], [data-post], [data-item], [data-index], [data-album], [contenteditable]";

  function hasAPressOfItsOwn(node) {
    if (!node || !node.closest) return false;
    if (node.closest(INTERACTIVE)) return true;
    // The catch all: anything drawn as pressable is pressable, whatever it is called.
    for (let at = node, depth = 0; at && at !== document.body && depth < 6; at = at.parentElement, depth++) {
      if (at.nodeType !== 1) continue;
      if (getComputedStyle(at).cursor === "pointer") return true;
    }
    return false;
  }

  let swipe = null;
  document.addEventListener("pointerdown", (e) => {
    swipe = null;
    if (e.button) return;                                   // a right or middle press
    if (e.target.closest(KEEPS_ITS_GESTURES)) return;       // something else owns this
    if (hasAPressOfItsOwn(e.target)) return;                // it belongs to that instead
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId, done: false,
              mouse: e.pointerType === "mouse" };
  }, { passive: true });

  document.addEventListener("pointermove", (e) => {
    if (!swipe || swipe.done || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    if (Math.abs(dy) >= Math.abs(dx)) { swipe = null; return; }   // they are scrolling
    if (Math.abs(dx) < SWIPE) return;
    // A mouse drag that picked up words on the way was a selection after all.
    if (swipe.mouse && !(window.getSelection() || { isCollapsed: true }).isCollapsed) {
      swipe = null;
      return;
    }
    swipe.done = true;
    setRail(dx < 0);                                        // right opens, left shuts
  }, { passive: true });

  const endSwipe = () => { swipe = null; };
  document.addEventListener("pointerup", endSwipe, { passive: true });
  document.addEventListener("pointercancel", endSwipe, { passive: true });

  J.$("#railOpen").addEventListener("click", () => setRail(false));
  J.$("#railClose").addEventListener("click", () => setRail(true));
  J.$("#railScrim").addEventListener("click", () => setRail(true));
  // Following a link on a phone should not leave the overlay sitting over the answer.
  window.addEventListener("hashchange", () => { if (narrow()) setRail(true); });
  window.matchMedia("(max-width: 900px)").addEventListener("change", (e) => {
    setRail(e.matches ? true : localStorage.getItem(RAIL_KEY) === "1");
  });

  J.$("#newSong").addEventListener("click", () => J.newSong());

  const search = J.$("#search");
  const runSearch = J.debounce(() => {
    const term = search.value.trim();
    location.hash = term ? `#/?q=${encodeURIComponent(term)}` : "#/";
  }, 220);
  search.addEventListener("input", runSearch);

  /* Show what the list is filtered by.
   *
   * The term is written into the hash and was never read back, so a reload, a Back, or a
   * link into a search showed a filtered library above an empty box, with no way to tell
   * why half the songs were missing. */
  function showTerm() {
    const at = location.hash.indexOf("?");
    const params = new URLSearchParams(at < 0 ? "" : location.hash.slice(at + 1));
    const term = params.get("q") || "";
    if (document.activeElement !== search && search.value !== term) search.value = term;
  }
  window.addEventListener("hashchange", showTerm);
  showTerm();
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; runSearch.now(); search.blur(); }
    if (e.key === "Enter") runSearch.now();
  });

  /* Albums in the rail get the same menu as the cards in the library, because they are
   * the same album and a person should not have to remember which copy of a thing they
   * are pointing at. */
  const rail = J.$("#railAlbums");
  if (rail) {
    J.menu.on(rail, ".rail-album", (node) => {
      const href = node.getAttribute("href") || "";
      const id = href.split("/").pop();
      if (!id) return null;
      return [
        { label: "Open", icon: "open", hint: "Click", run: () => { location.hash = href; } },
        { label: "Play it through", icon: "play",
          run: async () => {
            const data = await J.try(() => J.get(`/api/albums/${id}`));
            const list = data && data.songs;
            if (!list || !list.length) { J.toast("That album has no songs in it yet."); return; }
            J.playSong(list[0], list);
          } },
      ];
    });
  }

  J.on("albums:changed", () => refreshRailAlbums(J.state));
  J.on("playlists:changed", () => refreshRailPlaylists(J.state));
  J.on("renders:changed", refreshRenderBadge);
  J.on("settings:changed", async () => {
    const fresh = await J.get("/api/state");
    J.state.settings = fresh.settings;
    document.title = fresh.name;
    J.$(".wordmark").textContent = fresh.name;
  });
  J.on("songs:changed", () => { if (J.router.view === "library") J.router.reload(); });

  /* What the keyboard does, on the one key nobody has to be told about.
   *
   * Five shortcuts existed and there was nowhere at all to find out they did. A key that
   * is a question mark asking a question is the one piece of interface that explains
   * itself, and the rail says it quietly so it can be found without knowing first. */
  function showKeys() {
    if (J.$(".sheet")) return;
    const row = (keys, what) => `<div class="key-row">
      <span class="keys">${keys.map((k) => `<kbd>${J.esc(k)}</kbd>`).join("")}</span>
      <span>${J.esc(what)}</span></div>`;
    J.sheet({
      title: "Keyboard",
      sub: "Anywhere that is not a text field.",
      confirm: "",
      cancel: "Close",
      body: [
        row(["Space"], "play or pause"),
        row(["X"], "swap A and B"),
        row(["/"], "jump to search"),
        row(["←", "→"], "page between sets of lyrics"),
        row(["Shift", "←", "→"], "previous or next song"),
        row(["Backspace"], "remove the selected section, in the compositor"),
        row(["Esc"], "close this"),
        row(["?"], "show this again"),
      ].join(""),
    });
  }

  /* A failure inside an async handler used to reach nothing at all.
   *
   * Twice in one week: a ReferenceError in a click handler that saved on the server and
   * then silently stopped, and a dead call in the equaliser that killed every drag. Both
   * were invisible because window.onerror does not see a rejected promise, and neither
   * left a mark anywhere. */
  window.addEventListener("unhandledrejection", (e) => {
    const why = (e.reason && (e.reason.message || e.reason)) || "something failed";
    console.error("unhandled:", e.reason);
    J.toast(`Something went wrong: ${String(why).slice(0, 120)}`, "bad");
  });

  // ── keyboard ─────────────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, textarea, select, [contenteditable]");
    if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); search.select(); return; }
    if (typing) return;

    /* A key does one thing, and the thing nearest the hand wins.
     *
     * Space on a focused row called playSong here and toggle() there and toggle() again
     * inside playSong's same-song branch, so pressing it raced three ways. And with a
     * sheet or a menu open, Space was toggling the music behind the dialog somebody was
     * reading. Anything with its own answer for this key gets it; the page takes what is
     * left. */
    if (J.menu.isOpen || document.querySelector(".sheet, dialog[open]")) return;
    if (e.key === " " && e.target.closest("[role=button], button, a, [tabindex]")) return;

    if (e.key === " ") { e.preventDefault(); J.player.toggle(); }
    if (e.key === "x" || e.key === "X") { e.preventDefault(); J.player.swap(); }
    // The lyric deck answers Shift+Arrow when it has focus, so the transport only takes
    // it when nothing on the page has claimed it.
    if (e.defaultPrevented) return;
    if (e.key === "ArrowRight" && e.shiftKey) { e.preventDefault(); J.player.step(1); }
    if (e.key === "ArrowLeft" && e.shiftKey) { e.preventDefault(); J.player.step(-1); }
    if (e.key === "?") { e.preventDefault(); showKeys(); }
  });

  const keysButton = J.$("#railKeys");
  if (keysButton) keysButton.addEventListener("click", showKeys);

  /* Build the audio engine on the first touch of anything, not on the first press of
   * play.
   *
   * A browser will not let a page make an AudioContext until someone has interacted
   * with it, so the work landed on the play button: seventy odd milliseconds of making
   * the context, resuming it and wiring two decks, every one of them spent after the
   * press and before any sound. Any click satisfies the browser, so the first one does
   * it, and by the time play is pressed the engine has been ready for a while.
   */
  const warmAudio = () => {
    document.removeEventListener("pointerdown", warmAudio, true);
    document.removeEventListener("keydown", warmAudio, true);
    try {
      J.audio.resume();
      ["A", "B"].forEach((slot) => J.audio.wire(slot));
    } catch (e) { /* it will be built on the first play instead */ }
  };
  document.addEventListener("pointerdown", warmAudio, true);
  document.addEventListener("keydown", warmAudio, true);

  J.emit("boot");
  J.router.start();

  // A quiet check on startup, so the dot in the corner is the only nagging there is.
  if (J.state.modules.includes("updater") && state.settings.auto_update !== false) {
    setTimeout(async () => {
      try {
        const info = await J.get("/api/update/check");
        if (info.update_available) {
          J.$("#updateDot").hidden = false;
          J.$("#updateDot").title = "An update is ready. Settings has the button.";
        }
      } catch (e) { /* offline is not worth a toast on every start */ }
    }, 2500);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
