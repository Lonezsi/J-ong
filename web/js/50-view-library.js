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

  /* The picture opens the song, the same as the title does. It is the largest thing in
   * the row and the most obviously pressable, so having it do nothing of its own and
   * fall through to "play" was the wrong way round. */
  const leadWrapped = o.index !== undefined ? `<span class="lead">${lead}</span>`
    : `<a class="lead" href="#/song/${song.id}" data-link
          aria-label="Open ${J.esc(song.title)}">${lead}</a>`;

  return `
    <div class="track ${playing ? "playing" : ""}" data-song="${song.id}" tabindex="0" role="button">
      ${leadWrapped}
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
  /* A pointer that settles on a row is usually about to press it. Not on the way past,
   * which would fetch a file for every row a mouse crossed, and not on touch, where
   * there is no hovering and the data would be someone's phone bill. */
  let primeTimer = null;
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const row = e.target.closest(".track");
    clearTimeout(primeTimer);
    if (!row) return;
    primeTimer = setTimeout(async () => {
      const song = songs.find((s) => String(s.id) === row.dataset.song);
      if (!song || !song.version_count) return;
      const data = await J.try(() => J.get(`/api/songs/${song.id}/versions`));
      const list = data && data.versions;
      if (!list || !list.length) return;
      J.player.prime(list.find((v) => v.id === data.current_version_id) || list[0]);
    }, 140);
  });

  root.addEventListener("dblclick", (e) => {
    const row = e.target.closest(".track");
    if (row) location.hash = `#/song/${row.dataset.song}`;
  });

  /* Right clicking a song. Everything you can do to one, in the place you are already
   * pointing at it, rather than by going to its page to find out. */
  J.menu.on(root, ".album-card", (card) => {
    const id = card.dataset.album;
    return [
      { label: "Open", icon: "open", hint: "Click",
        run: () => { location.hash = `#/album/${id}`; } },
      /* Actually plays it. It used to open the album page, which is what Open does,
       * so the menu had two entries doing the same thing and one of them was lying
       * about which. */
      { label: "Play it through", icon: "play",
        run: async () => {
          const data = await J.try(() => J.get(`/api/albums/${id}`));
          const list = data && data.songs;
          if (!list || !list.length) { J.toast("That album has no songs in it yet."); return; }
          J.playSong(list[0], list);
        } },
      { divider: true },
      { label: "Rename", icon: "edit", run: () => renameAlbum(id) },
      { label: "Delete the album", icon: "drop", danger: true,
        run: () => deleteAlbum(id) },
    ];
  });

  J.menu.on(root, ".track", (row) => {
    const song = songs.find((s) => String(s.id) === row.dataset.song);
    if (!song) return null;
    const playing = J.player.state.song && J.player.state.song.id === song.id;
    return [
      { label: playing && J.player.state.playing ? "Pause" : "Play", icon: "play",
        hint: "Click", run: () => J.playSong(song, songs) },
      { label: "Open", icon: "open", run: () => { location.hash = `#/song/${song.id}`; } },
      { divider: true },
      J.state.modules.includes("renders") ? {
        label: "Add a render", icon: "add",
        run: async () => {
          const made = await J.renders.pickFor(song);
          if (made) J.emit("songs:changed");
        },
      } : null,
      J.state.modules.includes("playlists") ? {
        label: "Add to a playlist", icon: "tag",
        run: () => J.addToPlaylist({ kind: "song", id: song.id, title: song.title }),
      } : null,
      J.state.modules.includes("albums") ? {
        label: "Add to an album", icon: "tag",
        run: () => { location.hash = `#/song/${song.id}`; },
      } : null,
      { label: "Rename", icon: "edit", run: () => renameSong(song) },
      { divider: true },
      { label: "Delete", icon: "drop", danger: true, run: () => deleteSong(song) },
    ];
  });
};

/* An album, dealt with from the shelf rather than by opening it first. Deleting one
 * never touches the songs in it, which is worth saying in the question. */
async function renameAlbum(id) {
  const fields = await J.sheet({
    title: "Rename the album", confirm: "Rename",
    body: `<input class="field" name="title" placeholder="Album name">`,
  });
  if (!fields || !fields.title.trim()) return;
  await J.try(() => J.patch(`/api/albums/${id}`, { title: fields.title.trim() }), "Renamed");
  J.emit("albums:changed");
  J.router.reload();
}

async function deleteAlbum(id) {
  const sure = await J.confirm("Delete this album?",
    "The songs in it stay exactly where they are. Only the grouping goes.", "Delete it");
  if (!sure) return;
  await J.try(() => J.del(`/api/albums/${id}`), "Deleted");
  J.emit("albums:changed");
  J.router.reload();
}

/* Renaming and deleting from the menu, so a song can be dealt with from the list it is
 * in. Both ask the server the same way the song page does. */
async function renameSong(song) {
  const fields = await J.sheet({
    title: "Rename",
    sub: "The old name is kept, the way Steam keeps yours.",
    confirm: "Rename",
    body: `<input class="field" name="title" value="${J.esc(song.title)}">`,
  });
  if (!fields || !fields.title.trim() || fields.title.trim() === song.title) return;
  await J.try(() => J.patch(`/api/songs/${song.id}`, { title: fields.title.trim() }), "Renamed");
  J.emit("songs:changed");
  J.router.reload();
}

async function deleteSong(song) {
  const sure = await J.confirm(`Delete ${song.title}?`,
    "Its renders, words and artwork go with it. This cannot be undone.", "Delete it");
  if (!sure) return;
  await J.try(() => J.del(`/api/songs/${song.id}`), "Deleted");
  J.emit("songs:changed");
  J.router.reload();
}

/* The two lists on this page.
 *
 * Recently touched first for songs, because the library is a workbench before it is a
 * catalogue and the thing you had open yesterday is the thing you want today. Albums
 * keep the order the server gives them, newest year first, since an album's year is the
 * closest thing it has to a place in a sequence. */
const SONG_SORTS = [
  { key: "touched", label: "Recently touched", dir: "down", numeric: true,
    by: (s) => s.updated_at },
  { key: "started", label: "When it was started", dir: "down", numeric: true,
    by: (s) => s.created_at },
  { key: "title", label: "Title", dir: "up", by: (s) => s.title },
  { key: "renders", label: "How many renders", dir: "down", numeric: true,
    by: (s) => s.version_count },
  { key: "length", label: "Length", dir: "down", numeric: true, by: (s) => s.duration },
];

const ALBUM_SORTS = [
  { key: "year", label: "Year", dir: "down", numeric: true, by: (a) => a.year },
  { key: "title", label: "Title", dir: "up", by: (a) => a.title },
  { key: "songs", label: "How many songs", dir: "down", numeric: true,
    by: (a) => a.song_count },
  { key: "length", label: "Length", dir: "down", numeric: true, by: (a) => a.duration },
  { key: "made", label: "When it was made", dir: "down", numeric: true,
    by: (a) => a.created_at },
];

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
            ${J.sort.control("albums", ALBUM_SORTS)}
            <button class="btn sm ghost" data-new-album>New album</button></div>
          <div class="card-grid">
            ${J.sort.apply(albums, "albums", ALBUM_SORTS).map((album) => `
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
          ${J.sort.control("songs", SONG_SORTS)}
          <button class="btn sm ghost" data-new-song>New song</button></div>
        ${songs.length ? `
          <div class="track-head eyebrow">
            <span></span><span>Title</span><span>Latest</span><span>Length</span>
          </div>
          <div class="tracks">${J.sort.apply(songs, "songs", SONG_SORTS)
            .map((s) => J.trackRow(s)).join("")}</div>`
          : `<div class="empty"><h3>No songs match that</h3><p>Try a shorter search.</p></div>`}
      </div>`;

    wire(root, songs);
    // Re-rendering the whole view keeps the row wiring and the sorted markup in step;
    // patching one list in place would leave wire()'s closure pointing at the old rows.
    J.sort.wire(root, "songs", SONG_SORTS, () => J.router.reload());
    J.sort.wire(root, "albums", ALBUM_SORTS, () => J.router.reload());
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
