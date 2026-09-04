/* The running orders this song is in.
 *
 * A song page answers "what is this song" from every direction except one: where it sits
 * in the sequences you have built. An album shows its tracks and a playlist shows its
 * items, and from the song there was no way back to either.
 *
 * Pressing one starts it AT THIS SONG. Starting at the top would be a different request,
 * and almost never the one being made: you are looking at this song, so the thing you
 * want to hear is this song and then whatever you decided comes after it.
 */
"use strict";

J.blockSongPlaylists = async function (block, ctx) {
  let rows = [];

  async function load() {
    const data = await J.try(() => J.get(`/api/songs/${ctx.songId}/playlists`));
    rows = (data && data.playlists) || [];
    draw();
  }

  /* Start a running order at this song.
   *
   * The whole order is fetched rather than only this song, because the point of playing
   * from a playlist is what comes next, and a queue of one is just playing the song. */
  async function playFrom(playlistId, index) {
    const data = await J.try(() => J.get(`/api/playlists/${playlistId}`));
    if (!data || !data.playlist) return;
    const items = data.playlist.items || [];

    // Songs only. The player's queue steps through songs, and a loose render in the
    // middle of one has no version to step to.
    const queue = items.filter((i) => i.kind === "song").map((i) => i.song);
    const at = queue.findIndex((s) => s.id === ctx.song.id);
    if (at < 0) {
      // It is in the order, but only as a render, or it has just been taken out.
      await J.playSong(ctx.song);
      return;
    }
    await J.playSong(queue[at], queue);
  }

  function draw() {
    if (!rows.length) {
      block.innerHTML = `
        <div class="block-head"><h2>Playlists</h2><span class="grow"></span>
          <button class="btn ghost sm" data-act="add">Add to a playlist</button>
        </div>
        <p class="faint in-none">Not in any running order yet. A playlist can hold songs
          and loose renders together, and an album has one of its own.</p>`;
      return;
    }

    block.innerHTML = `
      <div class="block-head"><h2>Playlists</h2>
        <span class="tag">${rows.length}</span>
        <span class="grow"></span>
        <button class="btn ghost sm" data-act="add">Add to a playlist</button>
      </div>
      <div class="in-list">
        ${rows.map((p) => `
          <button class="in-row" data-play="${p.id}" data-index="${p.index}"
                  title="Play ${J.esc(p.title)} from here">
            <span class="in-go" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="15" height="15"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>
            </span>
            <span class="grow truncate">
              <span class="t truncate">${J.esc(p.title)}</span>
              <span class="s truncate">${
                p.album_id ? "the album&rsquo;s own order &middot; " : ""
              }${p.index + 1} of ${p.count}${
                p.times > 1 ? ` &middot; in it ${p.times} times` : ""}</span>
            </span>
            <a class="in-open" href="#/playlist/${p.id}" data-link
               title="Open this playlist">Open</a>
          </button>`).join("")}
      </div>`;
  }

  block.addEventListener("click", async (e) => {
    if (e.target.closest("[data-link]")) return;          // the link is its own thing

    const act = e.target.closest("[data-act]");
    if (act && act.dataset.act === "add") {
      await J.addToPlaylist({ kind: "song", id: ctx.song.id, title: ctx.song.title });
      return load();
    }

    const row = e.target.closest("[data-play]");
    if (row) {
      await playFrom(Number(row.dataset.play), Number(row.dataset.index));
    }
  });

  J.menu.on(block, "[data-play]", (node) => {
    const row = rows.find((p) => String(p.id) === node.dataset.play);
    if (!row) return null;
    return [
      { label: "Play from here", icon: "play",
        run: () => playFrom(row.id, row.index) },
      { label: "Open the playlist", icon: "open",
        run: () => { location.hash = `#/playlist/${row.id}`; } },
      row.album_id ? { label: "Open the album", icon: "open",
                       run: () => { location.hash = `#/album/${row.album_id}`; } } : null,
    ];
  });

  // Somebody added this song to a playlist somewhere else on the page.
  J.on("playlists:changed", function follow() {
    if (!block.isConnected) { J.bus.removeEventListener("playlists:changed", follow); return; }
    load();
  });

  await load();
};
