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
      // A song that has just been brought into existence is somewhere to go. One that
      // already existed is not: filing a render against it is a thing you do while
      // working down the renders list, and being thrown out of that list each time
      // would make filing three renders in a row impossible.
      if (chosen.fresh && result.song) location.hash = `#/song/${result.song.id}`;
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

/* What this list can be put in order by.
 *
 * Newest first is the default because the reason you are on this screen is almost always
 * the thing you just bounced. Project date is the .flp's own age, which groups a night's
 * work together however many times it was re-rendered since. */
const SORTS = [
  { key: "arrived", label: "Newest first", dir: "down", numeric: true,
    by: (r) => r.created_at },
  { key: "rendered", label: "When it was rendered", dir: "down", numeric: true,
    by: (r) => r.rendered_at || r.created_at },
  { key: "project", label: "When the project was made", dir: "down", numeric: true,
    by: (r) => r.project_at },
  { key: "name", label: "Name", dir: "up", by: (r) => r.name },
  { key: "length", label: "Length", dir: "down", numeric: true, by: (r) => r.duration },
  { key: "size", label: "Size", dir: "down", numeric: true, by: (r) => r.size },
];

J.views.renders = {
  title: "Renders",
  async render(root) {
    let rows = [];
    let showAll = false;
    /* Renaming, reachable from the menu as well as from a control, so there is one
     * implementation of it rather than a menu item pressing a button that may not be
     * on the row any more. */
    async function renameRender(render) {
      const fields = await J.sheet({
        title: "Rename this render",
        sub: "Only what it is called here. The file keeps its own name.",
        confirm: "Rename",
        body: `<input class="field" name="name" value="${J.esc(render.name)}">`,
      });
      if (!fields || !fields.name.trim()) return null;
      return J.try(async () => {
        await J.patch(`/api/renders/${render.id}`, { name: fields.name.trim() });
        await load();
      });
    }

    /* Whether a row is the one sounding is the player's business now, not a flag kept
     * here that could disagree with it. */
    const isSounding = (render) => !!(J.player.state.song
      && J.player.state.song.id === `render:${render.id}`);

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

    /* When it was made, and when the project behind it was.
     *
     * Its own line rather than appended to the size and format, because that line is
     * marked truncate and anything added to the end of it is the first thing to be
     * clipped. A render only has these if it came through the FL client or was taken in
     * from a folder with the project still beside it, so the line is absent rather than
     * showing a blank where a date should be. Zero is how "not known" is spelled
     * everywhere in this library, and J.when draws nothing for it. */
    function dates(render) {
      const bits = [];
      if (render.rendered_at) {
        bits.push(`<span title="When this audio was rendered">rendered ${
          J.esc(J.when(render.rendered_at))}</span>`);
      }
      if (render.project_at) {
        bits.push(`<span title="When the project it came out of was made">project ${
          J.esc(J.when(render.project_at))}</span>`);
      }
      if (!bits.length) return "";
      return `<span class="render-dates">${bits.join('<span class="dot"></span>')}</span>`;
    }

    function card(render) {
      const used = !render.waiting;
      return `
        <div class="render-row ${used ? "used" : ""}" data-id="${render.id}"
             ${used ? "" : 'data-act="attach" role="button" tabindex="0"'}
             ${used ? "" : `aria-label="Add ${J.esc(render.name)} to a song"`}>
          <button class="render-art" data-act="makesong"
                  title="Make a song from ${J.esc(render.name)}"
                  aria-label="Make a song from ${J.esc(render.name)}">
            ${J.cover({ title: render.name, className: "cover" })}
          </button>
          <button class="icon-btn play" data-act="play" aria-label="Play ${J.esc(render.name)}">
            ${J.player.state.playing && isSounding(render)
              ? `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 6h3v12H8zM13 6h3v12h-3z" fill="currentColor"/></svg>`
              : `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/></svg>`}
          </button>
          <span class="grow truncate">
            <span class="render-name truncate" data-act="makesong"
                  title="Make a song from this render"
              >${J.esc(render.name)}</span>
            <span class="s truncate">
              ${render.duration ? J.time(render.duration) + " · " : ""}${J.bytes(render.size)}
              ${render.origin === "fl" || render.origin === "import"
                ? ` · ${J.esc(render.ext.replace(".", "").toUpperCase())}` : ""}
              ${used ? ` · went to <b>${J.esc(render.song_title || "a song")}</b>` : ""}
            </span>
            ${dates(render)}
          </span>
          ${used
            ? `<button class="btn sm ghost" data-act="unattach">Put back</button>`
            : `<span class="row-go">Add to a song</span>`}
          ${J.state.modules.includes("playlists") ? `
            <button class="icon-btn" data-act="playlist"
                    title="Add ${J.esc(render.name)} to a playlist"
                    aria-label="Add ${J.esc(render.name)} to a playlist">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"
                   stroke-width="1.9" stroke-linecap="round"><path d="M4 7h11M4 12h11M4 17h7"/><path d="M17 14v6M14 17h6"/></svg>
            </button>` : ""}
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
            ${J.sort.control("renders", SORTS)}
            <button class="btn sm ghost" data-act="ingest">Take in a folder</button>
            <button class="btn sm ghost" data-act="toggle">
              ${showAll ? "Only waiting" : "Show used"}
            </button>
          </div>

          ${rows.length ? J.sort.apply(rows, "renders", SORTS).map(card).join("") : `
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

    /* Right clicking a render. The row itself adds it to a song; everything else it
     * can do lives here rather than as four more buttons on every row. */
    J.menu.on(root, ".render-row", (node) => {
      const render = rows.find((r) => String(r.id) === node.dataset.id);
      if (!render) return null;
      return [
        { label: isSounding(render) && J.player.state.playing ? "Pause" : "Play",
          icon: "play",
          run: () => node.querySelector('[data-act="play"]').click() },
        render.waiting
          ? { label: "Add to a song", icon: "add", hint: "Click",
              run: async () => { if (await J.renders.pick(render)) load(); } }
          : { label: `Put back${render.song_title ? " from " + render.song_title : ""}`,
              icon: "open",
              run: () => node.querySelector('[data-act="unattach"]').click() },
        { divider: true },
        { label: "Make a song from it", icon: "add",
          run: () => node.querySelector('[data-act="makesong"]').click() },
        { label: "Rename", icon: "edit", run: () => renameRender(render) },
        J.state.modules.includes("playlists") ? {
          label: "Add to a playlist", icon: "tag",
          run: () => J.addToPlaylist({ kind: "render", id: render.id, title: render.name }),
        } : null,
        { label: "Download", icon: "down",
          run: () => window.open(`/api/renders/${render.id}/audio`, "_blank") },
        render.source_path
          ? { label: "Copy where it came from", icon: "copy",
              run: async () => {
                try {
                  await navigator.clipboard.writeText(render.source_path);
                  J.toast("Path copied.");
                } catch (e) { J.toast(render.source_path); }
              } }
          : null,
        { divider: true },
        { label: "Throw away", icon: "drop", danger: true,
          run: () => node.querySelector('[data-act="dismiss"]').click() },
      ];
    });

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const row = e.target.closest('.render-row[role="button"]');
      // Only when the row itself has focus. It holds four buttons of its own, and
      // pressing Enter on Play or on Throw away used to open the "where does this go"
      // sheet instead of playing or throwing away.
      if (!row || e.target !== row) return;
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
        /* Through the player, so a render appears in the bar with the transport, the
         * scrubber and the volume, like everything else that makes a sound here. It
         * used to be a bare Audio element with no way to pause it except this button
         * and no way to see where you were. */
        // In the order they are on screen, not the order they arrived. What plays next
        // should be the row underneath the one you pressed.
        const queue = J.sort.apply(rows, "renders", SORTS).filter((r) => r.waiting);
        if (J.player.state.song && J.player.state.song.id === `render:${render.id}`) {
          J.player.toggle();
        } else {
          await J.player.playRender(render, queue);
        }
        return draw();
      }

      if (act.dataset.act === "makesong") {
        const fields = await J.sheet({
          title: "Make a song from this render",
          sub: "The render becomes its first version. It keeps its own name in the list.",
          confirm: "Make the song",
          body: `<input class="field" name="title" value="${J.esc(render.name)}">`,
        });
        if (!fields || !fields.title.trim()) return;
        return J.try(async () => {
          const made = await J.post(`/api/renders/${render.id}/attach`,
                                    { title: fields.title.trim() });
          J.emit("renders:changed");
          J.emit("songs:changed");
          J.toast(`${made.song.title} made, with this as v${made.version.n}.`);
          location.hash = `#/song/${made.song.id}`;
        });
      }

      if (act.dataset.act === "playlist") {
        return J.addToPlaylist({ kind: "render", id: render.id, title: render.name });
      }

      if (act.dataset.act === "rename") return renameRender(render);

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

    /* Redraw when the player changes, so the row that is sounding shows a pause and the
     * others do not, however playback was started or stopped. */
    J.on("player:change", function follow() {
      if (!root.isConnected) { J.bus.removeEventListener("player:change", follow); return; }
      draw();
    });

    J.sort.wire(root, "renders", SORTS, draw);

    await load();
  },
};
