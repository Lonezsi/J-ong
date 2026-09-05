/* Putting a song on YouTube: the sound, the cut, the words, the account.
 *
 * Its own page rather than a block, because this is the one thing in the app that leaves
 * the building. Everything else is reversible and private; a video is neither.
 *
 * The equaliser, the limiter and the arrangement are here, live, not summarised. Sending
 * a mix somewhere is the moment you most want to hear it once more and move one band,
 * and a page that only let you pick a preset by name would send you back to the song to
 * do it and then back here having forgotten what you changed. They are the same
 * components the song page mounts, editing the same preset and the same arrangement, so
 * a change made here is a change made there. A second copy of the curve editor that
 * agreed until it did not would be worse than having none.
 *
 * The file is rendered from exactly what is on screen. J.bounce shares its chain with
 * the player, so what goes out is what you approved.
 */
"use strict";

J.views.youtube = {
  title: "Upload to YouTube",
  async render(root, params) {
    const songId = Number(params.id);
    let ctx = null;
    let account = null;
    let bounced = null;            // { buffer, blob, peak, seconds }
    let working = false;
    let editor = null;
    let limiterView = null;
    let chosenPresetId = null;

    /* Three options, and which one is chosen decides who can see this for as long as it
     * exists. A dropdown shows one and hides the consequence of the other two behind a
     * press; three pills show all three at once. */
    const PRIVACY = [
      { key: "private", label: "Private", note: "only you" },
      { key: "unlisted", label: "Unlisted", note: "anyone with the link" },
      { key: "public", label: "Public", note: "listed and searchable" },
    ];
    let privacy = "private";

    async function load() {
      const [song, versions, sound, art, connected] = await Promise.all([
        J.get(`/api/songs/${songId}`),
        J.get(`/api/songs/${songId}/versions`),
        J.get(`/api/songs/${songId}/sound`).catch(() => ({ presets: [] })),
        J.get(`/api/songs/${songId}/artwork`).catch(() => ({ artwork: [] })),
        J.get("/api/youtube/account").catch(() => ({ accounts: [], chosen: null })),
      ]);
      const list = versions.versions || [];
      ctx = {
        song: song.song,
        songId,
        versions: list,
        presets: sound.presets || [],
        artwork: art.artwork || [],
        current: list.find((v) => v.id === song.song.current_version_id) || list[0],
        has: (name) => J.state.modules.includes(name),
        currentVersion() { return this.current; },
      };
      const current = ctx.presets.find((p) => p.is_current) || ctx.presets[0];
      chosenPresetId = current ? current.id : null;
      account = connected;

      // The arrangement, so the compositor has something to draw and the bounce has
      // something to lay out.
      if (ctx.has("arrange")) {
        const arrangement = await J.get(`/api/songs/${songId}/arrangement`).catch(() => ({}));
        J.arrange.adopt(songId, arrangement.arrangement);
      }
      draw();
    }

    const chosenPreset = () =>
      ctx.presets.find((p) => p.id === chosenPresetId) || ctx.presets[0] || null;

    const wantsArrangement = () => {
      const box = J.$("#ytArranged", root);
      return box ? box.checked : false;
    };

    // ── what is about to happen ──────────────────────────────────────────────

    function paintSummary() {
      const node = J.$("#ytSummary", root);
      if (!node) return;
      const preset = chosenPreset();
      const bands = preset && !preset.data.bypass
        ? (preset.data.bands || []).filter((b) => b.on).length : 0;
      const limiter = !!(preset && !preset.data.bypass && (preset.data.limiter || {}).on);
      const arranged = wantsArrangement();
      const seconds = arranged && J.arrange && J.arrange.state.songId === songId
        ? J.arrange.duration()
        : (ctx.current ? ctx.current.duration || 0 : 0);

      node.innerHTML = `
        <span><b>v${ctx.current ? ctx.current.n : "?"}</b></span>
        <span class="dot"></span>
        <span>${bands ? `${bands} band${bands === 1 ? "" : "s"}` : "flat"}</span>
        <span class="dot"></span>
        <span>${limiter ? "limiter on" : "no limiter"}</span>
        <span class="dot"></span>
        <span>${arranged ? "as arranged" : "the whole take"}</span>
        ${seconds ? `<span class="dot"></span><span>${J.time(seconds)}</span>` : ""}`;
    }

    // ── the sound, live ──────────────────────────────────────────────────────

    function paintPresetRow() {
      const row = J.$("#ytPresetRow", root);
      if (!row) return;
      row.innerHTML = ctx.presets.map((p) => `
        <button class="sheet-tab ${p.id === chosenPresetId ? "on" : ""}"
                data-preset="${p.id}">${J.esc(p.name)}</button>`).join("");
    }

    function paintChrome() {
      const preset = chosenPreset();
      if (!preset) return;
      const pill = J.$("#ytBypass", root);
      if (pill) {
        pill.textContent = preset.data.bypass ? "Bypassed" : "Bypass";
        pill.classList.toggle("on", !!preset.data.bypass);
        pill.classList.toggle("quiet", !preset.data.bypass);
      }
      const sw = J.$("#ytLimiterSwitch", root);
      if (sw) sw.classList.toggle("on", !!(preset.data.limiter || {}).on);
      const nums = J.$("#ytLimiterNums", root);
      if (nums) {
        const lim = preset.data.limiter || {};
        nums.textContent = `thr ${(lim.threshold || 0).toFixed(1)} `
          + `· ceil ${(lim.ceiling || 0).toFixed(1)} `
          + `· gain ${(preset.data.gain || 0).toFixed(1)}`;
      }
      paintSummary();
    }

    /* The same components the song page mounts, on the same preset. */
    function mountSound() {
      const preset = chosenPreset();
      if (!preset) return;
      paintPresetRow();

      if (editor) editor.stop();
      editor = J.eq.create(J.$("#ytEqCanvas", root), {
        data: preset.data,
        onChange: (data) => { preset.data = data; savePreset(preset); stale(); paintChrome(); },
        onSelect: () => {},
        onFrame: () => {},
      });
      editor.start();

      if (limiterView) limiterView.stop();
      limiterView = J.limiter.create(J.$("#ytLimiterCanvas", root), {
        data: preset.data,
        reduction: () => 0,
        level: () => -60,
        onChange: (data) => { preset.data = data; savePreset(preset); stale(); paintChrome(); },
      });
      limiterView.start();
      paintChrome();
    }

    let comp = null;

    /* Only for a song that already has an arrangement.
     *
     * J.compositor.mount lays one out when it finds none, which means detecting the
     * tempo, decoding the whole render and saving the result. On the song page that is
     * what you asked for by opening the drawer. Here it would happen merely by visiting,
     * and would write an arrangement onto a song that never had one. Opening a page to
     * look at something must not change it.
     *
     * Its ticker is kept and stopped, too: mount() returns a stop() and starts a 60ms
     * interval, and draw() runs again on every account pick and preset change. */
    function mountArrangement() {
      if (comp && comp.stop) comp.stop();
      comp = null;
      const node = J.$("#ytComp", root);
      if (!node || !J.compositor) return;
      if (!J.arrange || J.arrange.state.songId !== songId || !J.arrange.state.clips.length) {
        node.innerHTML = `<p class="faint yt-nocomp">This song has not been laid out yet.
          Open it on the song page and press Arrange to cut it into sections; what you do
          there shows up here.</p>`;
        return;
      }
      comp = J.compositor.mount(node, ctx);
    }

    const savePreset = J.debounce((preset) => {
      J.try(() => J.put(`/api/sound/${preset.id}`, { data: preset.data }));
      // The player may be holding this preset, so it hears the change as it is made.
      if (J.player && J.player.presetEdited) J.player.presetEdited(preset.id, preset.data);
    }, 500);

    function freeAudition() {
      if (bounced && bounced.url) URL.revokeObjectURL(bounced.url);
    }

    /* Anything rendered before an edit is no longer what the form describes. */
    function stale() {
      if (!bounced) return;
      freeAudition();
      bounced = null;
      const result = J.$("#ytResult", root);
      if (result) { result.hidden = true; result.innerHTML = ""; }
    }

    // ── making the file ──────────────────────────────────────────────────────

    async function makeTheFile() {
      if (working) return;
      working = true;
      const status = J.$("#ytStatus", root);
      const bar = J.$("#ytBar span", root);
      const button = J.$('[data-act="render"]', root);
      button.disabled = true;
      J.$("#ytProgress", root).hidden = false;

      try {
        const buffer = await J.bounce.render(ctx, {
          preset: chosenPreset(),
          arranged: wantsArrangement(),
          onProgress: (what, at) => {
            status.textContent = what;
            if (bar) bar.style.width = `${Math.round(at * 100)}%`;
          },
        });
        freeAudition();
        const blob = J.bounce.toWav(buffer);
        bounced = {
          buffer,
          blob,
          // Held so it can be given back. A rendered wav is tens of megabytes and this
          // page invites you to render again after every change to the curve; without
          // this, each one stays in memory until the tab closes.
          url: URL.createObjectURL(blob),
          peak: J.bounce.peakOf(buffer),
          seconds: buffer.duration,
        };
        status.textContent = "ready";
        drawResult();
      } catch (e) {
        status.textContent = "";
        J.toast(`That did not render: ${e.message}`, "bad");
      } finally {
        working = false;
        button.disabled = false;
      }
    }

    function drawResult() {
      const node = J.$("#ytResult", root);
      if (!node || !bounced) return;
      const clipping = bounced.peak > -0.1;
      node.hidden = false;
      node.innerHTML = `
        <div class="yt-made ${clipping ? "hot" : ""}">
          <div class="yt-made-head">
            <b>${clipping ? "It clips" : "Rendered"}</b>
            <span class="grow"></span>
            <span class="yt-peak">peak ${bounced.peak.toFixed(1)} dB</span>
          </div>
          ${clipping ? `<p class="yt-warn">The loudest moment is
            ${bounced.peak.toFixed(1)}&nbsp;dB, which is above what a file can hold, so it
            has been flattened at the top. Turn the limiter on, or pull the gain down by
            about ${Math.ceil(bounced.peak)}&nbsp;dB, and render again.</p>` : ""}
          <audio class="yt-audition" controls src="${bounced.url}"></audio>
          <div class="row wrap">
            <button class="btn sm ghost" data-act="download">Save the file</button>
            <span class="faint">${J.bytes(bounced.blob.size)} &middot; ${J.time(bounced.seconds)}</span>
          </div>
        </div>`;
    }

    // ── the account ──────────────────────────────────────────────────────────

    /* What connecting involves, said plainly rather than behind a button that fails.
     * Uploading acts as you, so it needs an OAuth client that belongs to you: there is
     * no way for an app to ship one. */
    function drawConnect() {
      const node = J.$("#ytConnect", root);
      if (!node) return;
      node.hidden = false;
      node.innerHTML = `
        <ol class="yt-steps">
          <li>Make a project at <a href="https://console.cloud.google.com/" target="_blank"
              rel="noopener noreferrer">console.cloud.google.com</a> and switch on the
              <b>YouTube Data API v3</b>.</li>
          <li>Under Credentials, make an <b>OAuth client ID</b> of type <b>TV and Limited
              Input</b>. That kind needs no redirect address, which is what lets this work
              on a machine reached over a tunnel.</li>
          <li>Paste the two values below. They are stored on your own server, beside the
              library rather than in it, and go nowhere except Google.</li>
        </ol>
        <label class="sheet-label">A name for this account
          <input class="field" id="ytAccountName" autocomplete="off"
                 placeholder="my channel"></label>
        <label class="sheet-label">Client ID
          <input class="field" id="ytClientId" autocomplete="off"
                 placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"></label>
        <label class="sheet-label">Client secret
          <input class="field" id="ytClientSecret" type="password" autocomplete="off"></label>
        <div class="row wrap">
          <button class="btn sm primary" data-act="connect">Connect</button>
          ${(account.accounts || []).length
            ? '<button class="btn sm ghost" data-act="cancel-connect">Never mind</button>' : ""}
        </div>
        <p class="faint yt-note">Google restricts uploads from an app it has not audited:
          until yours is reviewed, everything it uploads stays <b>private</b> whatever you
          choose above. That is Google's rule, not J-ong's.</p>`;
    }

    async function connect() {
      const id = J.$("#ytClientId", root).value.trim();
      const secret = J.$("#ytClientSecret", root).value.trim();
      const name = J.$("#ytAccountName", root).value.trim();
      if (!id || !secret) { J.toast("Both values are needed.", "bad"); return; }

      const started = await J.try(() => J.post("/api/youtube/connect", {
        client_id: id, client_secret: secret, name,
      }));
      if (!started) return;

      const done = await J.sheet({
        title: "Sign in to YouTube",
        sub: "On any device with a browser signed into the right channel.",
        confirm: "I have done it",
        cancel: "Stop",
        body: `<div class="yt-code">
          <p>Open <a href="${J.esc(started.verification_url)}" target="_blank"
             rel="noopener noreferrer">${J.esc(started.verification_url)}</a> and enter:</p>
          <p class="yt-usercode">${J.esc(started.user_code)}</p>
          <p class="faint">This page waits. The code lasts
            ${Math.round((started.expires_in || 900) / 60)} minutes.</p>
        </div>`,
      });
      if (!done) return;

      const finished = await J.try(() => J.post("/api/youtube/finish", {}));
      if (!finished) return;
      J.toast(`Connected as ${finished.channel || "your channel"}.`);
      await load();
    }

    // ── the page ─────────────────────────────────────────────────────────────

    function draw() {
      const cover = ctx.artwork.length ? `/api/artwork/${ctx.artwork[0].id}/image` : null;
      const accounts = (account && account.accounts) || [];
      const arranged = J.arrange && J.arrange.state.songId === songId
                       && J.arrange.state.clips.length;

      root.innerHTML = `
        <div class="section">
          <div class="section-head">
            <a class="btn sm ghost" href="#/song/${songId}" data-link>&larr; ${J.esc(ctx.song.title)}</a>
            <span class="grow"></span>
          </div>
          <h1 class="yt-title">Upload to YouTube</h1>

          ${ctx.current ? "" : `<div class="empty">
            <h3>Nothing to upload</h3>
            <p>This song has no render on it yet.</p></div>`}

          ${ctx.current ? `
          <div class="yt-form">
            <section class="yt-card">
              <div class="yt-card-head">
                <h2>The sound that goes out</h2>
                <span class="grow"></span>
                <span class="preset-row" id="ytPresetRow"></span>
              </div>
              <p class="faint">Shaped here, and the file is made from exactly this. The
                same equaliser and limiter as the song page, on the same preset, so a
                change here is a change there.</p>

              <div class="eq-wrap">
                <canvas class="eq-canvas" id="ytEqCanvas"></canvas>
                <div class="eq-readout" id="ytEqReadout"></div>
                <div class="eq-hint">click to place a band &middot; drag it &middot; double click to remove</div>
              </div>

              <div class="eq-toolbar">
                <button class="btn sm" data-act="add" data-type="peaking">Bell</button>
                <button class="btn sm ghost" data-act="add" data-type="highpass">Low cut</button>
                <button class="btn sm ghost" data-act="add" data-type="lowpass">High cut</button>
                <button class="btn sm ghost" data-act="add" data-type="lowshelf">Low shelf</button>
                <button class="btn sm ghost" data-act="add" data-type="highshelf">High shelf</button>
                <span class="grow"></span>
                <button class="pill" id="ytBypass" data-act="bypass"></button>
              </div>

              <div class="limiter-head">
                <h3>Limiter</h3>
                <button class="switch" id="ytLimiterSwitch" data-act="limiter-toggle"
                        aria-label="Limiter on"></button>
                <span class="grow"></span>
                <span class="limiter-nums" id="ytLimiterNums"></span>
              </div>
              <div class="limiter-wrap">
                <canvas class="limiter-canvas" id="ytLimiterCanvas"></canvas>
                <div class="limiter-hint">drag the two lines</div>
              </div>
            </section>

            ${ctx.has("arrange") ? `
            <section class="yt-card">
              <div class="yt-card-head">
                <h2>The arrangement</h2>
                <span class="grow"></span>
                <label class="yt-check">
                  <input type="checkbox" id="ytArranged" ${arranged ? "checked" : ""}
                         ${arranged ? "" : "disabled"}>
                  <span>${arranged ? "Use it" : "This song has none"}</span>
                </label>
              </div>
              <p class="faint">Cut and reorder what goes out, without touching the render
                it came from. Unticked, the whole take is used.</p>
              <div class="yt-comp" id="ytComp"></div>
            </section>` : ""}

            <section class="yt-card">
              <h2>The file</h2>
              <div class="yt-summary" id="ytSummary"></div>
              <div class="row wrap">
                <button class="btn primary" data-act="render">Render it</button>
              </div>
              <div class="yt-progress" id="ytProgress" hidden>
                <span class="yt-status" id="ytStatus"></span>
                <span class="yt-bar" id="ytBar"><span></span></span>
              </div>
              <div id="ytResult" hidden></div>
            </section>

            <section class="yt-card">
              <h2>What YouTube is told</h2>
              <label class="sheet-label">Title
                <input class="field" id="ytName" value="${J.esc(ctx.song.title)}">
              </label>
              <label class="sheet-label">Description
                <textarea class="field yt-desc" id="ytDesc" rows="5"></textarea>
              </label>

              <div class="yt-privacy">
                <span class="yt-privacy-label">Who can see it</span>
                <div class="yt-pills" role="radiogroup" aria-label="Who can see it">
                  ${PRIVACY.map((p) => `
                    <button class="yt-pill ${p.key === privacy ? "on" : ""}"
                            role="radio" aria-checked="${p.key === privacy}"
                            data-privacy="${p.key}">
                      <span class="t">${p.label}</span>
                      <span class="s">${p.note}</span>
                    </button>`).join("")}
                </div>
              </div>

              ${cover ? `<div class="yt-still">
                <img src="${cover}" alt="">
                <span class="faint">The artwork becomes the picture.</span>
              </div>` : `<p class="faint">This song has no artwork, so the video would be
                a plain colour. Add a picture on the song page first if that matters.</p>`}
            </section>

            <section class="yt-card yt-last">
              <h2>Sending it</h2>
              <p>Everything above is finished and working: the file is rendered from the
                sound and the cut you set here, and it can be auditioned and saved.
                <b>J-ong cannot send it to YouTube yet.</b></p>
              <p class="faint">YouTube takes video, not audio, so a rendered wav cannot be
                uploaded as it is. Turning the audio and the artwork into a video is the
                one piece still to build. Until then: render it, save the file, and put it
                up by hand.</p>
              <div class="row wrap">
                <button class="btn primary" disabled title="Not built yet">Send to YouTube</button>
                <span class="faint">the last step, not yet built</span>
              </div>
            </section>

            <section class="yt-card">
              <div class="yt-card-head">
                <h2>The account</h2>
                <span class="grow"></span>
                ${accounts.length
                  ? '<button class="btn sm ghost" data-act="add-account">Add another</button>' : ""}
              </div>
              ${accounts.length ? `
                <div class="yt-accounts">
                  ${accounts.map((a) => `
                    <button class="yt-account ${a.id === account.chosen ? "on" : ""}"
                            data-account="${J.esc(a.id)}">
                      <span class="yt-avatar">${J.esc((a.name || "?").slice(0, 1).toUpperCase())}</span>
                      <span class="grow truncate">
                        <span class="t truncate">${J.esc(a.name)}</span>
                        <span class="s truncate">${a.connected_at
                          ? `connected ${J.esc(J.when(a.connected_at))}` : "connected"}</span>
                      </span>
                      ${a.id === account.chosen
                        ? '<span class="yt-chosen">Uploading as this</span>'
                        : '<span class="yt-pick">Use this one</span>'}
                    </button>`).join("")}
                </div>` : ""}
              <div id="ytConnect" ${accounts.length ? "hidden" : ""}></div>
            </section>
          </div>` : ""}
        </div>`;

      if (!ctx.current) return;
      mountSound();
      mountArrangement();
      paintSummary();
      if (bounced) drawResult();
      if (!accounts.length) drawConnect();
    }

    // ── what the page responds to ────────────────────────────────────────────

    root.addEventListener("change", (e) => {
      if (e.target.closest("#ytArranged")) { stale(); paintSummary(); }
    });

    root.addEventListener("click", async (e) => {
      const preset = chosenPreset();

      const tab = e.target.closest("[data-preset]");
      if (tab) {
        chosenPresetId = Number(tab.dataset.preset);
        stale();
        mountSound();
        return;
      }

      const pill = e.target.closest("[data-privacy]");
      if (pill) {
        privacy = pill.dataset.privacy;
        J.$$("[data-privacy]", root).forEach((p) => {
          const on = p.dataset.privacy === privacy;
          p.classList.toggle("on", on);
          p.setAttribute("aria-checked", on);
        });
        return;
      }

      const pick = e.target.closest("[data-account]");
      if (pick) {
        const chosen = await J.try(() => J.post("/api/youtube/account/choose",
                                                { id: pick.dataset.account }));
        if (chosen) { account = chosen; draw(); }
        return;
      }

      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;

      if (what === "render") return makeTheFile();
      if (what === "connect") return connect();
      if (what === "add-account") { drawConnect(); return; }
      if (what === "cancel-connect") { J.$("#ytConnect", root).hidden = true; return; }

      if (what === "add" && preset && editor) {
        editor.addBand(act.dataset.type);
        return;
      }
      if (what === "bypass" && preset) {
        preset.data.bypass = !preset.data.bypass;
        savePreset(preset);
        stale();
        paintChrome();
        return;
      }
      if (what === "limiter-toggle" && preset) {
        preset.data.limiter = Object.assign({}, preset.data.limiter);
        preset.data.limiter.on = !preset.data.limiter.on;
        savePreset(preset);
        stale();
        paintChrome();
        return;
      }

      if (what === "download" && bounced) {
        const link = document.createElement("a");
        link.href = bounced.url;
        link.download = `${ctx.song.title} v${ctx.current.n}.wav`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
    });

    /* Cutting a clip changes the length of what goes out, so the summary follows it and
     * anything already rendered stops being the truth. Also the moment to notice the page
     * has gone and give back what it was holding. */
    J.on("arrange:change", function follow() {
      if (!root.isConnected) {
        J.bus.removeEventListener("arrange:change", follow);
        freeAudition();
        if (comp && comp.stop) comp.stop();
        return;
      }
      stale();
      paintSummary();
    });

    await load();
  },
};
