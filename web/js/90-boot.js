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

J.markNav = function (view) {
  J.$$("#nav a").forEach((link) => {
    link.classList.toggle("on", link.dataset.view === view);
  });
};

const NAV_ICONS = {
  library: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" fill="none"/></svg>',
  sync: '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M3 7h6l2 2h10v10H3z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="18" height="18"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" fill="none"/><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
};

async function buildRail(state) {
  const nav = J.$("#nav");
  const items = [["library", "Library"]];
  if (state.modules.includes("sync")) items.push(["sync", "Folders"]);
  items.push(["settings", "Settings"]);
  nav.innerHTML = items.map(([view, label]) =>
    `<a href="#/${view === "library" ? "" : view}" data-link data-view="${view}">
       ${NAV_ICONS[view] || ""}<span>${label}</span></a>`).join("");

  await refreshRailAlbums(state);
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

  const version = J.$("#railVersion");
  const commit = state.summary && state.summary.updater && state.summary.updater.commit;
  if (version) version.textContent = commit ? commit : "";

  for (const [name, detail] of Object.entries(state.failed || {})) {
    J.toast(`The ${name} module did not load, so that feature is missing.`, "bad");
    console.warn(`[j-ong] module ${name} failed to load\n`, detail);
  }

  await buildRail(state);

  // ── shell wiring ─────────────────────────────────────────────────────────
  const shell = J.$("#app");
  J.$("#railOpen").addEventListener("click", () => shell.classList.add("rail-open-now"));
  J.$("#railClose").addEventListener("click", () => shell.classList.remove("rail-open-now"));
  J.$("#railScrim").addEventListener("click", () => shell.classList.remove("rail-open-now"));
  window.addEventListener("hashchange", () => shell.classList.remove("rail-open-now"));

  J.$("#newSong").addEventListener("click", () => J.newSong());

  const search = J.$("#search");
  const runSearch = J.debounce(() => {
    const term = search.value.trim();
    location.hash = term ? `#/?q=${encodeURIComponent(term)}` : "#/";
  }, 220);
  search.addEventListener("input", runSearch);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { search.value = ""; runSearch.now(); search.blur(); }
    if (e.key === "Enter") runSearch.now();
  });

  J.on("albums:changed", () => refreshRailAlbums(J.state));
  J.on("settings:changed", async () => {
    const fresh = await J.get("/api/state");
    J.state.settings = fresh.settings;
    document.title = fresh.name;
    J.$(".wordmark").textContent = fresh.name;
  });
  J.on("songs:changed", () => { if (J.router.view === "library") J.router.reload(); });

  // ── keyboard ─────────────────────────────────────────────────────────────
  document.addEventListener("keydown", (e) => {
    const typing = e.target.closest("input, textarea, select, [contenteditable]");
    if (e.key === "/" && !typing) { e.preventDefault(); search.focus(); search.select(); return; }
    if (typing) return;
    if (e.key === " ") { e.preventDefault(); J.player.toggle(); }
    if (e.key === "x" || e.key === "X") { e.preventDefault(); J.player.swap(); }
    if (e.key === "ArrowRight" && e.shiftKey) J.player.step(1);
    if (e.key === "ArrowLeft" && e.shiftKey) J.player.step(-1);
  });

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
