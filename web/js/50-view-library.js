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
        <a class="title truncate" href="#/song/${song.id}" data-link
           title="Open ${J.esc(song.title)}">${J.esc(song.title)}</a>
        <span class="sub truncate">${J.esc(sub)}</span>
      </span>
      <span class="ver">${song.latest_version ? `v${song.latest_version}` : ""}</span>
      <span class="dur">${song.duration ? J.time(song.duration) : ""}</span>
    </div>`;
};

/* Clicking a row plays it; clicking its title opens it.
 *
 * Playing was the only thing a row did, with the song page behind a double click. That
 * is not a gesture anyone finds on purpose and it does not exist on a phone at all, so
 * the page holding the lyrics, the sound and the arrangement had no way in from the
 * list you reach it from. The title is a link now, and the row handler steps aside for
 * links, which it already did. */
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
      /* The first screen anyone sees, so it says what this is for rather than that it
       * is empty. Three steps, in the order they actually happen, each with the button
       * that does it: nobody reads a paragraph and then goes looking. */
      // Read now rather than from the boot snapshot: renders can arrive without any
      // song existing yet, which is exactly the case this screen is for.
      let waiting = 0;
      if (J.state.modules.includes("renders")) {
        try { waiting = (await J.get("/api/renders")).waiting || 0; } catch (e) { waiting = 0; }
      }
      root.innerHTML = `
        <div class="section">
          <div class="empty start-here">
            <h3>A song here is not a file</h3>
            <p>It is one place that holds every bounce of a track, the words, the artwork
               and the way you want it cut. Renders come and go underneath it; the song
               stays.</p>

            <ol class="steps">
              <li>
                <span class="step-n">1</span>
                <span class="step-body">
                  <b>Start a song</b>
                  <span>Give it a name. You can rename it later and J-ong keeps the old
                        names, the way Steam does.</span>
                  <button class="btn sm primary" data-new-song>New song</button>
                </span>
              </li>
              <li>
                <span class="step-n">2</span>
                <span class="step-body">
                  <b>Get a render onto it</b>
                  <span>${waiting
                    ? `${waiting} render${waiting === 1 ? " is" : "s are"} already waiting
                       to be told which song they belong to.`
                    : "Upload a bounce, or point J-ong at the folder your exports land in "
                      + "and it will notice them arriving."}</span>
                  ${waiting
                    ? '<a class="btn sm" href="#/renders" data-link>Open Renders</a>'
                    : (J.state.modules.includes("sync")
                        ? '<a class="btn sm" href="#/sync" data-link>Watch a folder</a>' : "")}
                </span>
              </li>
              <li>
                <span class="step-n">3</span>
                <span class="step-body">
                  <b>Then the rest is on the song</b>
                  <span>Write the words, compare two bounces through two equalisers, or
                        cut four bars out of the intro. All of it lives on the song's own
                        page, nothing behind a menu.</span>
                </span>
              </li>
            </ol>
          </div>
        </div>`;
      // The handler is wired below, after this block used to return straight past it,
      // which left both of these buttons doing nothing at all on a fresh library.
      wire(root, []);
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

    wire(root, songs);
  },
};

function wire(root, songs) {
  if (songs.length) J.wireTracks(root, songs);
  root.addEventListener("click", (e) => {
    const card = e.target.closest(".album-card");
    if (card) location.hash = `#/album/${card.dataset.album}`;
    if (e.target.closest("[data-new-song]")) J.newSong();
    if (e.target.closest("[data-new-album]")) J.newAlbum();
  });
}

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
