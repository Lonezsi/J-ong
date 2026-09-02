/* The song page.
 *
 * One page, top to bottom: what it is, then the words, then the sound, then the renders.
 * No tabs. Everything a song has is on screen or one scroll away, and the things
 * themselves are the controls: the title is an editable line, the cover takes a pen when
 * you point at it, the version opens the list of versions.
 */
"use strict";

J.views.song = {
  title: "Song",
  async render(root, params) {
    const songId = params.id;
    const has = (name) => J.state.modules.includes(name);

    const [songData, versionData, albumData, artData, titleData] = await Promise.all([
      J.get(`/api/songs/${songId}`),
      has("versions") ? J.get(`/api/songs/${songId}/versions`) : Promise.resolve({ versions: [] }),
      has("albums") ? J.get(`/api/songs/${songId}/albums`) : Promise.resolve({ albums: [] }),
      has("artwork") ? J.get(`/api/songs/${songId}/artwork`) : Promise.resolve({ artwork: [] }),
      J.get(`/api/songs/${songId}/titles`).catch(() => ({ previous: [] })),
    ]);

    const song = songData.song;
    const versions = versionData.versions || [];
    const albums = albumData.albums || [];
    const artwork = artData.artwork || [];
    const previous = titleData.previous || [];
    const current = versions.find((v) => v.id === song.current_version_id) || versions[0];
    const cover = artwork.length ? `/api/artwork/${artwork[0].id}/image` : null;

    const ctx = { song, songId, versions, current, artwork, has };

    root.innerHTML = `
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
              <button class="play-btn" id="heroPlay" aria-label="Play"
                      ${versions.length ? "" : "disabled"}>
                <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>
              </button>
              ${versions.length ? `
                <button class="version-pick" id="versionPick">
                  v${current.n}
                  <span class="caret">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>
                  </span>
                </button>` : ""}
              <span class="hero-facts">
                ${albums.map((a) => `<a href="#/album/${a.id}" data-link>${J.esc(a.title)}</a>`)
                  .join('<span class="dot"></span>')}
                ${albums.length ? '<span class="dot"></span>' : ""}
                ${current && current.duration ? `<span>${J.time(current.duration)}</span><span class="dot"></span>` : ""}
                <span>${versions.length} render${versions.length === 1 ? "" : "s"}</span>
              </span>
            </div>
          </div>
        </div>
      </div>

      ${has("lyrics") ? '<div class="block" id="lyricsBlock"></div>' : ""}
      ${has("sound") ? '<div class="block" id="soundBlock"></div>' : ""}
      ${has("versions") ? '<div class="block" id="versionsBlock"></div>' : ""}
      ${has("artwork") ? '<div class="block" id="artworkBlock"></div>' : ""}

      <div class="block">
        <div class="block-head"><h2>Song</h2><span class="grow"></span>
          <button class="btn ghost sm" data-act="albums">Albums</button>
          <button class="btn ghost sm danger" data-act="delete">Delete</button>
        </div>
      </div>

      <input type="file" id="renderPick" accept="audio/*,.mp3,.wav,.flac,.m4a" hidden>
      <input type="file" id="artPick" accept="image/*" multiple hidden>`;

    parallax(root);
    wireTitle(root, ctx, previous);
    wireHero(root, ctx);

    if (has("lyrics")) await J.blockLyrics(J.$("#lyricsBlock", root), ctx);
    if (has("sound")) await J.blockSound(J.$("#soundBlock", root), ctx);
    if (has("versions")) await J.blockVersions(J.$("#versionsBlock", root), ctx);
    if (has("artwork")) await J.blockArtwork(J.$("#artworkBlock", root), ctx);
  },
};

/* The blurred artwork drifts slower than the page. Cheap, and it makes the header feel
 * like a place rather than a strip. Skipped entirely when motion is unwelcome. */
function parallax(root) {
  const art = J.$("#heroArt", root);
  const view = J.$("#view");
  if (!art || !view) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let ticking = false;
  const draw = () => {
    ticking = false;
    const y = view.scrollTop * 0.38;
    art.style.transform = `translate3d(0, ${y}px, 0) scale(1.3)`;
  };
  view.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(draw);
  }, { passive: true });
}

/* The title is the control. Click it, type, press Enter. */
function wireTitle(root, ctx, previous) {
  const heading = J.$("#songTitle", root);
  if (!heading) return;

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
      document.title = value;
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
  }

  const picker = J.$("#versionPick", root);
  if (picker) {
    picker.addEventListener("click", async () => {
      const choice = await J.sheet({
        title: "Versions",
        sub: "Pick the one this song opens with, or play any of them.",
        confirm: "", cancel: "Close",
        body: `<div class="stack" style="gap:2px">
          ${ctx.versions.map((v) => `
            <div class="history-entry ${v.id === ctx.song.current_version_id ? "on" : ""}"
                 data-version="${v.id}">
              <span style="font-family:var(--display);font-weight:800">v${v.n}</span>
              <span class="grow">${v.label ? J.esc(v.label) : ""}</span>
              <span class="when">${J.when(v.created_at)}</span>
              <span class="size">${v.duration ? J.time(v.duration) : ""}</span>
            </div>`).join("")}
        </div>`,
        onMount(sheet, close) {
          sheet.addEventListener("click", (e) => {
            const row = e.target.closest("[data-version]");
            if (row) close(row.dataset.version);
          });
        },
      });
      if (!choice) return;
      const version = ctx.versions.find((v) => String(v.id) === String(choice));
      if (!version) return;
      await J.try(() => J.post(`/api/versions/${version.id}/current`));
      await J.player.play(ctx.song, version);
      J.router.reload();
    });
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

/* Uploading a render, with the duration the browser already knows attached, so the
 * version list is right even for formats the server cannot parse. */
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
  function draw(images) {
    block.innerHTML = `
      <div class="block-head"><h2>Artwork</h2></div>
      <div class="art-strip">
        ${images.map((image, i) => `
          <div class="art-tile ${i === 0 ? "is-cover" : ""}" data-image="${image.id}"
               title="${i === 0 ? "The cover" : "Make this the cover"}">
            <img src="/api/artwork/${image.id}/image" alt="" loading="lazy">
            <span class="drop">
              <button class="icon-btn" data-act="remove" aria-label="Remove"
                      style="width:24px;height:24px">
                <svg viewBox="0 0 24 24" width="13" height="13"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
              </button>
            </span>
          </div>`).join("")}
        <button class="art-add" data-act="add" aria-label="Add artwork">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
        </button>
      </div>`;
  }
  draw(ctx.artwork);

  block.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    const tile = e.target.closest("[data-image]");
    if (act && act.dataset.act === "add") { J.$("#artPick").click(); return; }
    if (!tile) return;
    const id = Number(tile.dataset.image);
    if (act && act.dataset.act === "remove") {
      await J.try(() => J.del(`/api/artwork/${id}`), "Removed");
      J.emit("artwork:changed", { songId: ctx.songId });
      J.router.reload();
      return;
    }
    // Clicking a tile promotes it to the cover, which is what a cover picker is.
    const order = [id].concat(ctx.artwork.filter((i) => i.id !== id).map((i) => i.id));
    await J.try(() => J.post(`/api/songs/${ctx.songId}/artwork/order`, { order }), "Cover set");
    J.emit("artwork:changed", { songId: ctx.songId });
    J.router.reload();
  });
};
