/* Where this song lives on YouTube.
 *
 * J-ong does not push the file to YouTube itself, and it is worth saying why rather than
 * leaving a button that half works. Uploading through YouTube's API means a Google
 * account, an OAuth consent screen, a client secret kept on this machine and a library to
 * talk to it, which is a dependency, a credential and an approval flow for something you
 * do a handful of times a year. This does the part that is actually tedious instead: it
 * opens YouTube's upload page, hands you the exact render as a file ready to drop in, and
 * then keeps the link against the version that went up.
 *
 * Which version is the point. Six renders later, "what is actually online" is a real
 * question and the answer is not recoverable from anywhere else.
 */
"use strict";

J.blockYouTube = async function (block, ctx) {
  let posts = [];

  async function load() {
    const data = await J.try(() => J.get(`/api/songs/${ctx.songId}/youtube`));
    posts = (data && data.posts) || [];
    draw();
  }

  const idOf = (url) => {
    const m = String(url || "").match(
      /(?:youtu\.be\/|v=|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : null;
  };

  /* Copying without a permission prompt where possible, and never silently failing.
   *
   * The clipboard API needs a secure context, and this library is reached over plain
   * http on a tailnet as often as not, so the textarea fallback is the path that
   * actually runs rather than a courtesy. */
  async function copy(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        J.toast("Link copied");
        return;
      }
    } catch (e) { /* fall through to the old way */ }
    const box = document.createElement("textarea");
    box.value = text;
    box.setAttribute("readonly", "");
    box.style.cssText = "position:fixed;top:-1000px;opacity:0";
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    box.remove();
    if (ok) { J.toast("Link copied"); return; }

    /* Both ways refused, which happens when the browser wants a real press it can see.
     * Saying "could not copy" and stopping there leaves somebody with a link they can
     * see and cannot take, so hand it over selected instead. */
    await J.sheet({
      title: "Here is the link",
      sub: "This browser would not let J-ong reach the clipboard. It is selected ready to copy.",
      confirm: "",
      cancel: "Done",
      body: `<input class="field" id="ytLink" value="${J.esc(text)}" readonly>`,
      onMount(sheet) {
        const field = J.$("#ytLink", sheet);
        if (!field) return;
        field.focus();
        field.select();
      },
    });
  }

  /* The render that would go up: whichever version the page is about. */
  function versionForUpload() {
    return ctx.currentVersion();
  }

  async function startUpload() {
    const version = versionForUpload();
    if (!version) {
      J.toast("There is no render on this song to upload.");
      return;
    }

    const go = await J.confirm(
      `Upload v${version.n} of ${ctx.song.title}?`,
      "YouTube's upload page opens in a new tab and the render downloads so you can drop "
      + "it in. J-ong cannot post it for you: that needs a Google sign in it has no "
      + "business holding. Paste the link back here when it is up.",
      "Open YouTube");
    if (!go) return;

    // The file first, so it is already in the folder by the time the tab has loaded.
    const link = document.createElement("a");
    link.href = `/api/versions/${version.id}/audio`;
    link.download = `${ctx.song.title} v${version.n}${version.ext || ".wav"}`;
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.open("https://www.youtube.com/upload", "_blank", "noopener");
    await record(version);
  }

  async function record(version) {
    const fields = await J.sheet({
      title: "Keep the link",
      sub: `Against v${version.n}, so six renders from now you can still tell what is online.`,
      confirm: "Save it",
      cancel: "Not yet",
      body: `<div class="sheet-fields">
        <label class="sheet-label">The YouTube link
          <input class="field" name="url" placeholder="https://youtu.be/..." autocomplete="off">
        </label>
        <label class="sheet-label">Title on YouTube, if it differs
          <input class="field" name="title" value="${J.esc(ctx.song.title)}" autocomplete="off">
        </label>
      </div>`,
    });
    if (!fields || !fields.url.trim()) return;

    await J.try(() => J.post(`/api/songs/${ctx.songId}/youtube`, {
      url: fields.url.trim(),
      title: fields.title.trim() || ctx.song.title,
      version_id: version.id,
      status: "published",
    }), "Saved");
    await load();
  }

  function draw() {
    const head = `
      <div class="block-head"><h2>YouTube</h2>
        ${posts.length ? `<span class="tag">${posts.length}</span>` : ""}
        <span class="grow"></span>
        <a class="btn ghost sm" href="#/song/${ctx.songId}/youtube" data-link>Upload to YouTube</a>
      </div>`;

    if (!posts.length) {
      block.innerHTML = `${head}
        <p class="faint yt-none">Nothing of this song is on YouTube yet, or nothing that
          J-ong has been told about. Upload renders the file through this song's sound and
          sends it, and keeps the link against the version that went up.
          <button class="linkish" data-act="record">Or paste a link you already have</button>.</p>`;
      return;
    }

    block.innerHTML = `${head}
      <div class="yt-list">
        ${posts.map((post) => {
          const code = idOf(post.url);
          return `
          <div class="yt-row" data-post="${post.id}">
            ${code
              ? `<img class="yt-thumb" src="https://i.ytimg.com/vi/${J.esc(code)}/mqdefault.jpg"
                      alt="" loading="lazy" referrerpolicy="no-referrer">`
              : '<span class="yt-thumb flat"></span>'}
            <span class="grow truncate">
              <span class="t truncate">${J.esc(post.title || ctx.song.title)}</span>
              <span class="s truncate">${
                post.version_n ? `v${post.version_n}` : "version unknown"
              } &middot; ${J.esc(post.status)}${
                post.created_at ? ` &middot; ${J.esc(J.when(post.created_at))}` : ""}</span>
            </span>
            <button class="btn sm ghost" data-act="copy">Copy link</button>
            <a class="btn sm ghost" href="${J.esc(post.url)}" target="_blank"
               rel="noopener noreferrer">Watch</a>
          </div>`;
        }).join("")}
      </div>`;
  }

  block.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    const row = act.closest("[data-post]");
    const post = row ? posts.find((p) => String(p.id) === row.dataset.post) : null;

    if (act.dataset.act === "record") return record(versionForUpload());
    if (act.dataset.act === "copy" && post) return copy(post.url);
  });

  J.menu.on(block, "[data-post]", (node) => {
    const post = posts.find((p) => String(p.id) === node.dataset.post);
    if (!post) return null;
    return [
      { label: "Copy the link", icon: "copy", run: () => copy(post.url) },
      { label: "Watch on YouTube", icon: "open",
        run: () => window.open(post.url, "_blank", "noopener") },
      { divider: true },
      { label: "Forget this link", icon: "drop", danger: true,
        run: async () => {
          const sure = await J.confirm("Forget this link?",
            "Nothing on YouTube changes. J-ong stops recording that it is there.",
            "Forget it");
          if (!sure) return;
          await J.try(() => J.del(`/api/youtube/${post.id}`), "Forgotten");
          await load();
        } },
    ];
  });

  await load();
};
