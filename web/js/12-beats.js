/* Working out the tempo, and where the sections change.
 *
 * Both of these are guesses. They are good guesses for the music this is for, which has
 * a drum machine keeping time, and they are wrong sometimes, so everything here is
 * offered as a starting point that can be corrected by hand rather than as a fact.
 *
 * How the tempo is found:
 *
 *   1. Reduce the audio to an onset strength envelope: how much more energy there is in
 *      this short window than the one before. Rises matter, falls do not, because a hit
 *      is a rise. This is per band rather than on the raw waveform, so a kick and a hat
 *      both register instead of the loudest element winning.
 *   2. Autocorrelate the envelope. A steady tempo makes the envelope resemble itself one
 *      beat later, so the lag with the strongest agreement is the beat length.
 *   3. Fold the answer into a sensible range. Autocorrelation is just as happy with half
 *      or double the real tempo, and 75 and 300 are the same song as 150.
 *   4. Find the phase: slide the grid and keep the offset where beats land on onsets.
 *
 * Sections are found from the same envelope at bar resolution: a section boundary is a
 * bar that sounds unlike the bars before it, which is what "the drums come in" is.
 */
"use strict";

J.beats = (function () {
  //: Windows per second of envelope. 100 is fine enough to place a beat within 10ms and
  //: coarse enough that the autocorrelation stays cheap on a five minute song.
  const RATE = 100;
  const LOW = 60, HIGH = 190;      // the range tempos get folded into

  /* Onset strength over time, at RATE windows a second.
   *
   * Sub-band rather than broadband: summing the rises in several frequency bands stops a
   * loud bass line from burying a hi-hat, which is what makes this work on a mix rather
   * than only on a drum loop.
   */
  function envelope(channel, sampleRate) {
    const hop = Math.max(1, Math.round(sampleRate / RATE));
    const window = hop * 2;
    const frames = Math.floor((channel.length - window) / hop);
    if (frames < 8) return { values: new Float32Array(0), rate: RATE };

    const BANDS = 6;
    const previous = new Float32Array(BANDS);
    const values = new Float32Array(frames);

    for (let frame = 0; frame < frames; frame++) {
      const start = frame * hop;
      // Energy per band, from a cheap split rather than an FFT. Neighbouring samples
      // differ most at high frequencies and least at low ones, so a cascade of one pole
      // smoothers separates the spectrum well enough to tell a kick from a hat.
      const band = new Float32Array(BANDS);
      let a = 0, b = 0, c = 0, d = 0, e = 0;
      for (let i = start; i < start + window; i++) {
        const x = channel[i];
        a += (x - a) * 0.02;          // sub
        b += (x - b) * 0.08;          // bass
        c += (x - c) * 0.25;          // low mid
        d += (x - d) * 0.5;           // mid
        e += (x - e) * 0.8;           // high mid
        band[0] += a * a;
        band[1] += (b - a) * (b - a);
        band[2] += (c - b) * (c - b);
        band[3] += (d - c) * (d - c);
        band[4] += (e - d) * (e - d);
        band[5] += (x - e) * (x - e);
      }
      let sum = 0;
      for (let k = 0; k < BANDS; k++) {
        // Log domain: a hit is a ratio, not a difference, so this reacts the same way in
        // a quiet intro and a loud chorus.
        const now = Math.log1p(band[k] / window * 1000);
        const rise = now - previous[k];
        if (rise > 0) sum += rise;
        previous[k] = now;
      }
      values[frame] = sum;
    }

    // Take the slow moving average out, so a build up does not read as one long onset.
    const smoothed = new Float32Array(frames);
    let running = 0;
    for (let i = 0; i < frames; i++) {
      running += (values[i] - running) * 0.02;
      smoothed[i] = Math.max(0, values[i] - running);
    }
    return { values: smoothed, rate: RATE };
  }

  /* Fold a tempo into the range people would actually name it. */
  function fold(bpm) {
    if (!bpm || !Number.isFinite(bpm)) return 120;
    while (bpm < LOW) bpm *= 2;
    while (bpm > HIGH) bpm /= 2;
    return bpm;
  }

  /* The strongest periodicity in an onset envelope, in beats per minute.
   *
   * Only tempos a person would name are considered, and each one is judged by whether
   * the envelope agrees with itself at one beat, two beats, three and four. That is what
   * separates a tempo from half of it: at 140 the envelope also matches at 70, but only
   * 140 also matches at 280 and 420. Scoring the lag on its own picks the half every
   * time, which is exactly what this used to do.
   */
  function tempoOf(env) {
    const { values, rate } = env;
    if (values.length < rate * 4) return { bpm: 120, confidence: 0 };

    let mean = 0;
    for (let i = 0; i < values.length; i++) mean += values[i];
    mean /= values.length;

    const maxLag = Math.min(Math.ceil(rate * 60 / LOW) * 4 + 2, values.length - 2);
    const acf = new Float32Array(maxLag + 1);
    let zero = 0;
    for (let i = 0; i < values.length; i++) zero += (values[i] - mean) * (values[i] - mean);
    zero /= values.length;
    for (let lag = 1; lag <= maxLag; lag++) {
      let sum = 0;
      const n = values.length - lag;
      for (let i = 0; i < n; i++) sum += (values[i] - mean) * (values[i + lag] - mean);
      // Divided by the overlap so a long lag is not punished for having fewer samples.
      acf[lag] = zero > 0 ? (sum / n) / zero : 0;
    }

    // The lag is rarely a whole number of windows, so read between them.
    const at = (lag) => {
      if (lag < 1 || lag >= maxLag) return 0;
      const low = Math.floor(lag);
      const frac = lag - low;
      return acf[low] * (1 - frac) + acf[low + 1] * frac;
    };

    const WEIGHTS = [1, 0.8, 0.55, 0.4];

    /* A preference for tempos near walking pace.
     *
     * Harmonic scoring alone still leans towards the half, because a four bar pattern
     * agrees with itself at every even multiple of the beat and the half tempo samples
     * only those. The way out is the one every tempo tracker uses: music is not
     * uniformly distributed across tempos, and 75 is a far less likely answer than 150.
     * This does not settle it in every case, which is why the panel offers halve and
     * double as one press each.
     */
    const CENTRE = 125, WIDTH = 0.8;      // octaves
    const prior = (candidate) => {
      const octaves = Math.log2(candidate / CENTRE) / WIDTH;
      return Math.exp(-0.5 * octaves * octaves);
    };

    let bpm = 120, bestScore = -Infinity;
    for (let candidate = LOW; candidate <= HIGH; candidate += 0.1) {
      const lag = rate * 60 / candidate;
      let score = 0;
      for (let h = 0; h < WEIGHTS.length; h++) score += WEIGHTS[h] * at(lag * (h + 1));
      score *= prior(candidate);
      if (score > bestScore) { bestScore = score; bpm = candidate; }
    }

    // Round to a sensible precision. Nobody writes 127.7, and a tenth of a bpm drifts a
    // beat over four minutes, so the nearest whole number is both tidier and truer.
    const rounded = Math.round(bpm);
    const lag = rate * 60 / rounded;
    let keepScore = 0;
    for (let h = 0; h < WEIGHTS.length; h++) keepScore += WEIGHTS[h] * at(lag * (h + 1));
    keepScore *= prior(rounded);
    const keep = keepScore < bestScore * 0.97 ? Math.round(bpm * 10) / 10 : rounded;

    /* Scaled against what real mixes score rather than against the theoretical maximum.
     * Summing four weighted correlations could reach 2.75, but a real record with live
     * drums and a swung hat sits nearer 0.9 at its clearest, so dividing by the
     * theoretical figure reported everything as a coin toss and the warning stopped
     * meaning anything. */
    return { bpm: keep, confidence: Math.max(0, Math.min(1, bestScore / 0.9)) };
  }

  /* Where beat one sits, in seconds.
   *
   * The tempo says how far apart the beats are; this says where they start. Every offset
   * within one beat is tried and the one whose grid collects the most onset strength
   * wins, which is the same thing your foot does.
   */
  function phaseOf(env, bpm) {
    const { values, rate } = env;
    const period = rate * 60 / bpm;
    if (!values.length || !Number.isFinite(period) || period < 2) return 0;
    let best = 0, bestScore = -Infinity;
    const steps = Math.max(8, Math.round(period));
    for (let step = 0; step < steps; step++) {
      const start = step * period / steps;
      let score = 0;
      for (let beat = 0; ; beat++) {
        const at = Math.round(start + beat * period);
        if (at >= values.length) break;
        score += values[at];
      }
      if (score > bestScore) { bestScore = score; best = start; }
    }
    return best / rate;
  }

  /* Section boundaries, as bar numbers.
   *
   * Bars rather than beats because sections change on bars, and a boundary half a bar
   * out is worse than no boundary at all. A bar is compared with the four before it; the
   * bars that differ most, spaced at least four bars apart, are where the music changed.
   */
  function sectionsOf(env, bpm, offset, perBar, totalBeats) {
    const { values, rate } = env;
    const beat = rate * 60 / bpm;
    const barLength = beat * perBar;
    const first = offset * rate;
    const bars = Math.floor((values.length - first) / barLength);
    if (bars < 4) return [0];

    // One number per bar: how much onset energy it holds, and how it is spread.
    const loudness = new Float32Array(bars);
    const spread = new Float32Array(bars);
    for (let bar = 0; bar < bars; bar++) {
      const from = Math.round(first + bar * barLength);
      const to = Math.round(first + (bar + 1) * barLength);
      let sum = 0, peak = 0;
      for (let i = from; i < to && i < values.length; i++) {
        sum += values[i];
        if (values[i] > peak) peak = values[i];
      }
      loudness[bar] = sum / Math.max(1, to - from);
      spread[bar] = peak;
    }

    const change = new Float32Array(bars);
    for (let bar = 1; bar < bars; bar++) {
      const back = Math.max(0, bar - 4);
      let before = 0, count = 0;
      for (let i = back; i < bar; i++) { before += loudness[i]; count++; }
      before /= Math.max(1, count);
      const now = loudness[bar];
      change[bar] = Math.abs(now - before) / (before + now + 1e-6)
                  + 0.35 * Math.abs(spread[bar] - spread[bar - 1]) / (spread[bar] + spread[bar - 1] + 1e-6);
    }

    // Musical sections are rarely shorter than four bars and rarely longer than sixteen,
    // so boundaries are taken greedily with a minimum gap and a cap on the count.
    const order = Array.from({ length: bars }, (_, i) => i).sort((a, b) => change[b] - change[a]);
    const chosen = [0];
    const wanted = Math.max(2, Math.min(10, Math.round(bars / 8)));
    for (const bar of order) {
      if (chosen.length >= wanted) break;
      if (bar < 2) continue;
      if (chosen.some((c) => Math.abs(c - bar) < 4)) continue;
      if (change[bar] < 0.06) continue;
      chosen.push(bar);
    }
    chosen.sort((a, b) => a - b);
    return chosen;
  }

  return {
    envelope,
    tempoOf,
    phaseOf,
    sectionsOf,
    fold,

    /* Everything at once, from a decoded buffer. Returns bpm, offset and parts in beats. */
    read(buffer, perBar) {
      const bars = perBar || 4;
      const channel = buffer.numberOfChannels > 1
        ? mixdown(buffer) : buffer.getChannelData(0);

      /* A render that turned out silent is common enough to name.
       *
       * A quarter of a batch of FL projects can bounce to nothing, because the master
       * was muted or the playlist was empty when it was saved. Guessing a tempo for
       * silence produces a confident looking grid over nothing at all, which sends you
       * looking for the fault in the wrong place. */
      let peak = 0;
      for (let i = 0; i < channel.length; i += 97) {
        const value = channel[i] < 0 ? -channel[i] : channel[i];
        if (value > peak) peak = value;
      }
      if (peak < 0.01) {
        return { bpm: 120, offset: 0, confidence: 0, parts: [], totalBeats: 0,
                 silent: true };
      }

      const env = envelope(channel, buffer.sampleRate);
      const { bpm, confidence } = tempoOf(env);
      const offset = phaseOf(env, bpm);
      const beatSeconds = 60 / bpm;
      const totalBeats = Math.max(1, (buffer.duration - offset) / beatSeconds);
      const boundaries = sectionsOf(env, bpm, offset, bars, totalBeats);

      const parts = boundaries.map((bar, index) => {
        const nextBar = index + 1 < boundaries.length
          ? boundaries[index + 1] : Math.ceil(totalBeats / bars);
        return {
          id: "p" + (index + 1),
          name: "Part " + (index + 1),
          from: bar * bars,
          beats: Math.max(bars, (nextBar - bar) * bars),
          hue: (140 + index * 47) % 360,
        };
      });
      return { bpm, offset, confidence, parts, totalBeats };
    },
  };

  function mixdown(buffer) {
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const out = new Float32Array(left.length);
    for (let i = 0; i < left.length; i++) out[i] = (left[i] + right[i]) * 0.5;
    return out;
  }
})();
