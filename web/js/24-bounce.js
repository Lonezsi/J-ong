/* Writing out what you have been listening to.
 *
 * Everything else in this app is playback only: the equaliser, the limiter and the
 * arrangement are applied while the browser plays and the stored render is never
 * touched. That is the right default and it stays the default. This is the one place
 * that deliberately produces a new file, because sending a mix somewhere means sending
 * a file, and a file that does not have the curve on it is not the mix you approved.
 *
 * The chain is not rebuilt here. J.audio.chainInto builds it in whichever context it is
 * given, so the deck you listened through and the pass that writes the file are the same
 * node order by construction. Two copies would drift, and nothing could tell you: no test
 * can compare a graph in one file against a graph in another. The only defence is that
 * there is one.
 *
 * It renders faster than real time. An OfflineAudioContext runs as fast as the machine
 * can manage, so a four minute song is a few seconds, not four minutes.
 */
"use strict";

J.bounce = (function () {
  /* A little headroom past the last clip.
   *
   * A limiter's release is up to a second, and a reverb tail lives in the render rather
   * than in the chain, so cutting at the last sample of the last clip clips the decay of
   * whatever was still ringing. */
  const TAIL = 1.5;

  /* What would be written, described before anything is rendered.
   *
   * Shown on the form so it is clear what is about to happen: which take, which curve,
   * arranged or whole, and how long the result will be. Nobody should have to press
   * Render to find out what Render is going to do.
   */
  function plan(ctx) {
    const version = ctx.currentVersion();
    const arranged = !!(J.arrange && J.arrange.state.enabled
                        && J.arrange.state.songId === ctx.song.id
                        && J.arrange.state.clips.length);
    const preset = (ctx.presets || []).find((p) => p.is_current) || (ctx.presets || [])[0];
    const bands = preset ? (preset.data.bands || []).filter((b) => b.on).length : 0;
    const limiter = preset && (preset.data.limiter || {}).on && !preset.data.bypass;
    return {
      version,
      arranged,
      preset,
      bands: preset && preset.data.bypass ? 0 : bands,
      limiter: !!limiter,
      seconds: arranged ? J.arrange.duration() : (version ? version.duration || 0 : 0),
    };
  }

  /* The audio, with everything applied. Resolves to an AudioBuffer. */
  async function render(ctx, { preset, arranged, onProgress } = {}) {
    const say = onProgress || (() => {});
    const version = ctx.currentVersion();
    if (!version) throw new Error("This song has no render to work from.");

    say("reading the take", 0.05);
    const source = await sourceBuffer(ctx, version);

    const useArrangement = arranged && J.arrange && J.arrange.state.clips.length
                           && J.arrange.state.songId === ctx.song.id;
    const rows = useArrangement ? J.arrange.laid() : null;
    const seconds = (useArrangement ? J.arrange.duration() : source.duration) + TAIL;

    say("laying it out", 0.2);
    const offline = new OfflineAudioContext(
      Math.min(2, source.numberOfChannels) || 1,
      Math.ceil(seconds * source.sampleRate),
      source.sampleRate);

    const chain = J.audio.chainInto(offline, preset ? preset.data : null);
    chain.output.connect(offline.destination);

    if (rows) {
      // The same rows the player schedules, so an arranged export is the arrangement
      // rather than a second reading of the same clips.
      for (const row of rows) {
        const playable = Math.min(row.seconds,
                                  Math.max(0, source.duration - row.sourceAt));
        if (playable <= 0.001) continue;
        const node = offline.createBufferSource();
        node.buffer = source;
        node.connect(chain.input);
        node.start(row.at, row.sourceAt, playable);
      }
    } else {
      const node = offline.createBufferSource();
      node.buffer = source;
      node.connect(chain.input);
      node.start(0);
    }

    say("rendering", 0.35);
    const done = await offline.startRendering();
    say("done", 1);
    return done;
  }

  /* The decoded audio for a version.
   *
   * Fetched and decoded here rather than borrowed from the compositor's cache. Reaching
   * into another module's decoded copy saves a few seconds and couples this to the exact
   * shape of that cache: the first attempt treated its loader, which is asynchronous and
   * takes arguments, as though it were a plain getter, and got back a pending promise
   * that passed a truthiness check and then had no duration. A file this is about to
   * upload is worth reading twice. */
  async function sourceBuffer(ctx, version) {
    const response = await fetch(`/api/versions/${version.id}/audio`);
    if (!response.ok) throw new Error("That render could not be read back.");
    const bytes = await response.arrayBuffer();
    const audioCtx = J.audio.context() || new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await audioCtx.decodeAudioData(bytes);
    if (!decoded || !decoded.length) throw new Error("That render decoded to nothing.");
    return decoded;
  }

  /* A WAV, written by hand.
   *
   * Sixteen bit because that is what everything downstream expects and it halves the
   * size of a file that is about to be uploaded. Dithering is deliberately absent: this
   * is a delivery copy of something already mastered, not a mix step, and a dither
   * nobody asked for is a change to the sound made behind their back.
   */
  function toWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels);
    const frames = buffer.length;
    const rate = buffer.sampleRate;
    const bytes = new ArrayBuffer(44 + frames * channels * 2);
    const view = new DataView(bytes);

    const text = (at, value) => {
      for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
    };
    text(0, "RIFF");
    view.setUint32(4, 36 + frames * channels * 2, true);
    text(8, "WAVE");
    text(12, "fmt ");
    view.setUint32(16, 16, true);            // PCM header length
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * channels * 2, true);
    view.setUint16(32, channels * 2, true);
    view.setUint16(34, 16, true);
    text(36, "data");
    view.setUint32(40, frames * channels * 2, true);

    const lanes = [];
    for (let c = 0; c < channels; c++) lanes.push(buffer.getChannelData(c));

    let at = 44;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < channels; c++) {
        // Clamped, because the limiter's ceiling is where the output should land and
        // anything past full scale would wrap round to the opposite polarity.
        const sample = Math.max(-1, Math.min(1, lanes[c][i]));
        view.setInt16(at, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
        at += 2;
      }
    }
    return new Blob([view], { type: "audio/wav" });
  }

  /* The loudest sample in the result, so the form can say whether it clipped. */
  function peakOf(buffer) {
    let peak = 0;
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
      const lane = buffer.getChannelData(c);
      for (let i = 0; i < lane.length; i += 7) {
        const value = lane[i] < 0 ? -lane[i] : lane[i];
        if (value > peak) peak = value;
      }
    }
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  return { plan, render, toWav, peakOf, TAIL };
}());
