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
