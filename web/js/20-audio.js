/* The playback engine.
 *
 * Two decks, and each one has its own processing. Both play, one of them is silent, and
 * switching A to B is a gain swap on the next audio block: the same bar of the other
 * take with no gap and no fade.
 *
 *   deck A ─ filters… ─ limiter ─ makeup ─ gain A ─┐
 *                                                  ├─ master ─ analyser ─ out
 *   deck B ─ filters… ─ limiter ─ makeup ─ gain B ─┘
 *
 * The chains are separate rather than shared because a slot carries a preset as well as
 * a version. Comparing the same mix through two different equalisers is as much the
 * point as comparing two mixes, and a shared chain could not do it.
 *
 * None of this is written to the stored file. It is applied while the browser plays.
 */
"use strict";

J.audio = (function () {
  let ctx = null;
  let master = null, analyser = null;
  let peakBuffer = null;
  const decks = {};

  const FLAT = { bands: [], limiter: { on: false }, gain: 0, bypass: false };

  function context() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();

    master = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.78;
    analyser.minDecibels = -96;
    analyser.maxDecibels = -6;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    return ctx;
  }

  function deck(slot) {
    if (decks[slot]) return decks[slot];
    const element = new Audio();
    element.preload = "auto";
    element.crossOrigin = "anonymous";
    decks[slot] = {
      element, source: null, input: null, gain: null,
      limiter: null, makeup: null, filters: [],
      settings: Object.assign({}, FLAT), versionId: null,
    };
    return decks[slot];
  }

  /* A media element can only ever be handed to one source node, so this runs once per
   * deck and every later track just changes element.src. */
  function wire(slot) {
    const audioCtx = context();
    const entry = deck(slot);
    if (!audioCtx || entry.source) return entry;

    entry.source = audioCtx.createMediaElementSource(entry.element);
    entry.input = audioCtx.createGain();
    entry.limiter = audioCtx.createDynamicsCompressor();
    entry.makeup = audioCtx.createGain();
    entry.gain = audioCtx.createGain();
    entry.gain.gain.value = 0;

    entry.limiter.knee.value = 0;
    entry.limiter.ratio.value = 20;   // a compressor this steep is a limiter in all but name
    entry.limiter.attack.value = 0.003;
    entry.limiter.release.value = 0.12;
    entry.limiter.threshold.value = 0;

    entry.source.connect(entry.input);
    entry.makeup.connect(entry.gain);
    entry.gain.connect(master);
    rebuild(slot);
    return entry;
  }

  /* Rewire one deck's filters. Only when the set of bands changes; moving a node changes
   * parameters in place so the audio never stops. */
  function rebuild(slot) {
    const entry = decks[slot];
    if (!entry || !entry.input) return;
    entry.filters.forEach((f) => { try { f.disconnect(); } catch (e) { /* gone */ } });
    try { entry.input.disconnect(); } catch (e) { /* first build */ }
    entry.filters = [];

    const settings = entry.settings;
    if (!settings.bypass) {
      for (const band of settings.bands || []) {
        if (!band.on) continue;
        const filter = ctx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = J.clamp(band.freq, 10, ctx.sampleRate / 2 - 100);
        filter.Q.value = band.q;
        filter.gain.value = band.gain;
        filter._id = band.id;
        entry.filters.push(filter);
      }
    }
    let node = entry.input;
    for (const filter of entry.filters) {
      node.connect(filter);
      node = filter;
    }
    node.connect(entry.limiter);
    entry.limiter.connect(entry.makeup);
    applyLimiter(slot);
  }

  function applyLimiter(slot) {
    const entry = decks[slot];
    if (!entry || !entry.limiter) return;
    const settings = entry.settings;
    const lim = settings.limiter || {};
    const on = lim.on && !settings.bypass;
    entry.limiter.threshold.value = on ? J.clamp(lim.threshold, -60, 0) : 0;
    entry.limiter.release.value = on ? J.clamp((lim.release || 120) / 1000, 0.001, 1) : 0.25;
    entry.limiter.attack.value = on ? J.clamp((lim.attack || 5) / 1000, 0, 0.1) : 0.003;
    // The ceiling is where the output should land, so the makeup carries the difference
    // rather than the person doing that arithmetic.
    const ceiling = on ? J.clamp(lim.ceiling, -30, 0) : 0;
    const trim = settings.bypass ? 0 : (settings.gain || 0);
    entry.makeup.gain.value = Math.pow(10, (ceiling + trim) / 20);
  }

  return {
    context,
    deck,
    wire,

    /* The head of one deck's chain.
     *
     * The compositor connects its scheduled clips here rather than to the destination,
     * so arranged playback goes through the same filters, limiter and gain as a plain
     * one does. Feeding both decks from one set of sources is what lets A and B swap
     * equalisers on the same audio with nothing restarting. */
    inputOf(slot) {
      const entry = wire(slot);
      return entry ? entry.input : null;
    },

    get analyser() { return analyser; },
    get ready() { return !!ctx; },

    async resume() {
      const audioCtx = context();
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      return audioCtx;
    },

    /* A few milliseconds of ramp: short enough to be inaudible, long enough that the
     * gain step does not click. */
    setDeckGain(slot, value, seconds) {
      const entry = decks[slot];
      if (!entry || !entry.gain || !ctx) return;
      const now = ctx.currentTime;
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(value, now + (seconds === undefined ? 0.008 : seconds));
    },

    setVolume(value) {
      if (context()) master.gain.value = J.clamp(value, 0, 1);
    },

    /* Give one deck its sound. Called when a slot's preset changes and while a curve is
     * being dragged, so it has to be cheap when only numbers moved. */
    applyTo(slot, next) {
      const entry = deck(slot);
      const before = JSON.stringify((entry.settings.bands || []).map((b) => [b.id, b.type, b.on]));
      entry.settings = Object.assign({}, FLAT, next || {});
      const after = JSON.stringify((entry.settings.bands || []).map((b) => [b.id, b.type, b.on]));
      if (!ctx || !entry.input) return;
      if (before !== after) { rebuild(slot); return; }
      for (const band of entry.settings.bands || []) {
        const filter = entry.filters.find((f) => f._id === band.id);
        if (!filter) continue;
        filter.frequency.value = J.clamp(band.freq, 10, ctx.sampleRate / 2 - 100);
        filter.Q.value = band.q;
        filter.gain.value = band.gain;
      }
      applyLimiter(slot);
    },

    settingsOf(slot) {
      return (decks[slot] && decks[slot].settings) || Object.assign({}, FLAT);
    },

    /* Magnitude in dB of an arbitrary set of bands, at the given frequencies.
     *
     * The filters made here are never connected, so a curve can be drawn for a song that
     * is not playing without disturbing the one that is. */
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

    /* How hard this deck's limiter is pulling down, in dB. */
    reductionOf(slot) {
      const entry = decks[slot];
      return entry && entry.limiter ? Math.abs(entry.limiter.reduction || 0) : 0;
    },

    spectrum(target) {
      if (!analyser) return null;
      analyser.getByteFrequencyData(target);
      return target;
    },

    /* Peak output level in dB, for the limiter's meter.
     *
     * Read from the waveform rather than the spectrum: a frequency bin says how much of
     * one band is present, and a meter is asking how loud the whole thing is. */
    peakDb() {
      if (!analyser) return -60;
      if (!peakBuffer || peakBuffer.length !== analyser.fftSize) {
        peakBuffer = new Uint8Array(analyser.fftSize);
      }
      analyser.getByteTimeDomainData(peakBuffer);
      let peak = 0;
      for (let i = 0; i < peakBuffer.length; i++) {
        const sample = Math.abs(peakBuffer[i] - 128) / 128;
        if (sample > peak) peak = sample;
      }
      return peak > 0.0002 ? 20 * Math.log10(peak) : -60;
    },
  };
})();
