/* Drawing what a render looks like.
 *
 * Two uses, one set of numbers. The compositor needs a waveform you can aim at, and the
 * renders list wants a small picture of the same thing that you are not meant to touch.
 * Both come from a peak summary: for each column of pixels, the loudest sample in it.
 * Peaks rather than an average, because an average of a loud passage and a quiet one is
 * a flat grey line that tells you nothing about where the song changes.
 *
 * The summary is cached per version, because computing it means decoding the file and a
 * five minute wav takes long enough that doing it twice is noticeable.
 */
"use strict";

J.wave = (function () {
  const cache = new Map();          // version id -> Float32Array of peaks
  const COLUMNS = 1400;             // enough for a wide screen, cheap enough to keep

  /* Peak per column, 0..1. */
  function peaksOf(buffer, columns) {
    const count = columns || COLUMNS;
    const out = new Float32Array(count);
    const channels = Math.min(2, buffer.numberOfChannels);
    const step = buffer.length / count;
    for (let c = 0; c < channels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < count; i++) {
        const from = Math.floor(i * step);
        const to = Math.min(data.length, Math.floor((i + 1) * step));
        let peak = 0;
        // Every sample of a five minute file is millions of reads; stepping through a
        // column in strides is indistinguishable by eye and far quicker.
        const stride = Math.max(1, Math.floor((to - from) / 400));
        for (let s = from; s < to; s += stride) {
          const value = data[s] < 0 ? -data[s] : data[s];
          if (value > peak) peak = value;
        }
        if (peak > out[i]) out[i] = peak;
      }
    }
    return out;
  }

  return {
    peaksOf,

    remember(versionId, peaks) { cache.set(versionId, peaks); },
    known(versionId) { return cache.get(versionId) || null; },
    forget(versionId) { cache.delete(versionId); },

    /* Draw a slice of the peaks into a canvas.
     *
     * `from` and `to` are fractions of the whole file, so a clip can draw exactly the
     * part of the render it uses without the caller doing any arithmetic.
     */
    draw(canvas, peaks, options) {
      const opts = options || {};
      const ctx = canvas.getContext("2d");
      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 1;
      const height = canvas.clientHeight || 1;
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, width, height);
      if (!peaks || !peaks.length) return;

      const from = J.clamp(opts.from === undefined ? 0 : opts.from, 0, 1);
      const to = J.clamp(opts.to === undefined ? 1 : opts.to, 0, 1);
      const span = Math.max(1e-6, to - from);
      const middle = height / 2;
      const scale = (opts.scale || 0.92) * middle;

      ctx.fillStyle = opts.color || "rgba(255,255,255,0.5)";
      const columns = Math.max(1, Math.floor(width));
      for (let x = 0; x < columns; x++) {
        const at = from + (x / columns) * span;
        const index = J.clamp(Math.floor(at * peaks.length), 0, peaks.length - 1);
        const peak = peaks[index];
        // A floor of one pixel: silence should read as a line, not as a gap that looks
        // like the drawing failed.
        const tall = Math.max(1, peak * scale);
        ctx.fillRect(x, middle - tall, 1, tall * 2);
      }
    },
  };
})();
