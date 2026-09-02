/* Watched folders: where renders land, and what is in them that J-ong has not seen.
 *
 * A scan never imports anything. It reports what it found and what each file looks like
 * a new render of, and you say yes.
 */
"use strict";

J.views.sync = {
  title: "Folders",
  async render(root) {
    let folders = [];
    let candidates = [];
    let scanning = false;
    let summary = null;

    async function loadFolders() {
      const data = await J.get("/api/sync/folders");
      folders = data.folders || [];
      draw();
    }

    function draw() {
      root.innerHTML = `
        <div class="section">
          <div class="section-head">
            <h2>Watched folders</h2><span class="grow"></span>
            <button class="btn sm ghost" data-act="add">Add folder</button>
            <button class="btn sm primary" data-act="scan" ${folders.length ? "" : "disabled"}>
              ${scanning ? "Scanning…" : "Scan now"}
            </button>
          </div>

          ${folders.length ? folders.map((folder) => `
            <div class="list-row" data-folder="${folder.id}">
              <button class="switch ${folder.enabled ? "on" : ""}" data-act="toggle"
                      aria-label="Watch this folder"></button>
              <span class="grow truncate">
                <div class="truncate" style="font-weight:600">${J.esc(folder.path)}</div>
                <div class="faint" style="font-size:12px">
                  ${folder.last_scan ? `last scanned ${J.when(folder.last_scan)}` : "not scanned yet"}
                </div>
              </span>
              <button class="icon-btn" data-act="remove" aria-label="Stop watching">
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
              </button>
            </div>`).join("")
          : `<div class="empty">
               <h3>No folders watched yet</h3>
               <p>Point J-ong at the folder your exports land in. It reads them, it never
                  writes to them.</p>
               <button class="btn primary" data-act="add" style="margin-top:var(--s4)">Add a folder</button>
             </div>`}
        </div>

        ${summary ? `
          <div class="section">
            <div class="section-head">
              <h2>New files</h2><span class="grow"></span>
              <span class="faint">${summary.already_have} already in the library</span>
            </div>
            ${summary.errors && summary.errors.length ? summary.errors.map((err) => `
              <div class="list-row"><span class="tag warn">problem</span>
                <span class="grow truncate">${J.esc(err.path)}<div class="faint" style="font-size:12px">${J.esc(err.why)}</div></span>
              </div>`).join("") : ""}
            ${candidates.length ? candidates.map((c) => `
              <div class="candidate" data-path="${J.esc(c.path)}">
                <span class="grow truncate">
                  <span class="name truncate">${J.esc(c.name)}</span>
                  <span class="path truncate">${J.esc(c.path)}</span>
                  <span class="path">${J.bytes(c.size)}${c.duration ? " &middot; " + J.time(c.duration) : ""}${
                    c.bitrate ? " &middot; " + c.bitrate + " kbps" : ""}</span>
                </span>
                ${c.suggest
                  ? `<button class="btn sm primary" data-act="import" data-song="${c.suggest.song_id}">
                       New render of ${J.esc(c.suggest.title)}</button>`
                  : ""}
                <button class="btn sm ${c.suggest ? "ghost" : "primary"}" data-act="import-new">
                  ${c.suggest ? "New song" : "Import as new song"}
                </button>
              </div>`).join("")
            : `<div class="empty"><h3>Nothing new</h3>
                 <p>Every audio file in those folders is already in the library.</p></div>`}
          </div>` : ""}`;
    }

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;
      const folderRow = act.closest("[data-folder]");
      const candidateRow = act.closest("[data-path]");

      if (what === "add") {
        const values = await J.sheet({
          title: "Watch a folder",
          sub: "The full path on the machine running J-ong. It is only ever read.",
          confirm: "Watch it",
          body: `<div class="sheet-fields"><label class="sheet-label">Folder
            <input class="field" name="path" placeholder="C:\\Users\\you\\Music\\Renders"></label></div>`,
        });
        if (!values || !values.path.trim()) return;
        const made = await J.try(() => J.post("/api/sync/folders", { path: values.path.trim() }));
        if (made) J.toast(made.added ? "Watching that folder" : "Already watching that one");
        await loadFolders();
      }

      if (what === "toggle" && folderRow) {
        const folder = folders.find((f) => String(f.id) === folderRow.dataset.folder);
        await J.try(() => J.patch(`/api/sync/folders/${folder.id}`, { enabled: !folder.enabled }));
        await loadFolders();
      }

      if (what === "remove" && folderRow) {
        await J.try(() => J.del(`/api/sync/folders/${folderRow.dataset.folder}`), "Stopped watching");
        await loadFolders();
      }

      if (what === "scan") {
        scanning = true;
        draw();
        const data = await J.try(() => J.post("/api/sync/scan"));
        scanning = false;
        if (data) {
          summary = data;
          candidates = data.candidates || [];
          J.toast(`${candidates.length} new file${candidates.length === 1 ? "" : "s"}`);
        }
        draw();
      }

      if ((what === "import" || what === "import-new") && candidateRow) {
        const path = candidateRow.dataset.path;
        const payload = { path };
        if (what === "import") payload.song_id = Number(act.dataset.song);
        const result = await J.try(() => J.post("/api/sync/import", payload));
        if (!result) return;
        J.toast(result.duplicate
          ? "Already in the library"
          : `${result.song.title} is now v${result.version.n}`);
        candidates = candidates.filter((c) => c.path !== path);
        J.emit("songs:changed");
        draw();
      }
    });

    await loadFolders();
  },
};

J.views.settings = {
  title: "Settings",
  async render(root) {
    const state = await J.get("/api/state");
    let update = null;

    function draw() {
      root.innerHTML = `
        <div class="section">
          <div class="section-head"><h2>Library</h2></div>
          <div class="sheet-fields" style="max-width:440px">
            <label class="sheet-label">Name
              <input class="field" id="libName" value="${J.esc(state.settings.library_name)}"></label>
            <label class="sheet-label">Accent colour
              <input class="field" id="accent" type="color" value="${J.esc(state.settings.accent)}"
                     style="height:44px;padding:4px"></label>
            <div><button class="btn primary sm" data-act="save-settings">Save</button></div>
          </div>
        </div>

        <div class="section">
          <div class="section-head"><h2>Storage</h2></div>
          <div class="list-row">
            <span class="grow">
              <div style="font-weight:600">${J.bytes(state.storage.bytes)} in ${state.storage.files} files</div>
              <div class="faint" style="font-size:12px">
                Files are stored once by their contents, so the same render uploaded twice
                takes one slot.
              </div>
            </span>
          </div>
          ${state.summary && state.summary.versions ? `
            <div class="list-row"><span class="grow">
              <div style="font-weight:600">${state.summary.versions.count} versions,
                ${state.summary.versions.distinct_files} distinct files</div>
              <div class="faint" style="font-size:12px">The gap is what deduplication saved you.</div>
            </span></div>` : ""}
        </div>

        <div class="section">
          <div class="section-head"><h2>Updates</h2><span class="grow"></span>
            <button class="btn sm" data-act="check">Check for updates</button></div>
          ${update ? `
            <div class="list-row">
              <span class="tag ${update.update_available ? "accent" : ""}">
                ${update.checked ? (update.update_available ? "update ready" : "up to date") : "cannot tell"}
              </span>
              <span class="grow truncate">
                <div class="truncate">${J.esc(update.message || update.why || "")}</div>
                <div class="faint" style="font-size:12px">
                  ${update.local ? `here ${update.local.slice(0, 7)}` : ""}
                  ${update.remote ? ` &middot; github ${update.remote.slice(0, 7)}` : ""}
                </div>
              </span>
              ${update.can_update
                ? '<button class="btn sm primary" data-act="apply">Update now</button>' : ""}
            </div>` : '<p class="faint">Not checked yet.</p>'}
        </div>

        <div class="section">
          <div class="section-head"><h2>Password</h2></div>
          <p class="faint" style="margin-top:0">
            Any password is accepted, however short. Guessing is limited to a few tries
            before that address has to wait, which is what makes a short one safe enough.
          </p>
          <div class="row wrap">
            <button class="btn sm" data-act="change-password">Change password</button>
            <button class="btn ghost sm" data-act="sign-out">Sign out</button>
          </div>
        </div>

        <div class="section">
          <div class="section-head"><h2>Modules</h2></div>
          <p class="faint" style="margin-top:0">
            Each feature is a module. Removing one from the MODULES list in jong/config.py
            takes it out of the server and out of this interface.
          </p>
          <div class="pills">
            ${state.modules.map((m) => `<span class="tag accent">${J.esc(m)}</span>`).join("")}
            ${Object.keys(state.failed || {}).map((m) =>
              `<span class="tag warn">${J.esc(m)} failed</span>`).join("")}
          </div>
        </div>`;
    }

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;

      if (act.dataset.act === "save-settings") {
        const patch = {
          library_name: J.$("#libName", root).value.trim() || "J-ong",
          accent: J.$("#accent", root).value,
        };
        const saved = await J.try(() => J.put("/api/settings", patch), "Saved");
        if (saved) {
          state.settings = saved;
          J.applyAccent(saved.accent);
          J.emit("settings:changed");
        }
      }

      if (act.dataset.act === "sign-out") {
        await J.try(() => J.post("/api/auth/logout"));
        location.href = "/login";
      }

      if (act.dataset.act === "change-password") {
        const values = await J.sheet({
          title: "Change password",
          sub: "Anything you like. Every signed in device is signed out when it changes.",
          confirm: "Change it",
          body: `<div class="sheet-fields">
            <label class="sheet-label">Current password
              <input class="field" name="current" type="password" autocomplete="current-password"></label>
            <label class="sheet-label">New password
              <input class="field" name="next" type="password" autocomplete="new-password"></label>
          </div>`,
        });
        if (!values) return;
        const done = await J.try(() => J.post("/api/auth/password", {
          current: values.current, new: values.next }));
        if (done) J.toast("Password changed. Other devices will have to sign in again.");
      }

      if (act.dataset.act === "check") {
        update = await J.try(() => J.get("/api/update/check"));
        draw();
      }

      if (act.dataset.act === "apply") {
        const result = await J.try(() => J.post("/api/update/apply"));
        if (!result) return;
        J.toast(result.message);
        update = null;
        draw();
        if (result.restart_required) {
          await J.sheet({
            title: "Restart J-ong",
            sub: "The new code is on disk. Python is still running the old version in memory, "
               + "so stop the server and start it again to pick it up.",
            confirm: "", cancel: "Got it",
          });
        }
      }
    });

    draw();
  },
};
