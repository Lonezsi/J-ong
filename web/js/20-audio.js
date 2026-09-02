/* The playback engine.
 *
 * Two decks rather than one. Both hold a version of the same song, both play, and only
 * one is audible. Switching A to B is a gain swap on the next audio block, so you hear
 * the same bar of the other mix with no gap and no fade. That is the whole reason this
 * is not a single <audio> element.
 *
 *   deck A ─┐
 *           ├─ chain in ─ biquad… ─ limiter ─ makeup ─ master ─ analyser ─ out
 *   deck B ─┘
 *
 * The EQ and limiter are playback only. Nothing here writes to the stored file.
 */
"use strict";

J.audio = (function () {
  let ctx = null;
  let chainIn = null, limiter = null, makeup = null, master = null, analyser = null;
  let filters = [];
  let settings = { bands: [], limiter: { on: false }, gain: 0, bypass: false };
  const decks = {};

  function context() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();

    chainIn = ctx.createGain();
    limiter = ctx.createDynamicsCompressor();
    makeup = ctx.createGain();
    master = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -96;
    analyser.maxDecibels = -6;

    limiter.knee.value = 0;
    limiter.ratio.value = 20;      // a compressor this steep is a limiter in all but name
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    limiter.threshold.value = 0;

    makeup.connect(master);
    master.connect(analyser);
    analyser.connect(ctx.destination);
    rebuild();
    return ctx;
  }

  /* Rewire the filter chain. Called whenever a band is added, removed or retyped;
   * moving an existing band only changes its parameters and does not come through here. */
  function rebuild() {
    if (!ctx) return;
    filters.forEach((f) => { try { f.disconnect(); } catch (e) { /* already gone */ } });
    try { chainIn.disconnect(); } catch (e) { /* first build */ }
    filters = [];

    if (!settings.bypass) {
      for (const band of settings.bands) {
        if (!band.on) continue;
        const filter = ctx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = J.clamp(band.freq, 10, ctx.sampleRate / 2 - 100);
        filter.Q.value = band.q;
        filter.gain.value = band.gain;
        filter._id = band.id;
        filters.push(filter);
      }
    }

    let node = chainIn;
    for (const filter of filters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(limiter);
    limiter.connect(makeup);
    applyLimiter();
  }

  function applyLimiter() {
    if (!ctx) return;
    const lim = settings.limiter || {};
    const on = lim.on && !settings.bypass;
    limiter.threshold.value = on ? J.clamp(lim.threshold, -60, 0) : 0;
    limiter.release.value = on ? J.clamp((lim.release || 120) / 1000, 0.001, 1) : 0.25;
    limiter.attack.value = on ? J.clamp((lim.attack || 5) / 1000, 0, 0.1) : 0.003;
    // The ceiling is where the output should land, so the makeup gain carries the
    // difference between it and unity rather than the user doing that arithmetic.
    const ceiling = on ? J.clamp(lim.ceiling, -30, 0) : 0;
    const trim = settings.bypass ? 0 : (settings.gain || 0);
    makeup.gain.value = Math.pow(10, (ceiling + trim) / 20);
  }

  function deck(name) {
    if (decks[name]) return decks[name];
    const element = new Audio();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    const entry = { element, gain: null, source: null, versionId: null };
    decks[name] = entry;
    return entry;
  }

  /* A media element can only ever be given one source node, so this happens once per
   * deck and every later track just changes element.src. */
  function wire(entry) {
    const audioCtx = context();
    if (!audioCtx || entry.source) return;
    entry.source = audioCtx.createMediaElementSource(entry.element);
    entry.gain = audioCtx.createGain();
    entry.gain.gain.value = 0;
    entry.source.connect(entry.gain);
    entry.gain.connect(chainIn);
  }

  return {
    context,
    deck,
    wire,
    get analyser() { return analyser; },
    get ready() { return !!ctx; },

    async resume() {
      const audioCtx = context();
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      return audioCtx;
    },

    /* Fade a deck in or out over a few milliseconds. Not a crossfade: the ramp is short
     * enough to be inaudible and only exists to avoid the click a hard gain step makes. */
    setDeckGain(name, value, seconds) {
      const entry = decks[name];
      if (!entry || !entry.gain || !ctx) return;
      const now = ctx.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(value, now + (seconds === undefined ? 0.008 : seconds));
    },

    setVolume(value) {
      const audioCtx = context();
      if (audioCtx) master.gain.value = J.clamp(value, 0, 1);
    },

    apply(next) {
      const before = JSON.stringify((settings.bands || []).map((b) => [b.id, b.type, b.on]));
      settings = Object.assign({ bands: [], limiter: {}, gain: 0, bypass: false }, next || {});
      const after = JSON.stringify((settings.bands || []).map((b) => [b.id, b.type, b.on]));
      if (!ctx) return;
      if (before !== after) {
        rebuild();
        return;
      }
      // Same set of bands, so only the numbers moved. Setting parameters in place keeps
      // the audio running while a node is dragged.
      for (const band of settings.bands) {
        const filter = filters.find((f) => f._id === band.id);
        if (!filter) continue;
        filter.frequency.value = J.clamp(band.freq, 10, ctx.sampleRate / 2 - 100);
        filter.Q.value = band.q;
        filter.gain.value = band.gain;
      }
      applyLimiter();
    },

    get settings() { return settings; },

    /* Magnitude in dB of an arbitrary set of bands, at the given frequencies.
     *
     * The filters made here are never connected to anything, so this computes the curve
     * for a song that is not playing without disturbing the song that is. That matters:
     * the sound panel is reachable for any song while another one sounds. */
    responseOf(bands, frequencies, bypass) {
      const audioCtx = context();
      const out = new Float32Array(frequencies.length);
      if (!audioCtx || bypass) return out;
      const total = new Float32Array(frequencies.length).fill(1);
      const mag = new Float32Array(frequencies.length);
      const phase = new Float32Array(frequencies.length);
      const nyquist = audioCtx.sampleRate / 2;
      for (const band of bands || []) {
        if (!band.on) continue;
        const filter = audioCtx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = J.clamp(band.freq, 10, nyquist - 100);
        filter.Q.value = J.clamp(band.q, 0.05, 30);
        filter.gain.value = J.clamp(band.gain, -30, 30);
        filter.getFrequencyResponse(frequencies, mag, phase);
        for (let i = 0; i < total.length; i++) total[i] *= mag[i];
      }
      for (let i = 0; i < total.length; i++) out[i] = 20 * Math.log10(total[i] || 1e-6);
      return out;
    },

    /* How much the limiter is pulling down, in dB, for the meter. */
    get reduction() {
      return limiter ? Math.abs(limiter.reduction || 0) : 0;
    },

    spectrum(target) {
      if (!analyser) return null;
      analyser.getByteFrequencyData(target);
      return target;
    },
  };
})();
