/*
 * character.js
 * -----------------------------------------------------------------------------
 * Draws the mouth. The character itself is plain SVG in index.html; this file
 * only rewrites the mouth paths (and the chin) from a pose:
 *
 *   open   0..1   how far the lips are apart
 *   wide  -1..1   -1 rounded / pushed forward (u, o, sh)   +1 spread (i, e, s)
 *   jaw    0..1   how far the chin has dropped
 *   tuck   0..1   lower lip under the upper teeth (f, v)
 *   teeth  0..1   teeth brought together (s, z, sh)
 *   tongue 0..1   tongue tip raised behind the upper teeth (l, n, t, d)
 *   press  0..1   lips pressed together (m, b, p)
 *
 * Character.setPose(pose) can be called every animation frame.
 */
(function (root) {
  'use strict';

  var HALF_WIDTH = 36;     // half the mouth width at rest, in SVG units
  var MAX_GAP = 32;        // lip-to-lip distance at open = 1
  var TEETH_EDGE = 3.2;    // bottom edge of the upper teeth (they are fixed to the skull)

  var $ = function (id) { return document.getElementById(id); };
  var el = {};
  var blinkTimer = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function mix(a, b, t) { return a + (b - a) * t; }
  function n(v) { return Math.round(v * 100) / 100; }

  function init() {
    ['face', 'mouthHole', 'mouthBack', 'biteArea', 'bite', 'teethBite', 'tongue', 'tongueLine', 'teethLower', 'teethUpper', 'teethLines',
      'lipLower', 'lipUpper', 'lipShine', 'lipSeam', 'lipShadow', 'eyeL', 'eyeR', 'character'].forEach(function (id) { el[id] = $(id); });
    setPose({ open: 0, wide: 0, jaw: 0, tuck: 0, teeth: 0, tongue: 0, press: 0 });
    if (!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches)) scheduleBlink();
  }

  function scheduleBlink() {
    clearTimeout(blinkTimer);
    blinkTimer = setTimeout(function () {
      el.eyeL.classList.add('is-shut'); el.eyeR.classList.add('is-shut');
      setTimeout(function () { el.eyeL.classList.remove('is-shut'); el.eyeR.classList.remove('is-shut'); scheduleBlink(); }, 130);
    }, 2400 + Math.random() * 3600);
  }

  function setPose(p) {
    var open = clamp(p.open || 0, 0, 1), wide = clamp(p.wide || 0, -1, 1), jaw = clamp(p.jaw || 0, 0, 1);
    var tuck = clamp(p.tuck || 0, 0, 1), teeth = clamp(p.teeth || 0, 0, 1), tongue = clamp(p.tongue || 0, 0, 1), press = clamp(p.press || 0, 0, 1);
    var spread = Math.max(wide, 0), round = Math.max(-wide, 0);

    // --- key measurements -------------------------------------------------
    var W = HALF_WIDTH * (1 + 0.15 * spread - 0.42 * round) * (1 - 0.05 * open);
    var gap = MAX_GAP * open * (1 + 0.12 * round);
    var upY = -gap * 0.22, lowY = gap * 0.78;                 // inner edges of the upper / lower lip at the centre
    upY = mix(upY, -3.6, tuck); lowY = mix(lowY, 1.4, tuck);  // f / v: lip rises to the teeth
    var thickU = 6.4 * (1 + 0.32 * round - 0.2 * spread) * (1 - 0.22 * press);
    var thickL = 9.2 * (1 + 0.32 * round - 0.16 * spread) * (1 - 0.42 * tuck) * (1 - 0.18 * press);
    var cornerY = -1.6 + gap * 0.2 - 1.6 * spread + 1.2 * round;   // spread lifts the corners, rounding drops them
    var k = Math.min(0.86, 0.5 + 0.22 * round + 0.2 * open);        // how full / round the opening is
    var upC = (upY - 0.25 * cornerY) / 0.75, lowC = (lowY - 0.25 * cornerY) / 0.75;   // Bezier handles that hit upY / lowY

    // --- the opening --------------------------------------------------------
    var hole = 'M' + n(-W) + ' ' + n(cornerY) +
      'C' + n(-W * k) + ' ' + n(upC) + ' ' + n(W * k) + ' ' + n(upC) + ' ' + n(W) + ' ' + n(cornerY) +
      'C' + n(W * k) + ' ' + n(lowC) + ' ' + n(-W * k) + ' ' + n(lowC) + ' ' + n(-W) + ' ' + n(cornerY) + 'Z';
    el.mouthHole.setAttribute('d', hole);
    el.mouthBack.setAttribute('d', hole);

    // --- lips ---------------------------------------------------------------
    var peakY = upY - thickU - 1.3 + 0.6 * round, dipY = upY - thickU + 0.9 - 0.9 * round, px = W * 0.27;
    el.lipUpper.setAttribute('d',
      'M' + n(-W - 1.5) + ' ' + n(cornerY) +
      'C' + n(-W * 0.74) + ' ' + n(cornerY - thickU * 0.6) + ' ' + n(-W * 0.5) + ' ' + n(peakY) + ' ' + n(-px) + ' ' + n(peakY) +
      'Q' + n(-W * 0.1) + ' ' + n(peakY) + ' 0 ' + n(dipY) +
      'Q' + n(W * 0.1) + ' ' + n(peakY) + ' ' + n(px) + ' ' + n(peakY) +
      'C' + n(W * 0.5) + ' ' + n(peakY) + ' ' + n(W * 0.74) + ' ' + n(cornerY - thickU * 0.6) + ' ' + n(W + 1.5) + ' ' + n(cornerY) +
      'C' + n(W * k) + ' ' + n(upC) + ' ' + n(-W * k) + ' ' + n(upC) + ' ' + n(-W - 1.5) + ' ' + n(cornerY) + 'Z');

    var lowOut = (lowY + thickL - 0.25 * cornerY) / 0.75;
    el.lipLower.setAttribute('d',
      'M' + n(-W - 1.5) + ' ' + n(cornerY) +
      'C' + n(-W * k) + ' ' + n(lowC) + ' ' + n(W * k) + ' ' + n(lowC) + ' ' + n(W + 1.5) + ' ' + n(cornerY) +
      'C' + n(W * 0.66) + ' ' + n(lowOut) + ' ' + n(-W * 0.66) + ' ' + n(lowOut) + ' ' + n(-W - 1.5) + ' ' + n(cornerY) + 'Z');

    el.lipSeam.setAttribute('d', 'M' + n(-W - 1.5) + ' ' + n(cornerY) + 'C' + n(-W * k) + ' ' + n(upC) + ' ' + n(W * k) + ' ' + n(upC) + ' ' + n(W + 1.5) + ' ' + n(cornerY));
    el.lipSeam.setAttribute('opacity', n(clamp(1 - open * 3, 0, 1)));

    var shineY = lowY + thickL * 0.55;
    el.lipShine.setAttribute('d', 'M' + n(-W * 0.3) + ' ' + n(shineY) + 'Q0 ' + n(shineY + 1.6) + ' ' + n(W * 0.3) + ' ' + n(shineY));
    var shadowY = lowY + thickL + 4.5;
    el.lipShadow.setAttribute('d', 'M' + n(-W * 0.42) + ' ' + n(shadowY) + 'Q0 ' + n(shadowY + 3.5) + ' ' + n(W * 0.42) + ' ' + n(shadowY));

    // --- inside the mouth ---------------------------------------------------
    var tw = 26;                                               // half width of the tooth row
    // rounded lips push forward and cover the upper teeth (o, u) unless the teeth are brought together (sh)
    var edge = n(TEETH_EDGE - 9 * round * (1 - 0.75 * Math.max(teeth, tuck)));
    var upperTeeth = 'M' + (-tw) + ' -16H' + tw + 'V' + (edge - 1.5) + 'Q' + tw + ' ' + edge + ' ' + (tw - 2) + ' ' + edge + 'H' + (-tw + 2) + 'Q' + (-tw) + ' ' + edge + ' ' + (-tw) + ' ' + (edge - 1.5) + 'Z';
    el.teethUpper.setAttribute('d', upperTeeth);
    el.teethBite.setAttribute('d', upperTeeth);
    el.teethLines.setAttribute('d', 'M0 -8V' + edge + 'M-9.5 -8V' + edge + 'M9.5 -8V' + edge + 'M-18.5 -8V' + edge + 'M18.5 -8V' + edge);

    var lowTeethTop = Math.max(mix(lowY - 1.2, edge + 0.5, teeth), edge + 0.5);   // lower teeth ride on the jaw
    el.teethLower.setAttribute('d', 'M' + (-tw + 3) + ' ' + n(lowTeethTop + 1.5) + 'Q' + (-tw + 3) + ' ' + n(lowTeethTop) + ' ' + (-tw + 5) + ' ' + n(lowTeethTop) + 'H' + (tw - 5) + 'Q' + (tw - 3) + ' ' + n(lowTeethTop) + ' ' + (tw - 3) + ' ' + n(lowTeethTop + 1.5) + 'V' + n(lowY + 14) + 'H' + (-tw + 3) + 'Z');

    var tongueTop = mix(lowY - gap * 0.42 - 0.5, Math.min(edge - 1, lowY - 4), tongue), tr = W * 0.7, tb = lowY + 12;
    el.tongue.setAttribute('d', 'M' + n(-tr) + ' ' + n(tb) + 'C' + n(-tr) + ' ' + n(tongueTop - 2) + ' ' + n(tr) + ' ' + n(tongueTop - 2) + ' ' + n(tr) + ' ' + n(tb) + 'Z');
    el.tongueLine.setAttribute('d', 'M0 ' + n(tongueTop + 3.5) + 'V' + n(tb));

    // f / v: upper teeth drawn over the lower lip
    el.biteArea.setAttribute('d', 'M' + n(-W) + ' ' + n(cornerY) + 'C' + n(-W * k) + ' ' + n(upC) + ' ' + n(W * k) + ' ' + n(upC) + ' ' + n(W) + ' ' + n(cornerY) + 'V10H' + n(-W) + 'Z');
    el.bite.setAttribute('opacity', n(clamp(tuck * 1.4 - 0.2, 0, 1)));

    // --- chin ---------------------------------------------------------------
    var J = 10 * jaw;
    el.face.setAttribute('d',
      'M192 290C190 196 410 196 408 290' +
      'C410 352 392 ' + n(408 + J * 0.3) + ' 352 ' + n(438 + J * 0.8) +
      'C330 ' + n(455 + J) + ' 270 ' + n(455 + J) + ' 248 ' + n(438 + J * 0.8) +
      'C208 ' + n(408 + J * 0.3) + ' 190 352 192 290Z');
  }

  // Smoothly zoom the camera between the whole character and the mouth.
  var VIEW_FULL = [50, 76, 500, 533], VIEW_CLOSE = [196, 316, 208, 222], view = VIEW_FULL.slice(), viewAnim = 0;
  function setCloseUp(on) {
    var from = view.slice(), to = on ? VIEW_CLOSE : VIEW_FULL, start = performance.now();
    cancelAnimationFrame(viewAnim);
    (function step(now) {
      var t = clamp((now - start) / 450, 0, 1), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2, i;
      for (i = 0; i < 4; i++) view[i] = mix(from[i], to[i], e);
      el.character.setAttribute('viewBox', view.map(n).join(' '));
      if (t < 1) viewAnim = requestAnimationFrame(step);
    })(start);
  }

  root.Character = { init: init, setPose: setPose, setCloseUp: setCloseUp };
})(window);
