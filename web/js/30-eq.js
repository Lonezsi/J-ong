/* The equaliser display.
 *
 * A curve you shape directly, in the manner of a Pro-Q: drag a node to move it in
 * frequency and gain, roll the wheel over it to tighten or widen Q, double click empty
 * space to add one, double click a node to take it away. The curve drawn is the real
 * response of the filter chain, read back from the audio graph rather than approximated,
 * so what is on screen is what is on the output.
 *
 * The analyser sits behind it, post EQ, because the useful question while shaping a mix
 * is what is coming out rather than what went in.
 */
"use strict";

J.eq = (function () {
  const F_MIN = 20, F_MAX = 22000;
  const DECADES = Math.log10(F_MAX / F_MIN);
  const GRID_F = [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];
  const LABEL_F = { 100: "100", 1000: "1k", 10000: "10k" };
  const FLAT = new Set(["lowpass", "highpass", "notch", "bandpass"]);

  const TYPE_LABEL = {
    peaking: "Bell", lowshelf: "Low shelf", highshelf: "High shelf",
    lowpass: "Low cut", highpass: "High cut", notch: "Notch", bandpass: "Band",
  };

  let nextId = 1;
  const newId = () => `b${Date.now().toString(36)}${nextId++}`;

  function create(canvas, options) {
    const opts = options || {};
    const ctx2d = canvas.getContext("2d");
    let data = opts.data || { bands: [], limiter: {}, gain: 0, bypass: false };
    let range = 18;                 // dB shown above and below the centre line
    let selected = null;
    let drag = null;
    let hover = null;
    let raf = null;
    let spectrumBins = null;
    let width = 0, height = 0, dpr = 1;

    const onChange = opts.onChange || (() => {});
    const onSelect = opts.onSelect || (() => {});

    // ── coordinates ─────────────────────────────────────────────────────────
    const fToX = (f) => (Math.log10(J.clamp(f, F_MIN, F_MAX) / F_MIN) / DECADES) * width;
    const xToF = (x) => F_MIN * Math.pow(10, (J.clamp(x, 0, width) / width) * DECADES);
    const gToY = (g) => height / 2 - (g / range) * (height / 2 - 12);
    const yToG = (y) => ((height / 2 - y) / (height / 2 - 12)) * range;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // ── drawing ─────────────────────────────────────────────────────────────
    function css(name) {
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    }

    function drawGrid() {
      ctx2d.lineWidth = 1;
      ctx2d.strokeStyle = "rgba(255,255,255,0.055)";
      ctx2d.fillStyle = "rgba(255,255,255,0.26)";
      ctx2d.font = "10px Manrope, sans-serif";
      ctx2d.textAlign = "center";
      for (const f of GRID_F) {
        const x = Math.round(fToX(f)) + 0.5;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, height);
        ctx2d.stroke();
        if (LABEL_F[f]) ctx2d.fillText(LABEL_F[f], x, height - 5);
      }
      const step = range >= 24 ? 12 : 6;
      ctx2d.textAlign = "left";
      for (let g = -range + step; g < range; g += step) {
        const y = Math.round(gToY(g)) + 0.5;
        ctx2d.strokeStyle = g === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.05)";
        ctx2d.beginPath();
        ctx2d.moveTo(0, y);
        ctx2d.lineTo(width, y);
        ctx2d.stroke();
        if (g !== 0) ctx2d.fillText(`${g > 0 ? "+" : ""}${g}`, 4, y - 3);
      }
      const zero = Math.round(gToY(0)) + 0.5;
      ctx2d.strokeStyle = "rgba(255,255,255,0.16)";
      ctx2d.beginPath();
      ctx2d.moveTo(0, zero);
      ctx2d.lineTo(width, zero);
      ctx2d.stroke();
    }

    function drawSpectrum() {
      const analyser = J.audio.analyser;
      if (!analyser) return;
      if (!spectrumBins || spectrumBins.length !== analyser.frequencyBinCount) {
        spectrumBins = new Uint8Array(analyser.frequencyBinCount);
      }
      J.audio.spectrum(spectrumBins);
      const audioCtx = J.audio.context();
      if (!audioCtx) return;
      const nyquist = audioCtx.sampleRate / 2;
      const bins = spectrumBins.length;

      ctx2d.beginPath();
      ctx2d.moveTo(0, height);
      let any = false;
      for (let i = 1; i < bins; i++) {
        const f = (i / bins) * nyquist;
        if (f < F_MIN) continue;
        if (f > F_MAX) break;
        const x = fToX(f);
        // The byte value is already a dB scale between the analyser's min and max, so
        // it only needs mapping into the panel rather than a second log.
        const y = height - (spectrumBins[i] / 255) * height * 0.92;
        ctx2d.lineTo(x, y);
        any = true;
      }
      if (!any) return;
      ctx2d.lineTo(width, height);
      ctx2d.closePath();
      ctx2d.fillStyle = "rgba(110, 203, 146, 0.10)";
      ctx2d.fill();
    }

    let freqAxis = null, freqX = null;
    function ensureAxis() {
      const points = Math.max(160, Math.min(560, Math.round(width)));
      if (freqAxis && freqAxis.length === points) return;
      freqAxis = new Float32Array(points);
      freqX = new Float32Array(points);
      for (let i = 0; i < points; i++) {
        const x = (i / (points - 1)) * width;
        freqAxis[i] = xToF(x);
        freqX[i] = x;
      }
    }

    function drawCurve() {
      ensureAxis();
      const db = J.audio.responseOf(data.bands, freqAxis, data.bypass);
      ctx2d.beginPath();
      for (let i = 0; i < db.length; i++) {
        const y = gToY(J.clamp(db[i], -range * 1.4, range * 1.4));
        if (i === 0) ctx2d.moveTo(freqX[i], y);
        else ctx2d.lineTo(freqX[i], y);
      }
      ctx2d.strokeStyle = data.bypass ? "rgba(255,255,255,0.24)" : css("--accent-hi") || "#6ECB92";
      ctx2d.lineWidth = 2;
      ctx2d.lineJoin = "round";
      ctx2d.stroke();

      // A soft fill between the curve and the centre line, so a boost and a cut read
      // differently at a glance rather than only by which side of the line they are on.
      ctx2d.lineTo(width, gToY(0));
      ctx2d.lineTo(0, gToY(0));
      ctx2d.closePath();
      ctx2d.fillStyle = data.bypass ? "rgba(255,255,255,0.04)" : "rgba(84, 179, 122, 0.11)";
      ctx2d.fill();
    }

    function drawNodes() {
      for (const band of data.bands) {
        const x = fToX(band.freq);
        const y = gToY(FLAT.has(band.type) ? 0 : band.gain);
        const isOn = band.on && !data.bypass;
        const active = selected === band.id;
        const hot = hover === band.id;

        if (active) {
          // The Q of the selected node, drawn as its reach across the spectrum.
          const half = Math.max(0.08, 1 / Math.max(band.q, 0.1));
          const left = fToX(band.freq / Math.pow(2, half));
          const right = fToX(band.freq * Math.pow(2, half));
          ctx2d.fillStyle = "rgba(84, 179, 122, 0.08)";
          ctx2d.fillRect(left, 0, Math.max(2, right - left), height);
        }

        ctx2d.beginPath();
        ctx2d.arc(x, y, active || hot ? 8 : 6, 0, Math.PI * 2);
        ctx2d.fillStyle = isOn
          ? (active ? css("--accent-hi") || "#6ECB92" : css("--accent") || "#54B37A")
          : "rgba(255,255,255,0.28)";
        ctx2d.fill();
        ctx2d.lineWidth = 2;
        ctx2d.strokeStyle = "rgba(10,13,11,0.9)";
        ctx2d.stroke();

        if (active || hot) {
          ctx2d.fillStyle = "rgba(255,255,255,0.85)";
          ctx2d.font = "600 10px Manrope, sans-serif";
          ctx2d.textAlign = "center";
          ctx2d.fillText(fmtHz(band.freq), x, y - 13);
        }
      }
    }

    function frame() {
      raf = requestAnimationFrame(frame);
      if (!canvas.isConnected) { stop(); return; }
      const rect = canvas.getBoundingClientRect();
      if (Math.round(rect.width) !== width || Math.round(rect.height) !== height) resize();
      ctx2d.clearRect(0, 0, width, height);
      drawGrid();
      drawSpectrum();
      drawCurve();
      drawNodes();
      if (opts.onFrame) opts.onFrame();
    }

    function start() { if (!raf) { resize(); frame(); } }
    function stop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

    // ── hit testing and interaction ─────────────────────────────────────────
    function at(event) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function nodeAt(point) {
      let best = null, bestDist = 14;
      for (const band of data.bands) {
        const dx = fToX(band.freq) - point.x;
        const dy = gToY(FLAT.has(band.type) ? 0 : band.gain) - point.y;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) { best = band; bestDist = dist; }
      }
      return best;
    }

    function commit() {
      J.audio.apply(data);
      onChange(data);
    }

    /* A press on the curve is an edit, straight away.
     *
     * Landing on a node grabs it; landing anywhere else puts a band there and drags it
     * in the same motion, so one gesture places it exactly where it was asked for. */
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button === 2) return;
      const point = at(e);
      const band = nodeAt(point);

      if (band) {
        selected = band.id;
        onSelect(band.id);
        drag = { id: band.id, moved: false, from: point };
      } else {
        const made = addAt(point);
        drag = { id: made.id, moved: false, from: point, fresh: true };
      }
      canvas.classList.add("dragging");
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* drag still works */ }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const where = at(e);
      const held = data.bands.find((b) => b.id === drag.id);
      if (!held) return;
      drag.moved = true;
      held.freq = Math.round(J.clamp(xToF(where.x), F_MIN, F_MAX) * 10) / 10;
      if (!FLAT.has(held.type)) {
        held.gain = Math.round(J.clamp(yToG(where.y), -range, range) * 10) / 10;
      }
      commit();
    });

    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      canvas.classList.remove("dragging");
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* already */ }
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    canvas.addEventListener("pointermove", (e) => {
      if (drag || e.pointerType === "touch") return;
      const band = nodeAt(at(e));
      const id = band ? band.id : null;
      if (id !== hover) { hover = id; canvas.style.cursor = id ? "grab" : "crosshair"; }
    });

    canvas.addEventListener("wheel", (e) => {
      const point = at(e);
      const band = nodeAt(point) || data.bands.find((b) => b.id === selected);
      if (!band) return;
      e.preventDefault();
      band.q = Math.round(J.clamp(band.q * Math.exp(-e.deltaY * 0.0016), 0.05, 30) * 100) / 100;
      commit();
    }, { passive: false });

    /* Placing a band, wherever the pointer went down. */
    function addAt(point) {
      const band = {
        id: newId(), type: "peaking",
        freq: Math.round(J.clamp(xToF(point.x), F_MIN, F_MAX) * 10) / 10,
        gain: Math.round(J.clamp(yToG(point.y), -range, range) * 10) / 10,
        q: 1.2, on: true,
      };
      data.bands.push(band);
      data.bands.sort((a, b) => a.freq - b.freq);
      selected = band.id;
      onSelect(band.id);
      commit();
      return band;
    }

    // Double clicking a node takes it away again, which is the pair to placing one.
    canvas.addEventListener("dblclick", (e) => {
      const band = nodeAt(at(e));
      if (!band) return;
      data.bands = data.bands.filter((b) => b.id !== band.id);
      if (selected === band.id) { selected = null; onSelect(null); }
      commit();
    });

    /* Right clicking the curve.
     *
     * This used to delete a band outright, with no menu and nothing said: a destructive
     * action on the gesture that everywhere else means "show me the options", and no way
     * back. It offers them instead, and right clicking empty space can now put a band
     * where you pointed rather than falling through to the browser's own menu. */
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const point = at(e);
      const band = nodeAt(point);

      if (!band) {
        J.menu.show([
          { label: `Add a bell at ${J.eq.fmtHz(xToF(point.x))}`, icon: "add",
            run: () => { const made = addAt(point); selected = made.id; onSelect(made.id); commit(); } },
          { divider: true },
          { label: `Flatten all ${data.bands.length} band${data.bands.length === 1 ? "" : "s"}`,
            icon: "drop", danger: true, disabled: !data.bands.length,
            run: () => { data.bands = []; selected = null; onSelect(null); commit(); } },
        ], e);
        return;
      }

      const remove = () => {
        data.bands = data.bands.filter((b) => b.id !== band.id);
        if (selected === band.id) { selected = null; onSelect(null); }
        commit();
      };
      J.menu.show([
        { group: `${TYPE_LABEL[band.type] || band.type} at ${J.eq.fmtHz(band.freq)}` },
        ...Object.keys(TYPE_LABEL).map((type) => ({
          label: TYPE_LABEL[type], icon: type === band.type ? "star" : null,
          disabled: type === band.type,
          run: () => { band.type = type; commit(); },
        })),
        { divider: true },
        { label: band.on === false ? "Switch it back on" : "Switch it off", icon: "edit",
          run: () => { band.on = band.on === false; commit(); } },
        { label: "Flatten this one", icon: "edit", disabled: FLAT.has(band.type) || !band.gain,
          run: () => { band.gain = 0; commit(); } },
        { divider: true },
        { label: "Remove this band", icon: "drop", danger: true, hint: "Double click",
          run: remove },
      ], e);
    });

    return {
      start, stop, resize,
      get data() { return data; },
      set data(next) {
        data = next;
        if (selected && !data.bands.some((b) => b.id === selected)) selected = null;
      },
      get selected() { return selected; },
      select(id) { selected = id; onSelect(id); },
      setRange(db) { range = db; },
      get range() { return range; },
      addBand(type) {
        const band = {
          id: newId(),
          type: type || "peaking",
          freq: type === "highpass" ? 8000 : type === "lowpass" ? 60 : 1000,
          gain: 0, q: type === "peaking" ? 1.2 : 0.7, on: true,
        };
        data.bands.push(band);
        data.bands.sort((a, b) => a.freq - b.freq);
        selected = band.id;
        commit();
        return band;
      },
      remove(id) {
        data.bands = data.bands.filter((b) => b.id !== id);
        if (selected === id) selected = null;
        commit();
      },
      update(id, patch) {
        const band = data.bands.find((b) => b.id === id);
        if (!band) return;
        Object.assign(band, patch);
        commit();
      },
    };
  }

  function fmtHz(f) {
    if (f >= 10000) return `${(f / 1000).toFixed(1)}k`;
    if (f >= 1000) return `${(f / 1000).toFixed(2)}k`;
    return `${Math.round(f)}`;
  }

  return { create, fmtHz, TYPE_LABEL, FLAT, newId };
})();
