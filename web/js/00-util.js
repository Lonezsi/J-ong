/* The shared namespace and the small things every screen needs.
 *
 * The js/ directory is concatenated in filename order, so there is one scope and one
 * global. Everything hangs off J, and a file that is deleted simply stops adding to it.
 */
"use strict";

const J = {
  views: {},      // route name -> { title, render }
  state: {},
  bus: new EventTarget(),
};

J.$ = (sel, root) => (root || document).querySelector(sel);
J.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

J.esc = (value) => String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[c]));

J.emit = (name, detail) => J.bus.dispatchEvent(new CustomEvent(name, { detail }));
J.on = (name, fn) => J.bus.addEventListener(name, fn);

/* mm:ss, and h:mm:ss once a track is long enough to need it. */
J.time = (seconds) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
};

J.bytes = (n) => {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / Math.pow(1024, i);
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
};

J.when = (epochSeconds) => {
  if (!epochSeconds) return "";
  const then = new Date(epochSeconds * 1000);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return then.toLocaleDateString(undefined, {
    day: "numeric", month: "short", year: sameYear ? undefined : "numeric",
  });
};

J.date = (epochSeconds) => epochSeconds
  ? new Date(epochSeconds * 1000).toLocaleString(undefined,
      { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
  : "";

/* A stable hue per title, so a song without artwork still looks like itself every time. */
J.hue = (text) => {
  let hash = 0;
  const value = String(text || "?");
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) % 360;
  return hash;
};

/* One cover markup for every screen: real artwork when there is some, a coloured
 * placeholder built from the title when there is not. */
J.cover = (opts) => {
  const { url, title, className = "", style = "" } = opts || {};
  const letter = (String(title || "?").trim()[0] || "?").toUpperCase();
  if (url) {
    return `<div class="cover ${className}" style="background-image:url('${J.esc(url)}');${style}"></div>`;
  }
  return `<div class="cover ${className}" data-hue style="--hue:${J.hue(title)};${style}">` +
         `<span class="letter">${J.esc(letter)}</span></div>`;
};

J.toast = (message, kind) => {
  const stack = J.$("#toasts");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = "toast" + (kind === "bad" ? " bad" : "");
  node.textContent = message;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity 200ms";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 220);
  }, kind === "bad" ? 4800 : 2600);
};

/* Dialogs. Resolves with a value when confirmed and null when dismissed, so callers
 * read as `const name = await J.sheet(...)` rather than a pile of callbacks. */
J.sheet = (opts) => new Promise((resolve) => {
  const backdrop = J.$("#modalBackdrop");
  const { title, sub = "", body = "", confirm = "Save", cancel = "Cancel",
          wide = false, danger = false, onMount } = opts;
  backdrop.innerHTML = `
    <div class="sheet ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label="${J.esc(title)}">
      <h2>${J.esc(title)}</h2>
      ${sub ? `<p class="sub">${J.esc(sub)}</p>` : ""}
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">
        <button class="btn ghost" data-act="cancel">${J.esc(cancel)}</button>
        ${confirm ? `<button class="btn ${danger ? "danger" : "primary"}" data-act="ok">${J.esc(confirm)}</button>` : ""}
      </div>
    </div>`;
  backdrop.hidden = false;

  const sheet = J.$(".sheet", backdrop);
  const close = (value) => {
    document.removeEventListener("keydown", onKey);
    backdrop.hidden = true;
    backdrop.innerHTML = "";
    resolve(value);
  };
  const collect = () => {
    const fields = {};
    J.$$("[name]", sheet).forEach((input) => {
      fields[input.name] = input.type === "checkbox" ? input.checked : input.value;
    });
    return fields;
  };
  const onKey = (e) => {
    if (e.key === "Escape") { e.preventDefault(); close(null); }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); close(collect()); }
  };
  document.addEventListener("keydown", onKey);
  backdrop.onclick = (e) => { if (e.target === backdrop) close(null); };
  sheet.addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "cancel") close(null);
    if (act.dataset.act === "ok") close(collect());
  });
  if (onMount) onMount(sheet, close);
  const first = J.$("input, textarea, select", sheet);
  if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
});

J.confirm = (title, sub, confirm) =>
  J.sheet({ title, sub, confirm: confirm || "Yes, do it", cancel: "Keep it", danger: true })
    .then((value) => value !== null);

J.clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/* Wait for a burst of calls to settle. Used for typing in the search box and for the
 * lyric editor, so neither writes on every keystroke. */
J.debounce = (fn, wait) => {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.now = (...args) => { clearTimeout(timer); fn(...args); };
  return wrapped;
};


/* A stand in for a screen that is still loading.
 *
 * Shown the instant a navigation starts, so the app never blanks. It is shaped roughly
 * like what is coming, because a placeholder in the wrong shape is worse than none: the
 * page jumps when the real thing lands and the eye has to start again.
 *
 * Deliberately dim and slow. A shimmering block that demands attention while you wait
 * for it is the wrong way round.
 */
J.skeleton = (kind) => {
  const line = (w, h) => `<span class="sk-line" style="width:${w};height:${h || "13px"}"></span>`;
  if (kind === "song") {
    return `<div class="sk">
      <div class="sk-hero">
        <span class="sk-cover"></span>
        <span class="sk-stack">${line("46%", "38px")}${line("30%")}${line("22%")}</span>
      </div>
      <div class="sk-block">${line("18%", "11px")}${line("100%", "120px")}</div>
      <div class="sk-block">${line("18%", "11px")}${line("100%", "160px")}</div>
    </div>`;
  }
  return `<div class="sk">
    <div class="sk-block">${line("22%", "22px")}
      ${[72, 88, 64, 80, 58].map((w) => `<span class="sk-row">
        <span class="sk-thumb"></span>${line(w + "%")}</span>`).join("")}
    </div>
  </div>`;
};

/* Sorting a list, and remembering how you like it.
 *
 * One mechanism for every list rather than one per view, because "sort by name" has to
 * mean the same thing and look the same wherever it appears. A list declares which keys
 * it can be sorted by; this holds the choice, draws the control and does the comparing.
 *
 * The choice is kept per list in this browser. It is a preference about looking, not a
 * fact about the library, so it does not belong on the server and it does not need to
 * follow you to another machine.
 *
 * The first key a list declares is its default, which for a running order is always the
 * running order itself. An album's track list and a playlist are sequences somebody
 * chose; offering to sort them is useful, opening them re-sorted is throwing that away.
 */
J.sort = (function () {
  const KEY = "jong.sort";

  function all() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; }
    catch (e) { return {}; }        // a private window, or something else's key
  }

  function keep(map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); } catch (e) { /* fine */ }
  }

  /* Text compares as a person reads it: case blind, and "Track 10" after "Track 9".
   * Numbers and dates compare as numbers, and anything missing sinks to the bottom
   * whichever way round the list is, because an empty value is not a small one. */
  function compare(a, b, field, numeric, dir) {
    const left = field(a);
    const right = field(b);
    const missing = (v) => v === null || v === undefined || v === "" ||
                           (numeric && !Number.isFinite(Number(v)));
    if (missing(left) || missing(right)) {
      if (missing(left) && missing(right)) return 0;
      return missing(left) ? 1 : -1;
    }
    const order = numeric
      ? Number(left) - Number(right)
      : String(left).localeCompare(String(right), undefined,
                                   { sensitivity: "base", numeric: true });
    return dir === "down" ? -order : order;
  }

  return {
    /* What this list is sorted by right now, as {key, dir}. */
    of(list, keys) {
      const kept = all()[list];
      const known = keys.find((k) => k.key === (kept && kept.key));
      const chosen = known || keys[0];
      return { key: chosen.key, dir: (kept && kept.dir) || chosen.dir || "up", def: chosen };
    },

    set(list, key, dir) {
      const map = all();
      map[list] = { key, dir };
      keep(map);
    },

    /* A copy, in order. Never the array that was handed in: several views hold on to
     * theirs and look rows up in it by index. */
    apply(items, list, keys) {
      const now = this.of(list, keys);
      const spec = keys.find((k) => k.key === now.key) || keys[0];
      if (!spec || !spec.by) return items.slice();     // the untouched order
      return items.slice().sort((a, b) => compare(a, b, spec.by, !!spec.numeric, now.dir));
    },

    /* The control. One button that says what the list is sorted by, opening a menu of
     * the rest. The arrow is the direction and pressing the current key flips it, which
     * is the one gesture every table in the world already has. */
    control(list, keys) {
      const now = this.of(list, keys);
      const spec = keys.find((k) => k.key === now.key) || keys[0];
      const fixed = !spec.by;                     // the running order cannot be reversed
      return `<button class="btn ghost sm sort-pick" data-sort-list="${J.esc(list)}"
                title="Sort this list">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             class="sort-mark ${fixed ? "" : now.dir}"><path d="M3 6h13M3 12h9M3 18h5"/>${
          fixed ? "" : '<path d="M18 8v11M15 16l3 3 3-3"/>'}</svg>
        <span>${J.esc(spec.label)}</span>
      </button>`;
    },

    /* Wire the control up. onChange is called after the choice is stored. */
    wire(root, list, keys, onChange) {
      const open = (node) => {
        const now = this.of(list, keys);
        J.menu.show(keys.map((k) => ({
          label: k.label + (k.key === now.key && k.by
            ? (now.dir === "down" ? "  \u2193" : "  \u2191") : ""),
          icon: k.key === now.key ? "check" : null,
          run: () => {
            // Pressing the one it is already sorted by turns it round.
            const dir = k.key === now.key && k.by
              ? (now.dir === "down" ? "up" : "down")
              : (k.dir || "up");
            this.set(list, k.key, dir);
            onChange();
          },
        })), { anchor: node });
      };
      root.addEventListener("click", (e) => {
        const hit = e.target.closest(`[data-sort-list="${CSS.escape(list)}"]`);
        if (hit) { e.preventDefault(); open(hit); }
      });
      root.addEventListener("contextmenu", (e) => {
        const hit = e.target.closest(`[data-sort-list="${CSS.escape(list)}"]`);
        if (hit) { e.preventDefault(); open(hit); }
      });
    },
  };
}());


/* The page's ground.
 *
 * A song puts its own artwork behind the entire app rather than behind its panel, so
 * the rail and the player have something with colour in it to bend. Called with nothing
 * by every other view, which is how it goes away again.
 */
J.pageWash = function (url, hue) {
  const wash = document.getElementById("pageWash");
  if (!wash) return;
  if (!url && hue === undefined) {
    wash.classList.remove("on", "flat");
    wash.style.backgroundImage = "";
    return;
  }
  wash.classList.toggle("flat", !url);
  if (url) wash.style.backgroundImage = `url('${String(url).replace(/'/g, "%27")}')`;
  else { wash.style.backgroundImage = ""; wash.style.setProperty("--hue", hue); }
  wash.classList.add("on");
};
