/* The song page. One header, a row of pills, one panel at a time. */
"use strict";

J.views.song = {
  title: "Song",
  async render(root, params) {
    const songId = params.id;
    const data = await J.get(`/api/songs/${songId}`);
    const song = data.song;

    const has = (name) => J.state.modules.includes(name);
    const tabs = [
      has("lyrics") && ["lyrics", "Lyrics"],
      has("versions") && ["versions", "Versions"],
      has("sound") && ["sound", "Sound"],
      has("artwork") && ["artwork", "Artwork"],
      has("youtube") && ["youtube", "YouTube"],
    ].filter(Boolean);
    const wanted = params.tab && tabs.some((t) => t[0] === params.tab)
      ? params.tab : (tabs[0] && tabs[0][0]);

    const [versionData, albumData] = await Promise.all([
      has("versions") ? J.get(`/api/songs/${songId}/versions`) : Promise.resolve({ versions: [] }),
      has("albums") ? J.get(`/api/songs/${songId}/albums`) : Promise.resolve({ albums: [] }),
    ]);
    const versions = versionData.versions || [];
    const current = versions.find((v) => v.id === song.current_version_id) || versions[0];
    const art = song.artwork_id ? `/api/artwork/${song.artwork_id}/image` : null;

    root.innerHTML = `
      <div class="page-head">
        ${J.cover({ url: art, title: song.title })}
        <div class="meta">
          <span class="eyebrow">Song</span>
          <h1>${J.esc(song.title)}</h1>
          <div class="stats">
            ${(albumData.albums || []).map((a) =>
              `<a href="#/album/${a.id}" data-link>${J.esc(a.title)}</a>`).join('<span class="dot"></span>')}
            ${albumData.albums && albumData.albums.length ? '<span class="dot"></span>' : ""}
            <span>${current ? `v${current.n}` : "no renders"}</span>
            ${current && current.duration ? `<span class="dot"></span><span>${J.time(current.duration)}</span>` : ""}
            ${current && current.bitrate ? `<span class="dot"></span><span>${current.bitrate} kbps</span>` : ""}
            <span class="dot"></span><span>updated ${J.when(song.updated_at)}</span>
          </div>
          <div class="page-actions">
            <button class="play-btn" data-act="play" aria-label="Play"
                    ${versions.length ? "" : "disabled"}>
              <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>
            </button>
            ${has("versions") ? '<button class="btn" data-act="upload">Upload render</button>' : ""}
            <button class="btn ghost" data-act="rename">Rename</button>
            ${has("albums") ? '<button class="btn ghost" data-act="album">Albums</button>' : ""}
            <button class="btn ghost danger" data-act="delete">Delete</button>
          </div>
        </div>
      </div>

      <div class="song-tabs pills">
        ${tabs.map(([key, label]) =>
          `<button class="pill ${key === wanted ? "on" : ""}" data-tab="${key}">${label}</button>`).join("")}
      </div>
      <div id="panel"></div>
      <input type="file" id="renderPick" accept="audio/*,.mp3,.wav,.flac,.m4a" hidden>`;

    const panel = J.$("#panel", root);
    const context = { song, versions, current, songId, reload: () => J.router.reload() };

    const panels = {
      lyrics: J.panelLyrics, versions: J.panelVersions, sound: J.panelSound,
      artwork: J.panelArtwork, youtube: J.panelYouTube,
    };
    if (wanted && panels[wanted]) await panels[wanted](panel, context);

    root.addEventListener("click", async (e) => {
      const tab = e.target.closest("[data-tab]");
      if (tab) {
        location.hash = `#/song/${songId}/${tab.dataset.tab}`;
        return;
      }
      const act = e.target.closest("[data-act]");
      if (!act) return;

      if (act.dataset.act === "play") J.playSong(song);
      if (act.dataset.act === "upload") J.$("#renderPick").click();

      if (act.dataset.act === "rename") {
        const values = await J.sheet({
          title: "Rename song", confirm: "Save",
          body: `<div class="sheet-fields"><label class="sheet-label">Title
            <input class="field" name="title" value="${J.esc(song.title)}"></label></div>`,
        });
        if (!values || !values.title.trim()) return;
        await J.try(() => J.patch(`/api/songs/${songId}`, { title: values.title.trim() }), "Renamed");
        J.router.reload();
      }

      if (act.dataset.act === "album") J.pickAlbums(song);

      if (act.dataset.act === "delete") {
        const sure = await J.confirm(
          `Delete “${song.title}”?`,
          "Every version, lyric and setting goes with it. The audio files stay on disk.",
          "Delete the song");
        if (!sure) return;
        await J.try(() => J.del(`/api/songs/${songId}`), "Deleted");
        location.hash = "#/";
      }
    });

    const picker = J.$("#renderPick", root);
    if (picker) {
      picker.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (file) await J.uploadRender(songId, file);
        e.target.value = "";
      });
    }
  },
};

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
          <span class="grow"><span class="name">${J.esc(a.title)}</span>
          <span class="path">${a.song_count} song${a.song_count === 1 ? "" : "s"}</span></span>
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
