/* The limiter display.
 *
 * Two things worth seeing, in the shape a mastering limiter usually shows them: how hard
 * it is working over time, and where the two lines that decide that sit.
 *
 *   top     gain reduction, scrolling right to left, so you watch it breathe
 *   bottom  the output level, with the ceiling and the threshold drawn on it
 *
 * Both lines are draggable. Threshold is where it starts holding the signal down and
 * ceiling is where the output is allowed to reach, so dragging them is the whole control
 * surface; attack and release are the only numbers left over.
 */
"use strict";

J.limiter = (function () {
  const DB_MIN = -36, DB_MAX = 0;
  const HISTORY = 240;

  function create(canvas, options) {
    const opts = options || {};
    const ctx2d = canvas.getContext("2d");
    let data = opts.data || {};
    let raf = null;
    let width = 0, height = 0, dpr = 1;
    let drag = null;
    let hover = null;
    const reduction = new Float32Array(HISTORY);
    let head = 0;

    const onChange = opts.onChange || (() => {});
    const readReduction = opts.reduction || (() => 0);
    const readLevel = opts.level || (() => -60);

    const dbToX = (db) => ((J.clamp(db, DB_MIN, DB_MAX) - DB_MIN) / (DB_MAX - DB_MIN)) * width;
    const xToDb = (x) => DB_MIN + (J.clamp(x, 0, width) / width) * (DB_MAX - DB_MIN);

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    const css = (name) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!canvas.isConnected) { stop(); return; }
      const rect = canvas.getBoundingClientRect();
      if (Math.round(rect.width) !== width || Math.round(rect.height) !== height) resize();

      reduction[head] = readReduction();
      head = (head + 1) % HISTORY;

      ctx2d.clearRect(0, 0, width, height);
      const split = Math.round(height * 0.56);
      drawReduction(split);
      drawMeter(split);
    }

    /* How hard it is pulling down, over the last few seconds. */
    function drawReduction(bottom) {
      const maxDb = 12;
      ctx2d.strokeStyle = "rgba(255,255,255,0.05)";
      ctx2d.lineWidth = 1;
      for (let db = 3; db < maxDb; db += 3) {
        const y = Math.round((db / maxDb) * bottom) + 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(width, y);
        ctx2d.stroke();
      }

      ctx2d.beginPath();
      ctx2d.moveTo(0, 0);
      for (let i = 0; i < HISTORY; i++) {
        const value = reduction[(head + i) % HISTORY];
        const x = (i / (HISTORY - 1)) * width;
        ctx2d.lineTo(x, (J.clamp(value, 0, maxDb) / maxDb) * bottom);
      }
      ctx2d.lineTo(width, 0);
      ctx2d.closePath();
      ctx2d.fillStyle = "rgba(217, 164, 65, 0.22)";
      ctx2d.fill();

      ctx2d.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        const value = reduction[(head + i) % HISTORY];
        const x = (i / (HISTORY - 1)) * width;
        const y = (J.clamp(value, 0, maxDb) / maxDb) * bottom;
        if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
      }
      ctx2d.strokeStyle = css("--warn") || "#D9A441";
      ctx2d.lineWidth = 1.5;
      ctx2d.stroke();

      ctx2d.fillStyle = "rgba(255,255,255,0.3)";
      ctx2d.font = "10px Manrope, sans-serif";
      ctx2d.textAlign = "left";
      ctx2d.fillText("gain reduction", 6, 13);

      ctx2d.strokeStyle = "rgba(255,255,255,0.1)";
      ctx2d.beginPath();
      ctx2d.moveTo(0, bottom + 0.5);
      ctx2d.lineTo(width, bottom + 0.5);
      ctx2d.stroke();
    }

    /* The output, and the two lines that shape it. */
    function drawMeter(top) {
      const lim = data.limiter || {};
      const barTop = top + 26;
      const barHeight = Math.max(14, height - barTop - 22);

      ctx2d.fillStyle = "rgba(255,255,255,0.26)";
      ctx2d.font = "10px Manrope, sans-serif";
      ctx2d.textAlign = "center";
      for (const db of [-30, -24, -18, -12, -6, 0]) {
        const x = dbToX(db);
        ctx2d.strokeStyle = "rgba(255,255,255,0.06)";
        ctx2d.beginPath();
        ctx2d.moveTo(Math.round(x) + 0.5, barTop - 4);
        ctx2d.lineTo(Math.round(x) + 0.5, barTop + barHeight + 4);
        ctx2d.stroke();
        ctx2d.fillText(String(db), J.clamp(x, 10, width - 10), height - 6);
      }

      ctx2d.fillStyle = "rgba(255,255,255,0.06)";
      ctx2d.fillRect(0, barTop, width, barHeight);

      const level = readLevel();
      const levelWidth = dbToX(level);
      const gradient = ctx2d.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, css("--accent-lo") || "#3E8B5D");
      gradient.addColorStop(0.75, css("--accent") || "#54B37A");
      gradient.addColorStop(1, css("--warn") || "#D9A441");
      ctx2d.fillStyle = gradient;
      ctx2d.fillRect(0, barTop, levelWidth, barHeight);

      // Anything above the ceiling is territory the output is not allowed into.
      const ceilingX = dbToX(lim.ceiling === undefined ? -0.3 : lim.ceiling);
      ctx2d.fillStyle = "rgba(212, 104, 94, 0.14)";
      ctx2d.fillRect(ceilingX, barTop, width - ceilingX, barHeight);

      line(dbToX(lim.threshold === undefined ? -6 : lim.threshold), barTop, barHeight,
           css("--warn") || "#D9A441", "threshold", hover === "threshold" || drag === "threshold");
      line(ceilingX, barTop, barHeight, css("--bad") || "#D4685E", "ceiling",
           hover === "ceiling" || drag === "ceiling");
    }

    function line(x, top, tall, colour, label, hot) {
      ctx2d.strokeStyle = colour;
      ctx2d.lineWidth = hot ? 3 : 2;
      ctx2d.beginPath();
      ctx2d.moveTo(Math.round(x) + 0.5, top - 6);
      ctx2d.lineTo(Math.round(x) + 0.5, top + tall + 6);
      ctx2d.stroke();

      ctx2d.beginPath();
      ctx2d.arc(x, top - 8, hot ? 6 : 4.5, 0, Math.PI * 2);
      ctx2d.fillStyle = colour;
      ctx2d.fill();

      if (hot) {
        ctx2d.fillStyle = colour;
        ctx2d.font = "600 10px Manrope, sans-serif";
        ctx2d.textAlign = "center";
        ctx2d.fillText(label, J.clamp(x, 28, width - 28), top - 16);
      }
    }

    // ── dragging the two lines ──────────────────────────────────────────────
    const at = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    function nearest(point) {
      const lim = data.limiter || {};
      const candidates = [
        ["threshold", dbToX(lim.threshold === undefined ? -6 : lim.threshold)],
        ["ceiling", dbToX(lim.ceiling === undefined ? -0.3 : lim.ceiling)],
      ];
      let best = null, bestDist = 16;
      for (const [name, x] of candidates) {
        const distance = Math.abs(x - point.x);
        if (distance < bestDist) { best = name; bestDist = distance; }
      }
      return best;
    }

    canvas.addEventListener("pointerdown", (e) => {
      const which = nearest(at(e));
      if (!which) return;
      drag = which;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      const point = at(e);
      if (!drag) {
        const near = nearest(point);
        if (near !== hover) { hover = near; canvas.style.cursor = near ? "ew-resize" : "default"; }
        return;
      }
      const value = Math.round(xToDb(point.x) * 10) / 10;
      data.limiter = data.limiter || {};
      if (drag === "threshold") data.limiter.threshold = J.clamp(value, -60, 0);
      else data.limiter.ceiling = J.clamp(value, -30, 0);
      onChange(data, drag);
    });
    const release = (e) => {
      if (!drag) return;
      drag = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already */ }
    };
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);

    function start() { if (!raf) { resize(); frame(); } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    return {
      start, stop, resize,
      get data() { return data; },
      set data(next) { data = next; },
    };
  }

  return { create };
})();
