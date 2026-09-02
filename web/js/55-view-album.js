/* An album: a cover, an ordered list, and a way to play the whole thing. */
"use strict";

J.views.album = {
  title: "Album",
  async render(root, params) {
    const data = await J.get(`/api/albums/${params.id}`);
    const album = data.album;
    const songs = data.songs || [];

    root.innerHTML = `
      <div class="page-head">
        ${J.cover({
          url: album.has_cover ? `/api/albums/${album.id}/cover` : null,
          title: album.title,
        })}
        <div class="meta">
          <span class="eyebrow">Album</span>
          <h1>${J.esc(album.title)}</h1>
          <div class="stats">
            ${album.year ? `<span>${album.year}</span><span class="dot"></span>` : ""}
            <span>${songs.length} song${songs.length === 1 ? "" : "s"}</span>
            ${album.duration ? `<span class="dot"></span><span>${J.time(album.duration)}</span>` : ""}
          </div>
          <div class="page-actions">
            <button class="play-btn" data-act="play-album" aria-label="Play album"
                    ${songs.length ? "" : "disabled"}>
              <svg viewBox="0 0 24 24" width="20" height="20"><path d="M8 5l12 7-12 7z" fill="currentColor"/></svg>
            </button>
            <button class="btn" data-act="shuffle" ${songs.length ? "" : "disabled"}>Shuffle</button>
            <button class="btn ghost" data-act="add-songs">Add songs</button>
            <button class="btn ghost" data-act="cover">Cover</button>
            <button class="btn ghost" data-act="edit">Edit</button>
          </div>
        </div>
      </div>

      <div class="section" style="margin-top:var(--s3)">
        ${songs.length ? `
          <div class="tracks">
            ${songs.map((song, i) => J.trackRow(song, { index: i, sub: song.latest_version
              ? `v${song.latest_version}` : "no renders yet" })).join("")}
          </div>`
          : `<div class="empty"><h3>Nothing on this album yet</h3>
               <p>Add songs and drag them into the order you want.</p></div>`}
      </div>

      <input type="file" id="coverPick" accept="image/*" hidden>`;

    J.wireTracks(root, songs);

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;

      if (what === "play-album" && songs.length) J.playSong(songs[0], songs);

      if (what === "shuffle" && songs.length) {
        const order = songs.slice();
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        J.playSong(order[0], order);
      }

      if (what === "cover") J.$("#coverPick").click();

      if (what === "edit") {
        const values = await J.sheet({
          title: "Edit album",
          confirm: "Save",
          body: `<div class="sheet-fields">
            <label class="sheet-label">Title<input class="field" name="title" value="${J.esc(album.title)}"></label>
            <label class="sheet-label">Year<input class="field" name="year" value="${album.year || ""}" inputmode="numeric"></label>
          </div>`,
        });
        if (!values) return;
        await J.try(() => J.patch(`/api/albums/${album.id}`, {
          title: values.title.trim(), year: values.year.trim() || null,
        }), "Saved");
        J.emit("albums:changed");
        J.router.reload();
      }

      if (what === "add-songs") {
        const all = await J.get("/api/songs");
        const already = new Set(songs.map((s) => s.id));
        const options = (all.songs || []).filter((s) => !already.has(s.id));
        if (!options.length) { J.toast("Every song is already on this album."); return; }
        const picked = await J.sheet({
          title: "Add songs",
          confirm: "Add",
          wide: true,
          body: `<div class="stack" style="gap:2px;max-height:46dvh;overflow:auto">
            ${options.map((s) => `
              <label class="candidate" style="cursor:pointer">
                <input type="checkbox" name="s${s.id}" value="${s.id}">
                <span class="grow"><span class="name">${J.esc(s.title)}</span></span>
              </label>`).join("")}
          </div>`,
        });
        if (!picked) return;
        const ids = options.filter((s) => picked[`s${s.id}`]).map((s) => s.id);
        if (!ids.length) return;
        for (const id of ids) {
          await J.try(() => J.post(`/api/albums/${album.id}/songs`, { song_id: id }));
        }
        J.toast(`Added ${ids.length} song${ids.length === 1 ? "" : "s"}`);
        J.router.reload();
      }
    });

    J.$("#coverPick", root).addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await J.try(() => J.upload(`/api/albums/${album.id}/cover`, file), "Cover set");
      J.emit("albums:changed");
      J.router.reload();
    });
  },
};
