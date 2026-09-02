/* Routing off the hash.
 *
 * A view is an entry in J.views, so deleting a view file removes the screen and every
 * link to it stops resolving rather than half working.
 */
"use strict";

J.router = (function () {
  let currentPath = "";
  let token = 0;

  function parse() {
    const raw = (location.hash || "#/").replace(/^#/, "");
    const [pathPart, queryPart] = raw.split("?");
    const parts = pathPart.split("/").filter(Boolean);
    const query = {};
    new URLSearchParams(queryPart || "").forEach((value, key) => { query[key] = value; });

    if (!parts.length) return { view: "library", params: query };
    if (parts[0] === "song") return { view: "song", params: Object.assign({ id: parts[1], tab: parts[2] }, query) };
    if (parts[0] === "album") return { view: "album", params: Object.assign({ id: parts[1] }, query) };
    if (J.views[parts[0]]) return { view: parts[0], params: query };
    return { view: "missing", params: { path: pathPart } };
  }

  async function go() {
    const { view, params } = parse();
    const mine = ++token;

    /* A fresh element every time, rather than emptying the old one.
     *
     * Views attach their own delegated click handlers to this node. Emptying it left
     * every previous view's handler attached, so after six navigations one click on Play
     * called playSong six times and the concurrent starts fought each other. Replacing
     * the node throws the old listeners away with it. */
    const old = J.$("#view");
    const root = document.createElement("div");
    root.id = "view";
    root.className = old.className;
    old.replaceWith(root);

    const screen = J.views[view];
    if (!screen) {
      root.innerHTML = `<div class="section"><div class="empty">
        <h3>Nothing here</h3>
        <p>That screen is not part of this build. It may be a module that is switched off.</p>
        <a class="btn primary" href="#/" data-link style="margin-top:var(--s4)">Back to the library</a>
      </div></div>`;
      return;
    }

    root.innerHTML = "";
    try {
      await screen.render(root, params);
    } catch (e) {
      // A view that throws must say so. A blank panel with a console error is the
      // failure that wastes the most time.
      if (mine !== token) return;
      root.innerHTML = `<div class="section"><div class="empty">
        <h3>This screen did not load</h3>
        <p>${J.esc(e.message)}</p>
        <button class="btn" onclick="J.router.reload()" style="margin-top:var(--s4)">Try again</button>
      </div></div>`;
      return;
    }
    if (mine !== token) return;
    currentPath = location.hash;
    J.markNav(view);
    root.scrollTop = 0;
  }

  return {
    start() {
      window.addEventListener("hashchange", go);
      go();
    },
    reload() { go(); },
    get view() { return parse().view; },
  };
})();
