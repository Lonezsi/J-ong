/* Artwork and YouTube: the two smaller panels on a song. */
"use strict";

J.panelArtwork = async function (panel, ctx) {
  let images = [];

  async function load() {
    const data = await J.get(`/api/songs/${ctx.songId}/artwork`);
    images = data.artwork || [];
    draw();
  }

  function draw() {
    panel.innerHTML = `
      <div class="panel">
        ${images.length ? `
          <div class="art-grid">
            ${images.map((image, i) => `
              <div class="art-tile ${i === 0 ? "is-cover" : ""}" data-image="${image.id}">
                <img src="/api/artwork/${image.id}/image" alt="${J.esc(image.caption || "Artwork")}" loading="lazy">
                <div class="acts">
                  ${i === 0 ? "" : '<button class="btn sm" data-act="cover">Make cover</button>'}
                  <button class="icon-btn" data-act="remove" aria-label="Remove image"
                          style="background:rgba(0,0,0,0.4)">
                    <svg viewBox="0 0 24 24" width="15" height="15"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                  </button>
                </div>
              </div>`).join("")}
          </div>` : ""}
        <div class="dropzone" id="artDrop" style="margin-top:${images.length ? "var(--s4)" : "0"}">
          <p style="margin:0 0 var(--s3)">Drop images here, or pick them.</p>
          <button class="btn" data-act="pick">Choose images</button>
        </div>
        <input type="file" id="artPick" accept="image/*" multiple hidden>
      </div>`;

    const drop = J.$("#artDrop", panel);
    const pick = J.$("#artPick", panel);

    ["dragenter", "dragover"].forEach((name) => drop.addEventListener(name, (e) => {
      e.preventDefault(); drop.classList.add("hot");
    }));
    ["dragleave", "drop"].forEach((name) => drop.addEventListener(name, (e) => {
      e.preventDefault(); drop.classList.remove("hot");
    }));
    drop.addEventListener("drop", (e) => send(Array.from(e.dataTransfer.files || [])));
    pick.addEventListener("change", (e) => { send(Array.from(e.target.files || [])); e.target.value = ""; });
  }

  async function send(files) {
    const pictures = files.filter((f) => f.type.startsWith("image/"));
    if (!pictures.length) { J.toast("Those are not images.", "bad"); return; }
    for (const file of pictures) {
      await J.try(() => J.upload(`/api/songs/${ctx.songId}/artwork`, file));
    }
    J.toast(`Added ${pictures.length} image${pictures.length === 1 ? "" : "s"}`);
    J.emit("artwork:changed", { songId: ctx.songId });
    await load();
  }

  panel.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "pick") { J.$("#artPick", panel).click(); return; }
    const tile = act.closest("[data-image]");
    if (!tile) return;
    const id = Number(tile.dataset.image);

    if (act.dataset.act === "cover") {
      const order = [id].concat(images.filter((i) => i.id !== id).map((i) => i.id));
      await J.try(() => J.post(`/api/songs/${ctx.songId}/artwork/order`, { order }), "Cover set");
      J.emit("artwork:changed", { songId: ctx.songId });
      await load();
    }
    if (act.dataset.act === "remove") {
      await J.try(() => J.del(`/api/artwork/${id}`), "Removed");
      J.emit("artwork:changed", { songId: ctx.songId });
      await load();
    }
  });

  await load();
};

J.panelYouTube = async function (panel, ctx) {
  let posts = [];

  async function load() {
    const data = await J.get(`/api/songs/${ctx.songId}/youtube`);
    posts = data.posts || [];
    draw();
  }

  function draw() {
    panel.innerHTML = `
      <div class="panel">
        <div class="section-head">
          <h3>Uploads</h3><span class="grow"></span>
          <button class="btn sm" data-act="add">Record an upload</button>
        </div>
        ${posts.length ? posts.map((post) => `
          <div class="list-row" data-post="${post.id}">
            <span class="tag ${post.status === "published" ? "accent" : ""}">${J.esc(post.status)}</span>
            <span class="grow truncate">
              <div class="truncate">${post.url
                ? `<a href="${J.esc(post.url)}" target="_blank" rel="noopener noreferrer">${J.esc(post.title || post.url)}</a>`
                : J.esc(post.title || "no link")}</div>
              <div class="faint" style="font-size:12px">
                ${post.version_n ? `from v${post.version_n}` :
                  post.version_missing ? "the version it came from has been deleted" : "no version recorded"}
                &middot; ${J.when(post.created_at)}
              </div>
            </span>
            <button class="icon-btn" data-act="edit" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M4 20h4L19 9l-4-4L4 16z" stroke="currentColor" stroke-width="1.7" fill="none" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn" data-act="remove" aria-label="Remove">
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
            </button>
          </div>`).join("")
        : `<div class="empty"><h3>Nothing recorded</h3>
             <p>J-ong does not upload for you. It remembers which render went up,
                so six versions later you still know what is online.</p></div>`}
      </div>`;
  }

  function form(post) {
    const versions = ctx.versions || [];
    return `<div class="sheet-fields">
      <label class="sheet-label">Link
        <input class="field" name="url" value="${J.esc(post ? post.url : "")}"
               placeholder="https://youtu.be/..."></label>
      <label class="sheet-label">Title
        <input class="field" name="title" value="${J.esc(post ? post.title : ctx.song.title)}"></label>
      <label class="sheet-label">Version
        <select class="field" name="version_id">
          <option value="">not recorded</option>
          ${versions.map((v) => `<option value="${v.id}"
            ${post && post.version_id === v.id ? "selected" : ""}>v${v.n}${v.label ? " " + J.esc(v.label) : ""}</option>`).join("")}
        </select></label>
      <label class="sheet-label">Status
        <select class="field" name="status">
          ${["published", "scheduled", "draft", "private", "removed"].map((s) =>
            `<option value="${s}" ${post && post.status === s ? "selected" : ""}>${s}</option>`).join("")}
        </select></label>
    </div>`;
  }

  panel.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const row = act.closest("[data-post]");
    const post = row ? posts.find((p) => String(p.id) === row.dataset.post) : null;

    if (act.dataset.act === "add" || act.dataset.act === "edit") {
      const values = await J.sheet({
        title: post ? "Edit upload" : "Record an upload",
        confirm: "Save", body: form(post),
      });
      if (!values) return;
      const payload = {
        url: values.url.trim(), title: values.title.trim(), status: values.status,
        version_id: values.version_id ? Number(values.version_id) : null,
      };
      await J.try(() => post
        ? J.patch(`/api/youtube/${post.id}`, payload)
        : J.post(`/api/songs/${ctx.songId}/youtube`, payload), "Saved");
      await load();
    }

    if (act.dataset.act === "remove" && post) {
      const sure = await J.confirm("Remove this entry?", "It only forgets the record here.", "Remove");
      if (!sure) return;
      await J.try(() => J.del(`/api/youtube/${post.id}`), "Removed");
      await load();
    }
  });

  await load();
};
