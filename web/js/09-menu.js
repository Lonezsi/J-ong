/* One menu, opened from anywhere.
 *
 * Right clicking something and getting the browser's own menu, on an app that is clearly
 * not a document, is a small dead end every time it happens: the things offered are Save
 * image as and View source, and the thing you wanted was Delete.
 *
 * So everything that is a thing here has a menu of its own, and they are all this one.
 * Opened from a right click it appears under the pointer; opened from a button it hangs
 * off that button. It closes on Escape, on a click elsewhere, on scrolling, and on
 * losing the window, because a menu that outlives what it belongs to is worse than no
 * menu.
 *
 * An item is { label, run, icon, danger, disabled, hint }. A { group: "Name" } is a
 * heading and a { divider: true } is a line, and neither can be pressed.
 */
"use strict";

J.menu = (function () {
  let open = null;

  function close() {
    if (!open) return;
    const node = open.node;
    open = null;
    node.remove();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("blur", close);
    window.removeEventListener("resize", close);
    document.removeEventListener("scroll", close, true);
  }

  function onOutside(e) {
    if (!open) return;
    // contains() throws on anything that is not a Node, and an event whose target is
    // the window is not far fetched. A menu that cannot be closed is the worst outcome
    // available here, so anything unrecognised counts as outside.
    const inside = e.target instanceof Node && open.node.contains(e.target);
    if (!inside) close();
  }

  function onKey(e) {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
    const rows = [...open.node.querySelectorAll(".menu-row:not([disabled])")];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      rows[(at + 1) % rows.length].focus();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      rows[(at - 1 + rows.length) % rows.length].focus();
    }
  }

  /* Somewhere the whole menu fits, preferring where it was asked for. */
  function place(node, at) {
    const size = node.getBoundingClientRect();
    const pad = 8;
    let left = at.left;
    let top = at.top;

    if (at.anchor) {
      // Hanging off a button: below it, or above when there is no room below.
      top = at.anchor.bottom + 6;
      if (top + size.height > window.innerHeight - pad) {
        top = Math.max(pad, at.anchor.top - size.height - 6);
      }
      left = at.anchor.left;
      node.style.minWidth = `${Math.round(Math.max(at.anchor.width, 220))}px`;
    } else {
      // Under the pointer: flipped rather than clipped when it would run off.
      if (top + size.height > window.innerHeight - pad) {
        top = Math.max(pad, top - size.height);
      }
    }
    left = J.clamp(left, pad, Math.max(pad, window.innerWidth - size.width - pad));
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(J.clamp(top, pad, window.innerHeight - pad))}px`;
  }

  const ICONS = {
    play: '<path d="M8 5.5l11 6.5-11 6.5z" fill="currentColor"/>',
    open: '<path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    add: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M5 15V5h10" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    drop: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
    down: '<path d="M12 4v12m0 0l4-4m-4 4l-4-4M5 20h14" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    star: '<path d="M12 4l2.3 5 5.7.6-4.3 3.8 1.3 5.6L12 16l-5 3 1.3-5.6L4 9.6 9.7 9z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linejoin="round"/>',
    tag: '<path d="M4 4h7l9 9-7 7-9-9z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><circle cx="8.5" cy="8.5" r="1.3" fill="currentColor"/>',
    art: '<rect x="4" y="4" width="16" height="16" rx="2.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M4 16l4.5-4 3.5 3 3-2.5L20 16" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  const icon = (name) => (ICONS[name]
    ? `<svg class="menu-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${ICONS[name]}</svg>`
    : '<span class="menu-icon"></span>');

  return {
    get isOpen() { return !!open; },
    close,

    /* items, and where. `where` is a pointer event, or {anchor: element}. */
    show(items, where) {
      close();
      const usable = (items || []).filter(Boolean);
      if (!usable.some((i) => i.run)) return null;

      const node = document.createElement("div");
      node.className = "slot-menu app-menu";
      node.setAttribute("role", "menu");
      node.innerHTML = usable.map((item, index) => {
        if (item.group) return `<div class="menu-group">${J.esc(item.group)}</div>`;
        if (item.divider) return '<div class="menu-divider"></div>';
        return `<button class="menu-row ${item.danger ? "danger" : ""}" role="menuitem"
                        data-index="${index}" ${item.disabled ? "disabled" : ""}>
          ${icon(item.icon)}
          <span class="grow">${J.esc(item.label)}</span>
          ${item.hint ? `<span class="menu-hint">${J.esc(item.hint)}</span>` : ""}
        </button>`;
      }).join("");

      document.body.appendChild(node);
      open = { node, items: usable };

      const at = where && where.anchor
        ? { anchor: where.anchor.getBoundingClientRect() }
        : { left: (where && where.clientX) || 0, top: (where && where.clientY) || 0 };
      place(node, at);

      node.addEventListener("click", (e) => {
        const row = e.target.closest(".menu-row");
        if (!row || row.disabled) return;
        const item = usable[Number(row.dataset.index)];
        close();
        if (item && item.run) item.run();
      });

      // Bound in the capture phase and on the next frame, so the very click that opened
      // this does not immediately close it again.
      requestAnimationFrame(() => {
        if (!open) return;
        document.addEventListener("keydown", onKey, true);
        window.addEventListener("pointerdown", onOutside, true);
        window.addEventListener("blur", close);
        window.addEventListener("resize", close);
        document.addEventListener("scroll", close, true);
      });

      const first = node.querySelector(".menu-row:not([disabled])");
      if (first) first.focus();
      return node;
    },

    /* Wire a container once: every element matching `selector` inside it gets a menu,
     * built on demand by `build(element, event)`. Delegated, so rows that appear later
     * are covered without rewiring. */
    on(root, selector, build) {
      root.addEventListener("contextmenu", (e) => {
        const hit = e.target.closest(selector);
        if (!hit || !root.contains(hit)) return;
        const items = build(hit, e);
        if (!items || !items.length) return;
        e.preventDefault();
        J.menu.show(items, e);
      });
    },
  };
})();
