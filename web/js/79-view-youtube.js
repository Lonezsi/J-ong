/* Putting a song on YouTube: the form, and the file that actually goes.
 *
 * Its own page rather than a block, because this is the one thing in the app that leaves
 * the building. Everything else is reversible and private; a video is neither, and a
 * screen you have to navigate to is a better place to make that decision than a panel
 * you scrolled past.
 *
 * The file is rendered here, through the same equaliser, limiter and arrangement you
 * approved. That is a deliberate exception to the rule that this app never writes audio:
 * sending a mix somewhere means sending a file, and a file without the curve on it is
 * not the mix. J.bounce does the rendering and shares its chain with the player, so
 * there is one definition of the sound rather than two that agree until they do not.
 */
"use strict";

J.views.youtube = {
  title: "Upload to YouTube",
  async render(root, params) {
    const songId = Number(params.id);
    let ctx = null;
    let account = null;
    let bounced = null;          // { buffer, blob, peak, seconds }
    let working = false;

    async function load() {
      const [song, versions, presets, art, connected] = await Promise.all([
        J.get(`/api/songs/${songId}`),
        J.get(`/api/songs/${songId}/versions`),
        J.get(`/api/songs/${songId}/sound`).catch(() => ({ presets: [] })),
        J.get(`/api/songs/${songId}/artwork`).catch(() => ({ artwork: [] })),
        J.get("/api/youtube/account").catch(() => ({ connected: false })),
      ]);
      const list = versions.versions || [];
      ctx = {
        song: song.song,
        songId,
        versions: list,
        presets: presets.presets || [],
        artwork: art.artwork || [],
        current: list.find((v) => v.id === song.song.current_version_id) || list[0],
        currentVersion() { return this.current; },
      };
      account = connected;
      draw();
    }

    const chosenPreset = () => {
      const want = J.$("#ytPreset", root);
      const id = want ? Number(want.value) : null;
      return ctx.presets.find((p) => p.id === id)
        || ctx.presets.find((p) => p.is_current) || ctx.presets[0] || null;
    };
    const wantsArrangement = () => {
      const box = J.$("#ytArranged", root);
      return box ? box.checked : false;
    };

    function summary() {
      const preset = chosenPreset();
      const bands = preset && !preset.data.bypass
        ? (preset.data.bands || []).filter((b) => b.on).length : 0;
      const limiter = !!(preset && !preset.data.bypass && (preset.data.limiter || {}).on);
      const arranged = wantsArrangement();
      const seconds = arranged && J.arrange && J.arrange.state.songId === songId
        ? J.arrange.duration()
        : (ctx.current ? ctx.current.duration || 0 : 0);
      return { preset, bands, limiter, arranged, seconds };
    }

    function paintSummary() {
      const node = J.$("#ytSummary", root);
      if (!node) return;
      const s = summary();
      node.innerHTML = `
        <span><b>v${ctx.current ? ctx.current.n : "?"}</b> ${
          ctx.current && ctx.current.filename ? J.esc(ctx.current.filename) : ""}</span>
        <span class="dot"></span>
        <span>${s.bands ? `${s.bands} band${s.bands === 1 ? "" : "s"}` : "flat"}</span>
        <span class="dot"></span>
        <span>${s.limiter ? "limiter on" : "no limiter"}</span>
        <span class="dot"></span>
        <span>${s.arranged ? "as arranged" : "the whole take"}</span>
        ${s.seconds ? `<span class="dot"></span><span>${J.time(s.seconds)}</span>` : ""}`;
    }

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
        const blob = J.bounce.toWav(buffer);
        bounced = { buffer, blob, peak: J.bounce.peakOf(buffer), seconds: buffer.duration };
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
            has been flattened at the top. Turn the limiter on, or pull the output trim
            down by about ${Math.ceil(bounced.peak)}&nbsp;dB, and render again.</p>` : ""}
          <audio class="yt-audition" controls src="${URL.createObjectURL(bounced.blob)}"></audio>
          <div class="row wrap">
            <button class="btn sm ghost" data-act="download">Save the file</button>
            <span class="faint">${J.bytes(bounced.blob.size)} &middot; ${J.time(bounced.seconds)}</span>
          </div>
        </div>`;
    }

    function draw() {
      const s = summary();
      const cover = ctx.artwork.length ? `/api/artwork/${ctx.artwork[0].id}/image` : null;

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
              <h2>What gets rendered</h2>
              <p class="faint">The file is made here, now, through the sound you set on
                this song. It is not the stored render: that is never modified.</p>

              <label class="sheet-label">Sound
                <select class="field" id="ytPreset">
                  ${ctx.presets.map((p) => `<option value="${p.id}"
                    ${p.is_current ? "selected" : ""}>${J.esc(p.name)}</option>`).join("")}
                  ${ctx.presets.length ? "" : '<option value="">flat, no preset</option>'}
                </select>
              </label>

              ${J.state.modules.includes("arrange") ? `
                <label class="yt-check">
                  <input type="checkbox" id="ytArranged"
                    ${J.arrange && J.arrange.state.songId === songId
                      && J.arrange.state.clips.length ? "" : "disabled"}>
                  <span>Use the arrangement${
                    J.arrange && J.arrange.state.clips.length && J.arrange.state.songId === songId
                      ? "" : " (this song has none)"}</span>
                </label>` : ""}

              <div class="yt-summary" id="ytSummary"></div>

              <div class="row wrap">
                <button class="btn primary" data-act="render">Render the file</button>
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
              <label class="sheet-label">Visibility
                <select class="field" id="ytPrivacy">
                  <option value="private" selected>Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </label>
              ${cover ? `<div class="yt-still">
                <img src="${cover}" alt="">
                <span class="faint">The artwork becomes the picture.</span>
              </div>` : `<p class="faint">This song has no artwork, so the video would be
                a plain colour. Add a picture on the song page first if that matters.</p>`}
            </section>

            <section class="yt-card">
              <h2>The account</h2>
              ${account && account.connected ? `
                <p>Connected as <b>${J.esc(account.channel || "your channel")}</b>.</p>
                <div class="row wrap">
                  <button class="btn sm ghost danger" data-act="disconnect">Disconnect</button>
                </div>`
              : `
                <p class="faint">J-ong is not connected to a YouTube account.</p>
                <div id="ytConnect"></div>`}
            </section>
          </div>` : ""}
        </div>`;

      paintSummary();
      if (bounced) drawResult();
      if (!account || !account.connected) drawConnect();
    }

    /* What connecting actually involves, said plainly rather than behind a button that
     * fails. Uploading through YouTube's API needs an OAuth client that belongs to you,
     * because it acts as you: there is no way for this app to ship one. */
    function drawConnect() {
      const node = J.$("#ytConnect", root);
      if (!node) return;
      node.innerHTML = `
        <ol class="yt-steps">
          <li>Make a project at <a href="https://console.cloud.google.com/" target="_blank"
              rel="noopener noreferrer">console.cloud.google.com</a> and switch on the
              <b>YouTube Data API v3</b>.</li>
          <li>Under Credentials, make an <b>OAuth client ID</b> of type <b>TV and Limited
              Input</b>. That kind needs no redirect address, which is what lets this work
              on a machine you reach over a tunnel.</li>
          <li>Paste the two values below. They are stored on your own server and are never
              sent anywhere except Google.</li>
        </ol>
        <label class="sheet-label">Client ID
          <input class="field" id="ytClientId" autocomplete="off"
                 placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"></label>
        <label class="sheet-label">Client secret
          <input class="field" id="ytClientSecret" type="password" autocomplete="off"></label>
        <div class="row wrap">
          <button class="btn sm primary" data-act="connect">Connect</button>
        </div>
        <p class="faint yt-note">Google restricts uploads from an app it has not audited:
          until yours is reviewed, everything it uploads stays <b>private</b> whatever you
          choose above. That is Google's rule, not J-ong's, and it applies to the account
          that owns the project rather than to the video.</p>`;
    }

    /* Ask Google for a code, show it, and wait for the person to type it in. */
    async function connect() {
      const id = J.$("#ytClientId", root).value.trim();
      const secret = J.$("#ytClientSecret", root).value.trim();
      if (!id || !secret) { J.toast("Both values are needed.", "bad"); return; }

      const started = await J.try(() => J.post("/api/youtube/connect", {
        client_id: id, client_secret: secret,
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

    root.addEventListener("change", (e) => {
      if (e.target.closest("#ytPreset, #ytArranged")) {
        bounced = null;
        const result = J.$("#ytResult", root);
        if (result) { result.hidden = true; result.innerHTML = ""; }
        paintSummary();
      }
    });

    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;

      if (what === "render") return makeTheFile();
      if (what === "connect") return connect();

      if (what === "download" && bounced) {
        const link = document.createElement("a");
        link.href = URL.createObjectURL(bounced.blob);
        link.download = `${ctx.song.title} v${ctx.current.n}.wav`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }

      if (what === "disconnect") {
        const sure = await J.confirm("Disconnect YouTube?",
          "J-ong forgets the account. Nothing already uploaded changes.", "Disconnect");
        if (!sure) return;
        await J.try(() => J.del("/api/youtube/account"), "Disconnected");
        return load();
      }
    });

    await load();
  },
};
