/* ============================================================
   REFLEX VIVE — Scroll-Scrubbed Video Hero (v4, Webflow-safe)
   Scrub engine per spec: eased pointer (0.12/rAF) -> fastSeek,
   busy/pending seek queue, text choreography bands, parallax
   framing, prefers-reduced-motion support.
   Changes vs. the standalone demo:
   - Scoped vv- ids/classes (no collisions with Webflow)
   - iOS Safari preload fix (silent play/pause on first gesture)
   - Progress rail fades out after the hero completes
   ============================================================ */
(function () {
  'use strict';

  // Fade the rail out once hero progress hits 100%.
  // Set to false to keep the demo behavior (rail stays full-width).
  var RAIL_FADE_OUT = true;

  // Video size multiplier per beat. Beats A/B/D render at SHRINK scale,
  // Beat C (3rd illustration, internals) smoothly returns to full-bleed
  // using the same 0.60-0.80 band as its text layer.
  var SHRINK_DESKTOP = 1.0;  // full-bleed on desktop (shrink reverted)
  var SHRINK_MOBILE  = 0.72; // tuned for small screens — adjust here

  var hero   = document.getElementById('vv-hero');
  var rail   = document.getElementById('vv-rail');
  var vid    = document.getElementById('vv-video');
  var loader = document.getElementById('vv-loader');
  var edge   = document.getElementById('vv-edgefade');
  if (!hero || !rail || !vid || !loader) return; // fail silently if markup is missing

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var intro  = document.getElementById('vv-intro');
  var beat2  = document.getElementById('vv-beat2');
  var beat3  = document.getElementById('vv-beat3');
  var finalL = document.getElementById('vv-final');

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function smooth(a, b, x) { x = clamp((x - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); }
  function band(p, a, b, c, d) { return smooth(a, b, p) * (1 - smooth(c, d, p)); }

  function setLayer(el, opacity, rise) {
    el.style.opacity = opacity.toFixed(3);
    var ty = (1 - opacity) * rise;
    var blur = (1 - opacity) * 5;
    el.style.transform = 'translateY(' + ty.toFixed(1) + 'px)';
    el.style.filter = blur > 0.2 ? 'blur(' + blur.toFixed(1) + 'px)' : 'none';
    el.style.visibility = opacity < 0.02 ? 'hidden' : 'visible';
  }

  // Text choreography — constants from the dev handoff spec
  function applyText(p) {
    setLayer(intro,  1 - smooth(0.16, 0.24, p), -26);
    setLayer(beat2,  band(p, 0.30, 0.38, 0.50, 0.58), 22);
    setLayer(beat3,  band(p, 0.60, 0.67, 0.74, 0.80), 22);
    setLayer(finalL, smooth(0.84, 0.92, p), 26);
  }

  // Parallax framing on top of the scrub: right bias early, drift + settle scale
  function applyVideo(p) {
    var mobile = window.innerWidth < 700;
    var driftY = reduce ? 0 : (p - 0.5) * -9;
    var scale  = reduce ? 1 : 1.06 - smooth(0, 1, p) * 0.05;
    var biasX  = (mobile || reduce) ? 0 : (1 - smooth(0.0, 0.5, p)) * 6;

    // Shrink multiplier: SHRINK on beats A/B/D, eases to 1.0 during Beat C
    var shrinkBase = mobile ? SHRINK_MOBILE : SHRINK_DESKTOP;
    var m = reduce ? shrinkBase : shrinkBase + (1 - shrinkBase) * band(p, 0.60, 0.67, 0.74, 0.80);
    scale *= m;

    vid.style.transform =
      'translate(calc(-50% + ' + biasX.toFixed(2) + '%), calc(-50% + ' + driftY.toFixed(2) + '%)) scale(' + scale.toFixed(3) + ')';

    // Edge fade: kicks in only when the scaled video no longer covers
    // the viewport (base size: 118% desktop, 132% limiting side mobile)
    if (edge) {
      var coverBase = mobile ? 1.32 : 1.18;
      var cover = coverBase * scale;
      var fade = clamp((1.02 - cover) / 0.12, 0, 1);
      edge.style.opacity = fade.toFixed(3);
    }
  }

  // ---- Scrub engine: scroll progress -> video time ----
  var duration = 0, ready = false;
  var seekBusy = false, pendingT = null;

  function seekTo(t) {
    if (!ready) return;
    t = clamp(t, 0, Math.max(0, duration - 0.05));
    if (seekBusy) { pendingT = t; return; }
    seekBusy = true;
    try {
      // Video is all-intra (every frame a keyframe), so fastSeek is exact
      if (vid.fastSeek) vid.fastSeek(t);
      else vid.currentTime = t;
    } catch (e) { seekBusy = false; }
  }
  vid.addEventListener('seeked', function () {
    seekBusy = false;
    if (pendingT !== null) { var t = pendingT; pendingT = null; seekTo(t); }
  });

  function markReady() {
    if (ready) return;
    duration = vid.duration || 0;
    if (!duration) return;
    ready = true;
    vid.pause(); // scroll owns the playhead — never autoplay
    loader.classList.add('vv-hide');
    onScroll();
  }
  vid.addEventListener('loadedmetadata', function () { if (vid.readyState >= 2) markReady(); });
  vid.addEventListener('canplaythrough', markReady);
  vid.addEventListener('canplay', markReady);
  vid.load();

  // Failsafe: never trap the user behind the loader
  setTimeout(function () {
    if (!ready && vid.duration) { markReady(); }
    loader.classList.add('vv-hide');
  }, 6000);

  // iOS Safari ignores preload="auto" until a user gesture:
  // trigger a silent play/pause on first touch to force buffering
  var nudged = false;
  function iosNudge() {
    if (nudged) return;
    nudged = true;
    var p = vid.play();
    if (p && p.then) {
      p.then(function () { vid.pause(); markReady(); }).catch(function () {});
    }
    window.removeEventListener('touchstart', iosNudge);
    window.removeEventListener('pointerdown', iosNudge);
  }
  window.addEventListener('touchstart', iosNudge, { passive: true, once: true });
  window.addEventListener('pointerdown', iosNudge, { passive: true, once: true });

  // ---- Progress + render loop ----
  var targetP = 0, shownP = 0, ticking = false;

  function progress() {
    var rect = hero.getBoundingClientRect();
    var scrollable = hero.offsetHeight - window.innerHeight;
    return clamp(-rect.top / scrollable, 0, 1);
  }

  function render() {
    shownP += (targetP - shownP) * 0.12;
    if (Math.abs(targetP - shownP) < 0.0004) shownP = targetP;
    if (ready) seekTo(shownP * duration);
    applyText(shownP);
    applyVideo(shownP);
    rail.style.width = (targetP * 100).toFixed(2) + '%';
    if (RAIL_FADE_OUT) {
      rail.classList.toggle('vv-rail-hidden', targetP >= 1);
    }
    if (Math.abs(targetP - shownP) > 0.0004) { requestAnimationFrame(render); }
    else { ticking = false; }
  }

  function onScroll() {
    targetP = progress();
    if (!ticking) { ticking = true; requestAnimationFrame(render); }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  applyText(0);
  applyVideo(0);
  onScroll();
})();
