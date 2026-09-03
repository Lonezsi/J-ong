/* Renders that have arrived but have not been told what they are yet.
 *
 * A render comes out of FL knowing only the name of the project it was made from. That
 * is not the same as knowing which song it is the next version of, so it waits here
 * until it is told. Playing one before deciding is the whole point of the screen.
 */
"use strict";

J.renders = {
  /* Choose a song for a render. Resolves to the attach result, or null if nothing
   * was chosen. Used from this screen and from the song page alike. */
  async pick(render) {
    const data = await J.get("/api/songs");
    const songs = data.songs || [];
    const suggested = (render.name || "").toLowerCase();

    /* The likely answer first: a song whose title is inside the render's name, or the
     * other way round. A render called "caramel" next to a song called "Caramel" is not
     * a coincidence worth making anyone scroll for. */
    const near = songs.filter((song) => {
      const title = song.title.toLowerCase();
      return title && (suggested.includes(title) || title.includes(suggested));
    });

    const row = (song) => `
      <button class="pick-row" data-song="${song.id}">
        ${J.cover({ url: song.has_art ? `/api/songs/${song.id}/artwork` : null,
                    title: song.title, className: "cover sm" })}
        <span class="grow truncate">
          <span class="t truncate">${J.esc(song.title)}</span>
          <span class="s">${song.version_count || 0} version${song.version_count === 1 ? "" : "s"}</span>
        </span>
        <span class="pick-go">Add as v${(song.version_count || 0) + 1}</span>
      </button>`;

    const chosen = await J.sheet({
      title: `Where does ${render.name} go?`,
      sub: "It becomes the newest version of whichever song you pick.",
      wide: true,
      confirm: "",
      cancel: "Not now",
      body: `
        <button class="pick-row new" data-new="1">
          <span class="pick-plus">+</span>
          <span class="grow truncate">
            <span class="t truncate">New song called ${J.esc(render.name)}</span>
            <span class="s">This render becomes its v1</span>
          </span>
        </button>
        ${near.length ? `<div class="eyebrow" style="margin-top:var(--s4)">Looks like</div>
          ${near.map(row).join("")}` : ""}
        <div class="eyebrow" style="margin-top:var(--s4)">
          ${near.length ? "Everything else" : "Your songs"}
        </div>
        <input class="field" id="pickFind" placeholder="Find a song" autocomplete="off">
        <div class="pick-list" id="pickList">
          ${songs.length ? songs.map(row).join("")
            : `<p class="faint" style="padding:var(--s3)">No songs yet. Make one above.</p>`}
        </div>`,
      onMount(sheet, close) {
        const find = J.$("#pickFind", sheet);
        const list = J.$("#pickList", sheet);
        find.addEventListener("input", () => {
          const needle = find.value.trim().toLowerCase();
          J.$$(".pick-row", list).forEach((element) => {
            const song = songs.find((s) => String(s.id) === element.dataset.song);
            element.hidden = !!needle && !song.title.toLowerCase().includes(needle);
          });
        });
        sheet.addEventListener("click", (e) => {
          const hit = e.target.closest("[data-song], [data-new]");
          if (!hit) return;
          close(hit.dataset.new ? { fresh: true } : { song_id: Number(hit.dataset.song) });
        });
      },
    });
    if (!chosen) return null;

    return J.try(async () => {
      const body = chosen.fresh ? { title: render.name } : { song_id: chosen.song_id };
      const result = await J.post(`/api/renders/${render.id}/attach`, body);
      J.emit("renders:changed");
      J.emit("songs:changed");
      J.toast(result.already_there
        ? `${render.name} was already v${result.version.n} of ${result.song.title}.`
        : `${render.name} is now v${result.version.n} of ${result.song.title}.`);
      return result;
    });
  },

  /* The other direction: a song is open and wants one of the waiting renders.
   * Resolves to the new version, or null. */
  async pickFor(song, onUpload) {
    const data = await J.get("/api/renders");
    const waiting = data.renders || [];
    // Nothing waiting and somewhere else to go: go there rather than saying no.
    if (!waiting.length) {
      if (onUpload) { onUpload(); return null; }
      J.toast("Nothing is waiting in the renders list.");
      return null;
    }

    const chosen = await J.sheet({
      title: `Add a render to ${song.title}`,
      sub: "Anything waiting in the renders list. Play one first if you are not sure.",
      wide: true,
      confirm: "",
      cancel: "Not now",
      body: `<div class="pick-list">
        ${onUpload ? `
          <button class="pick-row new" data-upload="1">
            <span class="pick-plus">&uarr;</span>
            <span class="grow truncate">
              <span class="t truncate">Upload a file instead</span>
              <span class="s">From this computer</span>
            </span>
          </button>` : ""}
        ${waiting.map((render) => `
        <div class="pick-row" data-render="${render.id}">
          <button class="icon-btn play sm" data-hear="${render.id}"
                  aria-label="Play ${J.esc(render.name)}">
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>
          </button>
          <span class="grow truncate">
            <span class="t truncate">${J.esc(render.name)}</span>
            <span class="s">${render.duration ? J.time(render.duration) + " · " : ""}${J.bytes(render.size)}</span>
          </span>
          <span class="pick-go" data-take="${render.id}">Add</span>
        </div>`).join("")}</div>`,
      onMount(sheet, close) {
        const audio = new Audio();
        sheet.addEventListener("click", (e) => {
          if (e.target.closest("[data-upload]")) { audio.pause(); close({ upload: true }); return; }
          const hear = e.target.closest("[data-hear]");
          if (hear) {
            e.stopPropagation();
            if (audio.src.includes(`/${hear.dataset.hear}/`) && !audio.paused) {
              audio.pause();
            } else {
              audio.src = `/api/renders/${hear.dataset.hear}/audio`;
              audio.play().catch(() => {});
            }
            return;
          }
          const row = e.target.closest("[data-render]");
          if (!row) return;
          audio.pause();
          close({ id: Number(row.dataset.render) });
        });
      },
    });
    if (!chosen) return null;
    if (chosen.upload) { if (onUpload) onUpload(); return null; }

    return J.try(async () => {
      const result = await J.post(`/api/renders/${chosen.id}/attach`, { song_id: song.id });
      J.emit("renders:changed");
      J.emit("versions:changed", { songId: song.id });
      J.toast(result.already_there
        ? `Those bytes were already v${result.version.n}.`
        : `Added as v${result.version.n}.`);
      return result;
    });
  },
};

J.views.renders = {
  title: "Renders",
  async render(root) {
    let rows = [];
    let showAll = false;
    let playing = null;
    const audio = new Audio();
    audio.addEventListener("ended", () => { playing = null; draw(); });

    let shapes = {};

    async function load() {
      const data = await J.get("/api/renders" + (showAll ? "?all=1" : ""));
      rows = data.renders || [];
      draw();
      await loadShapes();
    }

    /* Fetched after the list is already on screen, and in one call rather than one per
     * song. The rows are the point; the pictures are a nicety, and fifty round trips for
     * decoration is what made the list feel slow. */
    let shapesLoaded = false;
    async function loadShapes() {
      if (shapesLoaded || !J.state.modules.includes("arrange")) return;
      shapesLoaded = true;
      try {
        const data = await J.get("/api/arrangements/shapes");
        shapes = data.shapes || {};
        if (Object.keys(shapes).length) draw();
      } catch (e) {
        shapes = {};
      }
    }

    function card(render) {
      const used = !render.waiting;
      return `
        <div class="render-row ${used ? "used" : ""}" data-id="${render.id}"
             ${used ? "" : 'data-act="attach" role="button" tabindex="0"'}
             ${used ? "" : `aria-label="Add ${J.esc(render.name)} to a song"`}>
          <button class="icon-btn play" data-act="play" aria-label="Play ${J.esc(render.name)}">
            ${playing === render.id
              ? `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 6h3v12H8zM13 6h3v12h-3z" fill="currentColor"/></svg>`
              : `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>`}
          </button>
          <span class="grow truncate">
            <span class="render-name truncate" data-act="rename" title="Click to rename"
              >${J.esc(render.name)}</span>
            <span class="s truncate">
              ${render.duration ? J.time(render.duration) + " · " : ""}${J.bytes(render.size)}
              ${render.origin === "fl" || render.origin === "import"
                ? ` · ${J.esc(render.ext.replace(".", "").toUpperCase())}` : ""}
              ${used ? ` · went to <b>${J.esc(render.song_title || "a song")}</b>` : ""}
            </span>
          </span>
          ${used
            ? `<button class="btn sm ghost" data-act="unattach">Put back</button>`
            : `<span class="row-go">Add to a song</span>`}
          <button class="icon-btn" data-act="dismiss" aria-label="Throw this render away">
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
          </button>
          ${shape(render)}
        </div>`;
    }

    /* The shape of the arrangement this render ended up in, if it is in one.
     *
     * Read only on purpose. It is here so a render is recognisable at a glance, the way
     * you know a song by the shape of its sections, and reaching in to edit an
     * arrangement from a list of loose files would be the wrong place to do it. */
    function shape(render) {
      const parts = shapes[render.song_id];
      if (!parts || !parts.length) return "";
      return `<div class="render-shape" aria-hidden="true">${parts.map((part) => `
        <span class="seg" style="--grow:${Math.max(1, part.beats)};--hue:${part.hue}"></span>
      `).join("")}</div>`;
    }

    function draw() {
      const waiting = rows.filter((r) => r.waiting).length;
      root.innerHTML = `
        <div class="section">
          <div class="section-head">
            <h2>Renders</h2>
            ${waiting ? `<span class="tag accent">${waiting} waiting</span>` : ""}
            <span class="grow"></span>
            <button class="btn sm ghost" data-act="ingest">Take in a folder</button>
            <button class="btn sm ghost" data-act="toggle">
              ${showAll ? "Only waiting" : "Show used"}
            </button>
          </div>

          ${rows.length ? rows.map(card).join("") : `
            <div class="empty">
              <h3>Nothing waiting</h3>
              <p>Renders land here first, keeping the name of the project they came out
                 of, and wait until you say which song they belong to. Right click an FL
                 project and choose Render and send to J-ong, or take in a folder that is
                 already full of them.</p>
              <button class="btn primary" data-act="ingest" style="margin-top:var(--s4)">
                Take in a folder
              </button>
            </div>`}
        </div>`;
    }

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest('.render-row[role="button"]');
      if (!row) return;
      e.preventDefault();
      row.click();
    });

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const holder = act.closest("[data-id]");
      const render = holder && rows.find((r) => String(r.id) === holder.dataset.id);

      if (act.dataset.act === "toggle") { showAll = !showAll; return load(); }

      if (act.dataset.act === "ingest") {
        const fields = await J.sheet({
          title: "Take in a folder of renders",
          sub: "A path on the machine J-ong is running on. Nothing in it is moved or changed.",
          confirm: "Take them in",
          body: `<input class="field" name="path" placeholder="C:\\Users\\you\\Renders">`,
        });
        if (!fields || !fields.path.trim()) return;
        return J.try(async () => {
          const result = await J.post("/api/renders/ingest",
                                      { path: fields.path.trim(), origin: "import" });
          J.toast(result.count
            ? `${result.count} render${result.count === 1 ? "" : "s"} taken in.`
            : `Nothing new. All ${result.looked_at} were already here.`);
          J.emit("renders:changed");
          await load();
        });
      }

      if (!render) return;

      if (act.dataset.act === "play") {
        if (playing === render.id) { audio.pause(); playing = null; return draw(); }
        audio.src = `/api/renders/${render.id}/audio`;
        audio.play().catch(() => J.toast("That render would not play.", "bad"));
        playing = render.id;
        return draw();
      }

      if (act.dataset.act === "rename") {
        const fields = await J.sheet({
          title: "Rename this render",
          confirm: "Rename",
          body: `<input class="field" name="name" value="${J.esc(render.name)}">`,
        });
        if (!fields || !fields.name.trim()) return;
        return J.try(async () => {
          await J.patch(`/api/renders/${render.id}`, { name: fields.name.trim() });
          await load();
        });
      }

      if (act.dataset.act === "attach") {
        const result = await J.renders.pick(render);
        if (result) await load();
        return;
      }

      if (act.dataset.act === "unattach") {
        return J.try(async () => {
          await J.post(`/api/renders/${render.id}/unattach`);
          J.emit("renders:changed");
          await load();
        });
      }

      if (act.dataset.act === "dismiss") {
        const sure = await J.confirm(
          `Throw away ${render.name}?`,
          render.waiting
            ? "The audio goes with it. This cannot be undone."
            : "The version it made stays where it is. Only this entry goes.",
          "Throw it away");
        if (!sure) return;
        return J.try(async () => {
          await J.del(`/api/renders/${render.id}`);
          J.emit("renders:changed");
          await load();
        });
      }
    });

    await load();
  },
};
