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
 *   settled      the page has to have been still for a moment first. A finger that
 *                lands while the list is gliding belongs to that glide, whatever it
 *                does next, because catching a moving list is the commonest thing a
 *                finger does and it must never change a setting
 *   aimed        on a settled page, a finger that landed on a handle meant that handle
 *   still        held in one place for a moment: an interaction
 *   sideways     moved across rather than up: an interaction, since pages scroll up
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

  /* How long the page has to have been still before a finger is believed.
   *
   * Speed turned out to be the wrong question. A slow, careful drag down the equaliser
   * while the page is still gliding is a scroll; a quick decisive grab of a node on a
   * page that has been sitting still for a second is not. What separates them is not how
   * fast the finger moved, it is whether the page was already moving when it landed.
   *
   * So the app remembers when it last scrolled, and a touch that arrives inside this
   * window is treated as part of that scroll: momentum still running down, a finger put
   * out to stop it, a second flick to keep going. None of those meant to touch a
   * control, and all of them used to.
   */
  const QUIET = 420;

  //: When the page last moved, by any means.
  let lastScroll = 0;
  const noteScroll = () => { lastScroll = performance.now(); };
  //: Capture, because most scrolling here happens inside panels rather than on the page.
  document.addEventListener("scroll", noteScroll, { capture: true, passive: true });
  window.addEventListener("wheel", noteScroll, { passive: true });

  //: How long the page has been still, in milliseconds.
  const stillFor = () => (lastScroll ? performance.now() - lastScroll : Infinity);

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

      // The page started moving under the finger after it landed, so whatever this was
      // meant to be, it is a scroll now.
      if (stillFor() < QUIET) { die(); return; }
      // Anything more up than across is a scroll, because that is the way pages go.
      if (Math.abs(dy) > Math.abs(dx)) { die(); return; }
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

    if (!touch) {
      start();                       // a mouse cannot scroll by dragging
    } else if (stillFor() < QUIET) {
      /* The page was moving a moment ago, so this finger belongs to that. Even a
       * deliberate looking press on a handle is refused here: catching a list that is
       * still gliding is the single most common thing a finger does, and it must never
       * change a setting. */
      die();
    } else if (opts.aimed) {
      start();
    } else {
      timer = setTimeout(start, HOLD);
    }

    return {
      get started() { return started; },
      cancel: die,
    };
  }

  return { begin, stillFor, SLOP, HOLD, QUIET };
})();
