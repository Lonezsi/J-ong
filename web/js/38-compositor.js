/* The compositor panel.
 *
 * One track of clips, laid end to end, every edge on a beat. The moves are the ones the
 * job actually needs:
 *
 *   drag the middle      put this section somewhere else in the order
 *   drag an edge         make it shorter or longer, a beat at a time
 *   double click         duplicate it, which is how a chorus goes round twice
 *   backspace            take it out
 *
 * Nothing snaps to anything but the beat, because a section that starts half a beat late
 * is never what anyone meant. The grid comes from the tempo, the tempo was a guess, and
 * the guess is stated as a guess with halve, double and tap next to it.
 */
"use strict";

J.compositor = (function () {
  //: How wide a beat is on screen at rest. Zooming is one number, so a long song and a
  //: short one both start out readable.
  const BASE_PX_PER_BEAT = 9;

  function mount(root, ctx) {
    const A = J.arrange;
    let zoom = 1;
    let dragging = null;

    const pxPerBeat = () => BASE_PX_PER_BEAT * zoom;

    function draw() {
      const parts = A.state.parts;
      const clips = A.state.clips;
      const total = A.totalBeats();
      const bars = A.state.perBar;

      root.innerHTML = `
        <div class="comp-head">
          <div class="comp-tempo">
            <button class="btn sm ghost" data-act="half" title="Half the tempo">&divide;2</button>
            <label class="comp-bpm">
              <input class="field" id="compBpm" type="number" min="20" max="400" step="0.1"
                     value="${Math.round(A.state.bpm * 10) / 10}" aria-label="Beats per minute">
              <span>bpm</span>
            </label>
            <button class="btn sm ghost" data-act="double" title="Double the tempo">&times;2</button>
            <button class="btn sm ghost" data-act="tap" title="Tap four beats">Tap</button>
            ${A.state.clips.length && A.state.confidence > 0 && A.state.confidence < 0.45
              ? `<span class="tag warn" title="The beat was hard to hear in this render. Check the tempo, and try halve or double.">unsure</span>`
              : ""}
          </div>

          <label class="comp-onoff" title="${A.state.clips.length
            ? "Play this song through the arrangement instead of straight through"
            : "Lay the song out first"}">
            <button class="switch ${A.state.enabled ? "on" : ""}" data-act="onoff"
                    aria-label="Play this song as arranged"
                    ${A.state.clips.length ? "" : "disabled"}></button>
            <span>Play as arranged</span>
          </label>

          <span class="grow"></span>
          <div class="comp-zoom">
            <button class="icon-btn sm" data-act="out" aria-label="Zoom out">&minus;</button>
            <button class="icon-btn sm" data-act="in" aria-label="Zoom in">+</button>
          </div>
          <button class="btn sm ghost" data-act="redetect" title="Guess the tempo and sections again">
            Detect again
          </button>
        </div>

        ${clips.length ? `
          <div class="comp-scroll" tabindex="0">
            <div class="comp-track" style="width:${Math.max(200, total * pxPerBeat())}px">
              <div class="comp-bars"></div>
              <div class="comp-clips">${clips.map(clipHtml).join("")}</div>
              <div class="comp-playhead" hidden></div>
            </div>
          </div>
          <div class="comp-foot">
            <span class="faint">${clips.length} part${clips.length === 1 ? "" : "s"}
              &middot; ${Math.round(total / bars)} bars
              &middot; ${J.time(A.duration())}</span>
            <span class="grow"></span>
            <span class="faint comp-hint">drag to move &middot; edges to trim &middot;
              double click to duplicate</span>
          </div>`
        : `<div class="empty comp-empty">
             <h3>Nothing laid out yet</h3>
             <p>J-ong can listen to this render, work out the tempo and split it into
                sections. Everything it decides can be changed afterwards.</p>
             <button class="btn primary" data-act="redetect" style="margin-top:var(--s4)">
               Listen and lay it out
             </button>
           </div>`}`;

      drawBars();
      clips.forEach((clip) => paintClip(clip.id));
      const scroll = J.$(".comp-scroll", root);
      if (scroll) scroll.scrollLeft = scrollLeft;
    }

    let scrollLeft = 0;

    function clipHtml(clip) {
      const part = A.state.parts.find((p) => p.id === clip.part);
      const hue = part ? part.hue : 210;
      return `
        <div class="comp-clip" data-clip="${clip.id}"
             style="--w:${clip.beats * pxPerBeat()}px; --hue:${hue}">
          <span class="comp-grip start" data-edge="start" title="Trim the start"></span>
          <canvas class="comp-wave"></canvas>
          <span class="comp-name">${J.esc(part ? part.name : "clip")}</span>
          <span class="comp-beats">${clip.beats}</span>
          <span class="comp-grip end" data-edge="end" title="Trim the end"></span>
        </div>`;
    }

    /* The bar lines behind the clips. Drawn rather than a repeating gradient so the
     * first line of every fourth bar can be stronger, which is what makes eight bars
     * countable at a glance. */
    function drawBars() {
      const holder = J.$(".comp-bars", root);
      if (!holder) return;
      const per = A.state.perBar;
      const beat = pxPerBeat();
      holder.style.backgroundImage = [
        `repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px ${beat * per}px)`,
        `repeating-linear-gradient(to right, var(--line-2) 0 1px, transparent 1px ${beat * per * 4}px)`,
      ].join(",");
      holder.style.backgroundSize = `${beat * per}px 100%, ${beat * per * 4}px 100%`;
    }

    /* Each clip draws the stretch of the render it actually uses, so trimming one shows
     * you what you kept rather than a picture that never changes. */
    function paintClip(clipId) {
      const clip = A.state.clips.find((c) => c.id === clipId);
      const node = J.$(`[data-clip="${clipId}"] .comp-wave`, root);
      if (!clip || !node) return;
      const whole = A.sourceSeconds();
      if (!whole) return;                 // nothing decoded yet, so nothing to draw
      const beat = A.beatSeconds();
      J.wave.draw(node, A.peaks(), {
        from: (A.state.offset + clip.from * beat) / whole,
        to: (A.state.offset + (clip.from + clip.beats) * beat) / whole,
        color: "rgba(255,255,255,0.42)",
      });
    }

    // ── pointer work ────────────────────────────────────────────────────────
    root.addEventListener("pointerdown", (e) => {
      const clipNode = e.target.closest(".comp-clip");
      if (!clipNode) return;
      const clipId = clipNode.dataset.clip;
      const clip = A.state.clips.find((c) => c.id === clipId);
      if (!clip) return;
      const edge = e.target.closest("[data-edge]");
      const startX = e.clientX;
      const startBeats = clip.beats;
      const order = A.state.clips.map((c) => c.id);

      dragging = { clipId, edge: edge ? edge.dataset.edge : null, startX, startBeats, order,
                   moved: false };
      clipNode.classList.add("holding");
      try { clipNode.setPointerCapture(e.pointerId); } catch (err) { /* not captured */ }

      const onMove = (event) => {
        if (!dragging) return;
        const dx = event.clientX - dragging.startX;
        if (Math.abs(dx) > 3) dragging.moved = true;
        const beats = Math.round(dx / pxPerBeat());

        if (dragging.edge) {
          const wanted = dragging.edge === "start"
            ? dragging.startBeats - beats : dragging.startBeats + beats;
          if (wanted !== clip.beats && wanted >= 1) {
            A.resize(clipId, dragging.edge, wanted);
            redrawSizes();
          }
          return;
        }
        // Moving: work out which slot the pointer is over and reorder live, so the
        // track shows the result rather than a floating ghost of it.
        const track = J.$(".comp-clips", root);
        const rect = track.getBoundingClientRect();
        const at = event.clientX - rect.left + track.parentElement.scrollLeft;
        let walked = 0, target = A.state.clips.length - 1;
        for (let i = 0; i < A.state.clips.length; i++) {
          const width = A.state.clips[i].beats * pxPerBeat();
          if (at < walked + width / 2) { target = i; break; }
          walked += width;
        }
        const current = A.state.clips.findIndex((c) => c.id === clipId);
        if (target !== current) { A.move(clipId, target); draw(); }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const node = J.$(`[data-clip="${clipId}"]`, root);
        if (node) node.classList.remove("holding");
        if (dragging && !dragging.moved) select(clipId);
        dragging = null;
        draw();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    });

    /* Only the widths changed, so only the widths are written. Rebuilding the panel on
     * every pixel of a drag would throw away the canvas mid gesture, which is the exact
     * bug the equaliser had. */
    function redrawSizes() {
      for (const clip of A.state.clips) {
        const node = J.$(`[data-clip="${clip.id}"]`, root);
        if (!node) continue;
        node.style.setProperty("--w", `${clip.beats * pxPerBeat()}px`);
        const count = J.$(".comp-beats", node);
        if (count) count.textContent = clip.beats;
        paintClip(clip.id);
      }
      const foot = J.$(".comp-foot .faint", root);
      if (foot) {
        foot.textContent = `${A.state.clips.length} part${A.state.clips.length === 1 ? "" : "s"}`
          + ` · ${Math.round(A.totalBeats() / A.state.perBar)} bars · ${J.time(A.duration())}`;
      }
    }

    let selected = null;
    function select(clipId) {
      selected = clipId;
      J.$$(".comp-clip", root).forEach((node) => {
        node.classList.toggle("on", node.dataset.clip === clipId);
      });
      const clip = A.state.clips.find((c) => c.id === clipId);
      J.emit("compositor:select", { clip, part: clip && A.state.parts.find((p) => p.id === clip.part) });
    }

    root.addEventListener("dblclick", (e) => {
      const node = e.target.closest(".comp-clip");
      if (!node) return;
      const copy = A.duplicate(node.dataset.clip);
      draw();
      if (copy) {
        J.toast("Duplicated. Trim it to make it shorter.");
        select(copy.id);
      }
    });

    root.addEventListener("keydown", (e) => {
      if (!selected) return;
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        A.remove(selected);
        selected = null;
        draw();
      }
      if (e.key === "d" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        A.duplicate(selected);
        draw();
      }
    });

    root.addEventListener("scroll", (e) => {
      if (e.target.classList.contains("comp-scroll")) scrollLeft = e.target.scrollLeft;
    }, true);

    // ── the header ──────────────────────────────────────────────────────────
    const taps = [];
    root.addEventListener("click", async (e) => {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const what = act.dataset.act;

      if (what === "onoff") {
        e.preventDefault();
        if (!A.state.clips.length) {
          J.toast("Lay the song out first, then it has something to play.", "bad");
          return;
        }
        await A.setEnabled(!A.state.enabled);
        draw();
        J.toast(A.state.enabled
          ? "Playing as arranged. A and B now compare sounds."
          : "Back to the render as it was rendered.");
      }
      if (what === "half") { A.setTempo(A.state.bpm / 2); draw(); }
      if (what === "double") { A.setTempo(A.state.bpm * 2); draw(); }
      if (what === "in") { zoom = J.clamp(zoom * 1.35, 0.3, 6); draw(); }
      if (what === "out") { zoom = J.clamp(zoom / 1.35, 0.3, 6); draw(); }

      if (what === "tap") {
        const now = performance.now();
        if (taps.length && now - taps[taps.length - 1] > 2200) taps.length = 0;
        taps.push(now);
        if (taps.length >= 4) {
          const gaps = [];
          for (let i = 1; i < taps.length; i++) gaps.push(taps[i] - taps[i - 1]);
          const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
          A.setTempo(60000 / mean);
          taps.length = 0;
          draw();
          J.toast(`Tempo set to ${Math.round(A.state.bpm)}.`);
        } else {
          act.textContent = `Tap ${4 - taps.length}`;
        }
      }

      if (what === "redetect") {
        const version = ctx.currentVersion();
        if (!version) { J.toast("There is no render to listen to yet.", "bad"); return; }
        act.disabled = true;
        act.textContent = "Listening…";
        const read = await J.try(() => A.detect(version));
        if (read && read.silent) {
          J.toast("That render is silent. The project bounced to nothing, so there is "
                  + "no beat to find.", "bad");
        } else if (read) {
          J.toast(`${Math.round(read.bpm)} bpm, ${read.parts.length} section`
                  + `${read.parts.length === 1 ? "" : "s"}. `
                  + (read.confidence < 0.45
                     ? "The beat was hard to hear, so check it."
                     : "All of it can be changed."));
        }
        draw();
      }
    });

    root.addEventListener("change", (e) => {
      const bpm = e.target.closest("#compBpm");
      if (!bpm) return;
      A.setTempo(parseFloat(bpm.value));
      draw();
    });

    /* The playhead, while something is playing. */
    function follow() {
      const bar = J.$(".comp-playhead", root);
      if (!bar) return;
      const on = J.player.state.playing && J.arrange.state.enabled
                 && J.arrange.state.songId === (J.player.state.song || {}).id;
      bar.hidden = !on;
      if (!on) return;
      const at = J.arrange.position;
      bar.style.left = `${(at / A.beatSeconds()) * pxPerBeat()}px`;

      // Which clip is sounding. The engine announces the section change for the words;
      // this only marks the block you are looking at.
      const row = J.arrange.at(at);
      J.$$(".comp-clip", root).forEach((node) => {
        node.classList.toggle("live", !!row && node.dataset.clip === row.clip.id);
      });
    }
    const timer = setInterval(follow, 60);

    draw();
    return {
      redraw: draw,
      stop() { clearInterval(timer); },
    };
  }

  return { mount };
})();
