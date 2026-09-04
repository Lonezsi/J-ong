/* A running order.
 *
 * The one screen in the app where two different kinds of thing sit in one list: songs,
 * which have versions and words and a page of their own, and loose renders, which have
 * a file and nothing else yet. They are drawn the same because in a running order they
 * are the same: things to hear, in an order.
 *
 * An album's playlist cannot be edited here. It is the album in another shape, and the
 * place to change what is in it is the album.
 */
"use strict";

J.views.playlist = {
  title: "Playlist",
  async render(root, params) {
    let playlist = null;

    async function load() {
      const data = await J.get(`/api/playlists/${params.id}`);
      playlist = data.playlist;
      draw();
    }

    /* A running order is a sequence somebody chose, so that is what it opens as. The
     * other orders are there for finding something in a long one, not for replacing it,
     * which is why "the running order" is first and is the only one with no direction to
     * reverse: back to front is a different thing, not a sort. */
    const SORTS = [
      { key: "order", label: "The running order" },
      { key: "title", label: "Title", dir: "up", by: (i) => i.title },
      { key: "kind", label: "Songs and renders apart", dir: "up", by: (i) => i.kind },
      { key: "length", label: "Length", dir: "down", numeric: true,
        by: (i) => (i.song ? i.song.duration : i.render.duration) },
    ];

    const shown = () => J.sort.apply(playlist.items || [], `playlist:${params.id}`, SORTS);

    /* Everything the player needs, whichever kind it is. Built from what is on screen,
     * so pressing the third row plays the third row: the queue used to come from the
     * unsorted array and a sorted list would have played something else entirely. */
    const queueOf = () => shown().map((item) => (item.kind === "song"
      ? { kind: "song", id: item.song.id, song: item.song }
      : { kind: "render", id: item.render.id, render: item.render }));

    async function playFrom(index) {
      const queue = queueOf();
      const at = queue[index];
      if (!at) return;
      if (at.kind === "song") await J.playSong(at.song, queue.filter((q) => q.kind === "song")
        .map((q) => q.song));
      else await J.player.playRender(at.render, queue.filter((q) => q.kind === "render")
        .map((q) => q.render));
    }

    function row(item, index) {
      const song = item.kind === "song" ? item.song : null;
      const art = song && song.artwork_id ? `/api/artwork/${song.artwork_id}/image` : null;
      const sounding = J.player.state.song && (song
        ? J.player.state.song.id === song.id
        : J.player.state.song.id === `render:${item.render.id}`);
      const sub = song
        ? (song.version_count ? `${song.version_count} version${song.version_count === 1 ? "" : "s"}` : "no renders yet")
        : `a render${item.render.duration ? " · " + J.time(item.render.duration) : ""}`;

      return `
        <div class="track ${sounding ? "playing" : ""}" data-index="${index}"
             data-item="${item.item_id}" tabindex="0" role="button">
          <span class="lead">${song
            ? J.cover({ url: art, title: song.title })
            : J.cover({ title: item.title })}</span>
          <span class="truncate">
            ${song
              ? `<a class="title truncate" href="#/song/${song.id}" data-link>${J.esc(item.title)}</a>`
              : `<span class="title truncate">${J.esc(item.title)}</span>`}
            <span class="sub truncate">${J.esc(sub)}</span>
          </span>
          <span class="ver">${song ? "" : "render"}</span>
          <span class="dur">${song && song.duration ? J.time(song.duration) : ""}</span>
        </div>`;
    }

    function draw() {
      const owned = !playlist.album_id;
      root.innerHTML = `
        <div class="section">
          <div class="section-head">
            <h2>${J.esc(playlist.title)}</h2>
            ${playlist.album_id ? '<span class="tag">an album</span>' : ""}
            <span class="grow"></span>
            ${playlist.count ? J.sort.control(`playlist:${params.id}`, SORTS) : ""}
            <button class="btn sm primary" data-act="play"
                    ${playlist.count ? "" : "disabled"}>Play</button>
            ${owned ? '<button class="btn sm ghost" data-act="rename">Rename</button>' : ""}
          </div>

          ${playlist.count ? `<div class="tracks">
            ${shown().map(row).join("")}
          </div>` : `
            <div class="empty">
              <h3>Nothing in it yet</h3>
              <p>${playlist.album_id
                ? "This is the album's own running order. Add songs to the album and they arrive here."
                : "Right click a song or a render anywhere in the library and send it here. "
                  + "A running order can hold both: a finished track, a rough bounce and an "
                  + "idea from last week, one after another."}</p>
            </div>`}
        </div>`;
    }

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (act && act.dataset.act === "play") return playFrom(0);
      if (act && act.dataset.act === "rename") {
        const fields = await J.sheet({
          title: "Rename this playlist", confirm: "Rename",
          body: `<input class="field" name="title" value="${J.esc(playlist.title)}">`,
        });
        if (!fields || !fields.title.trim()) return;
        await J.try(() => J.patch(`/api/playlists/${playlist.id}`,
                                  { title: fields.title.trim() }), "Renamed");
        J.emit("playlists:changed");
        return load();
      }
      const track = e.target.closest("[data-index]");
      if (track && !e.target.closest("a")) return playFrom(Number(track.dataset.index));
    });

    J.menu.on(root, "[data-item]", (node) => {
      const item = (playlist.items || []).find((i) => String(i.item_id) === node.dataset.item);
      if (!item) return null;
      return [
        { label: "Play from here", icon: "play",
          run: () => playFrom(Number(node.dataset.index)) },
        item.kind === "song"
          ? { label: "Open the song", icon: "open",
              run: () => { location.hash = `#/song/${item.song.id}`; } }
          : { label: "Make a song from it", icon: "add",
              run: () => { location.hash = "#/renders"; } },
        playlist.album_id ? null : { divider: true },
        playlist.album_id ? null : {
          label: "Take it out of this playlist", icon: "drop", danger: true,
          run: async () => {
            await J.try(() => J.del(`/api/playlists/${playlist.id}/items/${item.item_id}`));
            await load();
          },
        },
      ];
    });

    J.on("player:change", function follow() {
      if (!root.isConnected) { J.bus.removeEventListener("player:change", follow); return; }
      if (playlist) draw();
    });

    J.sort.wire(root, `playlist:${params.id}`, SORTS, draw);

    await load();
  },
};

/* Sending something to a playlist, from anywhere it is listed.
 *
 * Offered as one sheet rather than a submenu, because a submenu that has to be built
 * from a fetch before it can be opened is a menu that hangs on the way to itself. */
J.addToPlaylist = async function (what) {
  const data = await J.try(() => J.get("/api/playlists"));
  if (!data) return null;
  const mine = (data.playlists || []).filter((p) => !p.album_id);

  const chosen = await J.sheet({
    title: `Add ${what.title} to a playlist`,
    sub: "A running order can hold songs and loose renders together.",
    confirm: "",
    cancel: "Not now",
    body: `<div class="pick-list">
      <button class="pick-row new" data-new="1">
        <span class="pick-plus">+</span>
        <span class="grow truncate"><span class="t truncate">A new playlist</span>
        <span class="s">Named after this to start with</span></span>
      </button>
      ${mine.map((p) => `
        <button class="pick-row" data-playlist="${p.id}">
          <span class="grow truncate"><span class="t truncate">${J.esc(p.title)}</span>
          <span class="s">${p.count} item${p.count === 1 ? "" : "s"}</span></span>
          <span class="pick-go">Add</span>
        </button>`).join("")}
      ${mine.length ? "" : `<p class="faint" style="padding:var(--s3)">
        You have no playlists of your own yet.</p>`}
    </div>`,
    onMount(sheet, close) {
      sheet.addEventListener("click", (e) => {
        const hit = e.target.closest("[data-playlist], [data-new]");
        if (hit) close(hit.dataset.new ? { fresh: true } : { id: Number(hit.dataset.playlist) });
      });
    },
  });
  if (!chosen) return null;

  return J.try(async () => {
    let id = chosen.id;
    let title = null;
    if (chosen.fresh) {
      const made = await J.post("/api/playlists", { title: what.title });
      id = made.playlist.id;
      title = made.playlist.title;
    }
    const body = what.kind === "render" ? { render_id: what.id } : { song_id: what.id };
    const result = await J.post(`/api/playlists/${id}/items`, body);
    J.emit("playlists:changed");
    J.toast(result.added
      ? `Added to ${title || result.playlist.title}.`
      : result.message || "Already there.");
    return result;
  });
};
