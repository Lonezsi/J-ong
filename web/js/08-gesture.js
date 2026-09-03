/* Telling a scroll apart from a gesture that meant something.
 *
 * A finger landing on a control is ambiguous. On a phone the equaliser fills the width
 * of the screen, so most of the time a finger lands on it the person is trying to get
 * past it, and treating that as "place a band here and drag it" is maddening: you try to
 * scroll and the sound changes.
 *
 * A mouse has no such ambiguity, because you cannot scroll a page by dragging it. So
 * pointers that are not fingers act at once, exactly as before, and only touch waits.
 *
 * What the waiting looks at:
 *
 *   aimed        a finger that landed on a handle meant that handle, so it acts at once
 *   still        held in one place for a moment, with nothing scrolling: an interaction
 *   sideways     moved across rather than up: an interaction, since pages scroll up
 *   fast         flicked, at speed: a scroll, whatever the direction
 *   cancelled    the browser started scrolling and took the pointer away: a scroll
 *
 * The last one is the reliable one, and it is why the controls are marked touch-action
 * pan-y in CSS: the browser is allowed to scroll them vertically, and when it decides to
 * it sends pointercancel, which is the browser telling us plainly what the gesture was.
 */
"use strict";

J.gesture = (function () {
  //: Movement below this is still "held in one place", in pixels.
  const SLOP = 9;
  //: Held still for this long with no scroll starting, and it was meant for the control.
  const HOLD = 260;
  //: Pixels per millisecond past which a drag reads as a flick, and flicks are scrolls.
  const FLICK = 0.55;

  /* Start a gesture, deciding first whether it is one.
   *
   * Returns a handle with .cancel(). `onStart` runs when the gesture is judged to be an
   * interaction, and never runs at all if it turns out to be a scroll.
   */
  function begin(event, options) {
    const opts = options || {};
    const target = opts.target || event.currentTarget;
    const touch = event.pointerType === "touch";
    const startX = event.clientX, startY = event.clientY;
    const startedAt = performance.now();

    let started = false;
    let dead = false;
    let timer = null;

    const start = () => {
      if (started || dead) return;
      started = true;
      if (timer) { clearTimeout(timer); timer = null; }
      // Only now does the control take the pointer, so a gesture that turns out to be a
      // scroll is never stolen from the page.
      try { target.setPointerCapture(event.pointerId); } catch (e) { /* fine without */ }
      if (opts.onStart) opts.onStart(event);
    };

    const die = () => {
      if (dead) return;
      dead = true;
      if (timer) { clearTimeout(timer); timer = null; }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (started && opts.onEnd) opts.onEnd(event);
    };

    function onMove(e) {
      if (e.pointerId !== event.pointerId) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (started) { if (opts.onMove) opts.onMove(e, { dx, dy }); return; }

      const travelled = Math.hypot(dx, dy);
      if (travelled < SLOP) return;

      const elapsed = Math.max(1, performance.now() - startedAt);
      const speed = travelled / elapsed;
      // A flick is a scroll whichever way it went, and anything more up than across is
      // a scroll too, because that is the direction pages move in.
      if (speed > FLICK || Math.abs(dy) > Math.abs(dx)) { die(); return; }
      start();
      if (opts.onMove) opts.onMove(e, { dx, dy });
    }

    function onUp(e) {
      if (e.pointerId !== event.pointerId) return;
      // A clean tap that never moved: on touch this is a deliberate press, so let it
      // through even if the hold timer had not fired yet.
      if (!started && touch && performance.now() - startedAt < HOLD && opts.onTap) {
        opts.onTap(e);
        dead = true;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        return;
      }
      die();
    }

    /* The browser took the pointer to scroll with. That is the plainest possible answer
     * to what the gesture was, so nothing else needs deciding. */
    function onCancel(e) {
      if (e.pointerId !== event.pointerId) return;
      die();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);

    if (!touch || opts.aimed) {
      start();
    } else {
      timer = setTimeout(start, HOLD);
    }

    return {
      get started() { return started; },
      cancel: die,
    };
  }

  return { begin, SLOP, HOLD, FLICK };
})();
