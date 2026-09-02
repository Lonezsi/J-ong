/* The library: what you have, with the artwork doing the work. */
"use strict";

/* One track row, used by the library, albums and search. A song is a line, not a card. */
J.trackRow = function (song, opts) {
  const o = opts || {};
  const playing = J.player.state.song && J.player.state.song.id === song.id;
  const sounding = playing && J.player.state.playing;
  const art = song.artwork_id ? `/api/artwork/${song.artwork_id}/image` : null;

  const lead = o.index !== undefined
    ? (playing
        ? `<span class="playing-bars ${sounding ? "" : "paused"}"><i></i><i></i><i></i></span>`
        : `<span class="index">${o.index + 1}</span>`)
    : J.cover({ url: art, title: song.title });

  const sub = o.sub !== undefined ? o.sub
    : (song.version_count ? `${song.version_count} version${song.version_count === 1 ? "" : "s"}` : "no renders yet");

  return `
    <div class="track ${playing ? "playing" : ""}" data-song="${song.id}" tabindex="0" role="button">
      <span class="lead">${lead}</span>
      <span class="truncate">
        <span class="title truncate">${J.esc(song.title)}</span>
        <span class="sub truncate">${J.esc(sub)}</span>
      </span>
      <span class="ver">${song.latest_version ? `v${song.latest_version}` : ""}</span>
      <span class="dur">${song.duration ? J.time(song.duration) : ""}</span>
    </div>`;
};

/* Clicking or keying a row plays it. Delegated once per view rather than per row. */
J.wireTracks = function (root, songs) {
  const activate = (node) => {
    const song = songs.find((s) => String(s.id) === node.dataset.song);
    if (song) J.playSong(song, songs);
  };
  root.addEventListener("click", (e) => {
    const row = e.target.closest(".track");
    if (row && !e.target.closest("a")) activate(row);
  });
  root.addEventListener("keydown", (e) => {
    const row = e.target.closest(".track");
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); activate(row); }
  });
  root.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".track");
    if (row) location.hash = `#/song/${row.dataset.song}`;
  });
};

J.views.library = {
  title: "Library",
  async render(root, params) {
    const term = (params.q || "").trim();
    const [songData, albumData] = await Promise.all([
      J.get(`/api/songs${term ? `?q=${encodeURIComponent(term)}` : ""}`),
      J.state.modules.includes("albums") ? J.get("/api/albums") : Promise.resolve({ albums: [] }),
    ]);
    const songs = songData.songs || [];
    const albums = albumData.albums || [];

    if (!songs.length && !albums.length && !term) {
      root.innerHTML = `
        <div class="section">
          <div class="empty">
            <h3>Nothing in here yet</h3>
            <p>Add a song by hand, or point J-ong at the folder your renders land in
               and it will find them.</p>
            <div class="row" style="justify-content:center;margin-top:var(--s4)">
              <button class="btn primary" data-new-song>New song</button>
              ${J.state.modules.includes("sync")
                ? '<a class="btn" href="#/sync" data-link>Watch a folder</a>' : ""}
            </div>
          </div>
        </div>`;
      return;
    }

    const heading = term ? `Results for “${J.esc(term)}”` : "Songs";
    root.innerHTML = `
      ${albums.length && !term ? `
        <div class="section">
          <div class="section-head"><h2>Albums</h2><span class="grow"></span>
            <button class="btn sm ghost" data-new-album>New album</button></div>
          <div class="card-grid">
            ${albums.map((album) => `
              <div class="album-card" data-album="${album.id}" tabindex="0" role="button">
                ${J.cover({
                  url: album.has_cover ? `/api/albums/${album.id}/cover` : null,
                  title: album.title,
                })}
                <div class="t truncate">${J.esc(album.title)}</div>
                <div class="s truncate">${album.year ? album.year + " &middot; " : ""}${album.song_count} song${album.song_count === 1 ? "" : "s"}</div>
              </div>`).join("")}
          </div>
        </div>` : ""}

      <div class="section">
        <div class="section-head"><h2>${heading}</h2><span class="grow"></span>
          <button class="btn sm ghost" data-new-song>New song</button></div>
        ${songs.length ? `
          <div class="track-head eyebrow">
            <span></span><span>Title</span><span>Latest</span><span>Length</span>
          </div>
          <div class="tracks">${songs.map((s) => J.trackRow(s)).join("")}</div>`
          : `<div class="empty"><h3>No songs match that</h3><p>Try a shorter search.</p></div>`}
      </div>`;

    J.wireTracks(root, songs);
    root.addEventListener("click", (e) => {
      const card = e.target.closest(".album-card");
      if (card) location.hash = `#/album/${card.dataset.album}`;
      if (e.target.closest("[data-new-song]")) J.newSong();
      if (e.target.closest("[data-new-album]")) J.newAlbum();
    });
  },
};

J.newSong = async function () {
  const values = await J.sheet({
    title: "New song",
    sub: "A song holds every render, lyric and setting from here on.",
    confirm: "Create",
    body: `<div class="sheet-fields">
      <label class="sheet-label">Title
        <input class="field" name="title" placeholder="What is it called?" autocomplete="off">
      </label></div>`,
  });
  if (!values || !values.title.trim()) return;
  const data = await J.try(() => J.post("/api/songs", { title: values.title.trim() }),
                           "Song created");
  if (data) location.hash = `#/song/${data.song.id}`;
};

J.newAlbum = async function () {
  const values = await J.sheet({
    title: "New album",
    confirm: "Create",
    body: `<div class="sheet-fields">
      <label class="sheet-label">Title<input class="field" name="title" autocomplete="off"></label>
      <label class="sheet-label">Year<input class="field" name="year" inputmode="numeric" placeholder="optional"></label>
    </div>`,
  });
  if (!values || !values.title.trim()) return;
  const data = await J.try(() => J.post("/api/albums", {
    title: values.title.trim(), year: values.year.trim() || null,
  }), "Album created");
  if (data) { J.emit("albums:changed"); location.hash = `#/album/${data.album.id}`; }
};
