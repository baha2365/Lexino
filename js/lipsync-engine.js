/*
 * lipsync-engine.js
 * -----------------------------------------------------------------------------
 * Turns a speech recording into a "mouth track": 100 mouth poses per second.
 *
 * It does not recognise words. It measures what the vocal tract is doing:
 *   - formants F1 / F2  -> how open the jaw is, and whether lips are spread or rounded
 *   - short gaps / low "murmur" between vowels -> lips closed (m, b, p) or tongue stop (n, t, d, k, g)
 *   - hiss colour  -> teeth together (s, z), rounded lips (sh, zh), lip under teeth (f)
 * The whole file is analysed before playback, so every movement can start a little
 * before its sound, the way real lips do.
 *
 * Usage:
 *   const track = await LipSyncEngine.analyze(float32MonoSamples, sampleRate, { onProgress });
 *   const pose  = LipSyncEngine.poseAt(track, timeInSeconds);   // {open, wide, jaw, tuck, teeth, tongue}
 *
 * Works in the browser (global LipSyncEngine) and in Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LipSyncEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SR = 16000;          // analysis sample rate
  var HOP = 160;           // 10 ms
  var FPS = SR / HOP;      // 100 poses per second
  var LPC_SR = 11000;      // formant analysis rate (keeps 5 formants below Nyquist)
  var LPC_ORDER = 12;

  // Frame classes (also used to colour the timeline)
  var C = { SIL: 0, VOW: 1, LIPS: 2, TONGUE: 3, S: 4, SH: 5, F: 6, H: 7 };
  var CLASS_NAMES = ['pause', 'vowel', 'lips closed', 'tongue stop', 's / z', 'sh / zh', 'f / v', 'breath'];

  /* ------------------------------------------------------------------ utils */

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function dB(p) { return 10 * Math.log10(p + 1e-12); }

  function percentile(arr, p) {
    var a = Array.prototype.slice.call(arr).sort(function (x, y) { return x - y; });
    if (!a.length) return 0;
    return a[clamp(Math.round(p * (a.length - 1)), 0, a.length - 1)];
  }
  function median(list) { return list.length ? percentile(list, 0.5) : NaN; }

  function makeFFT(n) {
    var half = n >> 1, cos = new Float64Array(half), sin = new Float64Array(half), rev = new Uint32Array(n);
    var bits = Math.round(Math.log(n) / Math.LN2), i, j, b;
    for (i = 0; i < half; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    for (i = 0; i < n; i++) { j = 0; for (b = 0; b < bits; b++) if (i & (1 << b)) j |= 1 << (bits - 1 - b); rev[i] = j; }
    return function (re, im) {
      var i, j, k, size, h, step, tr, ti;
      for (i = 0; i < n; i++) { j = rev[i]; if (j > i) { tr = re[i]; re[i] = re[j]; re[j] = tr; ti = im[i]; im[i] = im[j]; im[j] = ti; } }
      for (size = 2; size <= n; size <<= 1) {
        h = size >> 1; step = n / size;
        for (i = 0; i < n; i += size) {
          for (j = i, k = 0; j < i + h; j++, k += step) {
            tr = re[j + h] * cos[k] + im[j + h] * sin[k];
            ti = -re[j + h] * sin[k] + im[j + h] * cos[k];
            re[j + h] = re[j] - tr; im[j + h] = im[j] - ti; re[j] += tr; im[j] += ti;
          }
        }
      }
    };
  }

  // Band-limited (windowed-sinc) resampler.
  function resample(x, srIn, srOut) {
    if (srIn === srOut) return x;
    var ratio = srIn / srOut;
    var norm = 2 * 0.46 * Math.min(srIn, srOut) / srIn;       // cutoff, relative to input rate
    var K = Math.ceil(9 / norm);                              // kernel half-width, input samples
    var SUB = 64, tableLen = 2 * K * SUB + 1, table = new Float32Array(tableLen), i, n;
    for (i = 0; i < tableLen; i++) {
      var t = i / SUB - K, a = Math.PI * norm * t;
      table[i] = (Math.abs(t) < 1e-9 ? 1 : Math.sin(a) / a) * (0.5 + 0.5 * Math.cos(Math.PI * t / K)) * norm;
    }
    var nOut = Math.floor(x.length / ratio), y = new Float32Array(nOut), len = x.length;
    for (i = 0; i < nOut; i++) {
      var p = i * ratio, n0 = Math.ceil(p - K), n1 = Math.floor(p + K), acc = 0;
      if (n0 < 0) n0 = 0; if (n1 > len - 1) n1 = len - 1;
      for (n = n0; n <= n1; n++) acc += x[n] * table[Math.round((p - n + K) * SUB)];
      y[i] = acc;
    }
    return y;
  }

  // Zero-phase Gaussian smoothing (sigma in frames).
  function gauss(src, sigma) {
    var n = src.length, out = new Float32Array(n), r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1), i, j, sum = 0;
    for (i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * i * i / (sigma * sigma)); sum += k[i + r]; }
    for (i = 0; i <= 2 * r; i++) k[i] /= sum;
    for (i = 0; i < n; i++) {
      var acc = 0;
      for (j = -r; j <= r; j++) { var q = i + j; if (q < 0) q = 0; else if (q >= n) q = n - 1; acc += src[q] * k[j + r]; }
      out[i] = acc;
    }
    return out;
  }

  function tick() { return new Promise(function (res) { setTimeout(res, 0); }); }

  /* ------------------------------------------------------------ LPC formants */

  // Roots of the monic polynomial z^n + a[1] z^(n-1) + ... + a[n]  (Durand-Kerner).
  function polyRoots(a, n, zr, zi) {
    var i, j, k, iter;
    for (i = 0; i < n; i++) { var ang = 2 * Math.PI * i / n + 0.3; zr[i] = 0.9 * Math.cos(ang); zi[i] = 0.9 * Math.sin(ang); }
    for (iter = 0; iter < 80; iter++) {
      var maxD = 0;
      for (i = 0; i < n; i++) {
        var pr = 1, pi = 0, tr;
        for (k = 1; k <= n; k++) { tr = pr * zr[i] - pi * zi[i] + a[k]; pi = pr * zi[i] + pi * zr[i]; pr = tr; }
        var dr = 1, di = 0;
        for (j = 0; j < n; j++) {
          if (j === i) continue;
          var xr = zr[i] - zr[j], xi = zi[i] - zi[j];
          tr = dr * xr - di * xi; di = dr * xi + di * xr; dr = tr;
        }
        var den = dr * dr + di * di;
        if (den < 1e-30) { zr[i] += 1e-4; continue; }
        var qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
        zr[i] -= qr; zi[i] -= qi;
        var d = Math.abs(qr) + Math.abs(qi); if (d > maxD) maxD = d;
      }
      if (maxD < 1e-7) break;
    }
  }

  function makeFormantTracker() {
    var W = Math.round(0.025 * LPC_SR), win = new Float64Array(W), buf = new Float64Array(W);
    var r = new Float64Array(LPC_ORDER + 1), a = new Float64Array(LPC_ORDER + 1), tmp = new Float64Array(LPC_ORDER + 1);
    var zr = new Float64Array(LPC_ORDER), zi = new Float64Array(LPC_ORDER), i;
    for (i = 0; i < W; i++) win[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (W - 1));

    // Returns ascending formant candidates (Hz) for the frame centred at `centre` (in LPC_SR samples).
    return function (x, centre, out) {
      var start = centre - (W >> 1), n = x.length, k, j, count = 0;
      for (i = 0; i < W; i++) {
        var q = start + i, s = q > 0 && q < n ? x[q] - 0.97 * x[q - 1] : 0;
        buf[i] = s * win[i];
      }
      for (k = 0; k <= LPC_ORDER; k++) { var acc = 0; for (i = k; i < W; i++) acc += buf[i] * buf[i - k]; r[k] = acc; }
      if (r[0] < 1e-12) return 0;
      r[0] *= 1.0001;                                           // tiny white-noise floor keeps it stable
      var err = r[0]; a[0] = 1; for (k = 1; k <= LPC_ORDER; k++) a[k] = 0;
      for (k = 1; k <= LPC_ORDER; k++) {                        // Levinson-Durbin
        var lam = r[k]; for (j = 1; j < k; j++) lam += a[j] * r[k - j];
        lam = -lam / err;
        for (j = 1; j < k; j++) tmp[j] = a[j] + lam * a[k - j];
        for (j = 1; j < k; j++) a[j] = tmp[j];
        a[k] = lam; err *= 1 - lam * lam;
        if (err <= 0) return 0;
      }
      polyRoots(a, LPC_ORDER, zr, zi);
      for (i = 0; i < LPC_ORDER; i++) {
        if (zi[i] <= 0) continue;
        var mag = Math.sqrt(zr[i] * zr[i] + zi[i] * zi[i]);
        var f = Math.atan2(zi[i], zr[i]) * LPC_SR / (2 * Math.PI), bw = -Math.log(mag) * LPC_SR / Math.PI;
        if (f > 180 && f < 5200 && bw < 650) out[count++] = f;
      }
      for (i = 1; i < count; i++) { var v = out[i]; j = i - 1; while (j >= 0 && out[j] > v) { out[j + 1] = out[j]; j--; } out[j + 1] = v; }
      return count;
    };
  }

  /* ----------------------------------------------------------------- analyse */

  async function analyze(samples, sampleRate, opts) {
    opts = opts || {};
    var progress = opts.onProgress || function () {};
    var i, k, f;

    // 1. mono 16 kHz, DC removed
    var x = resample(samples, sampleRate, SR);
    var prevIn = 0, prevOut = 0;
    for (i = 0; i < x.length; i++) { var cur = x[i]; prevOut = cur - prevIn + 0.985 * prevOut; prevIn = cur; x[i] = prevOut; }
    progress(0.08); await tick();
    var xl = resample(x, SR, LPC_SR);
    progress(0.14); await tick();

    var n = Math.max(1, Math.floor(x.length / HOP));
    var level = new Float32Array(n), bl = new Float32Array(n), bm = new Float32Array(n), bh = new Float32Array(n), bx = new Float32Array(n);
    var cen = new Float32Array(n), vs = new Float32Array(n), f0 = new Float32Array(n);
    var murmurish = new Uint8Array(n);
    var F1 = new Float32Array(n), F2 = new Float32Array(n), F3 = new Float32Array(n), fOk = new Uint8Array(n);

    var NF = 512, WIN = 400, fftA = makeFFT(NF), re = new Float64Array(NF), im = new Float64Array(NF), hann = new Float64Array(WIN);
    for (i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));
    var NP = 1024, WP = 640, fftP = makeFFT(NP), pr = new Float64Array(NP), pi = new Float64Array(NP), hannP = new Float64Array(WP), rw = new Float64Array(NP);
    for (i = 0; i < WP; i++) hannP[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WP - 1));
    for (i = 0; i < NP; i++) { pr[i] = i < WP ? hannP[i] : 0; pi[i] = 0; }
    fftP(pr, pi); for (i = 0; i < NP; i++) { pr[i] = pr[i] * pr[i] + pi[i] * pi[i]; pi[i] = 0; }
    fftP(pr, pi); for (i = 0; i < NP; i++) rw[i] = pr[i] / pr[0];

    var binHz = SR / NF, bLo0 = Math.round(80 / binHz), bLo1 = Math.round(500 / binHz), bMi1 = Math.round(2000 / binHz),
        bMh1 = Math.round(4000 / binHz), bHi1 = Math.round(7600 / binHz), bCen0 = Math.round(1000 / binHz);
    var lagMin = Math.floor(SR / 500), lagMax = Math.ceil(SR / 65);
    var formants = makeFormantTracker(), cand = new Float64Array(LPC_ORDER);

    // 2. per-frame measurements
    for (f = 0; f < n; f++) {
      var c0 = f * HOP, s0 = c0 - (WIN >> 1), e = 0;
      for (i = 0; i < NF; i++) { re[i] = 0; im[i] = 0; }
      for (i = 0; i < WIN; i++) { var q = s0 + i, v = q >= 0 && q < x.length ? x[q] : 0; e += v * v; re[i] = v * hann[i]; }
      level[f] = dB(e / WIN);
      fftA(re, im);
      var eL = 0, eM = 0, eH = 0, eX = 0, cn = 0, cd = 0;
      for (k = bLo0; k <= bHi1; k++) {
        var p = re[k] * re[k] + im[k] * im[k];
        if (k < bLo1) eL += p; else if (k < bMi1) eM += p; else if (k < bMh1) eH += p; else eX += p;
        if (k >= bCen0) { cn += p * k; cd += p; }
      }
      bl[f] = dB(eL); bm[f] = dB(eM); bh[f] = dB(eH); bx[f] = dB(eX);
      cen[f] = cd > 0 ? cn / cd * binHz : 0;

      // voicing: normalised autocorrelation peak (window-corrected)
      var sp = c0 - (WP >> 1);
      for (i = 0; i < NP; i++) { var q2 = sp + i; pr[i] = i < WP && q2 >= 0 && q2 < x.length ? x[q2] * hannP[i] : 0; pi[i] = 0; }
      fftP(pr, pi); for (i = 0; i < NP; i++) { pr[i] = pr[i] * pr[i] + pi[i] * pi[i]; pi[i] = 0; }
      fftP(pr, pi);
      var best = 0, bestLag = 0;
      if (pr[0] > 1e-9) {
        for (k = lagMin; k <= lagMax; k++) { var rr = pr[k] / pr[0] / rw[k] - 0.0002 * k; if (rr > best) { best = rr; bestLag = k; } }
      }
      vs[f] = clamp(best, 0, 1); f0[f] = bestLag ? SR / bestLag : 0;

      // formants
      var cnt = formants(xl, Math.round(c0 * LPC_SR / SR), cand), i1 = -1;
      for (i = 0; i < cnt; i++) if (cand[i] >= 200 && cand[i] <= 1250) { i1 = i; break; }
      if (i1 >= 0) {
        F1[f] = cand[i1];
        for (i = i1 + 1; i < cnt; i++) if (cand[i] >= cand[i1] + 150 && cand[i] <= 3400) { F2[f] = cand[i]; fOk[f] = 1; if (i + 1 < cnt) F3[f] = cand[i + 1]; break; }
      }
      if ((f & 127) === 127) { progress(0.14 + 0.76 * f / n); await tick(); }
    }

    // 3. levels relative to this recording's speech level
    var top = -200, loudFrames = [];
    for (f = 0; f < n; f++) if (level[f] > top) top = level[f];
    for (f = 0; f < n; f++) if (level[f] > top - 40) loudFrames.push(level[f]);     // ignore long silences when judging speech level
    var ref = percentile(loudFrames, 0.9), floor = Math.min(percentile(level, 0.05), ref - 30);
    var silThr = Math.max(floor + 8, ref - 38) - ref;
    var loudBands = [];
    for (f = 0; f < n; f++) if (level[f] > top - 40) loudBands.push(bl[f]);
    var bandRef = percentile(loudBands, 0.9);
    var em = new Float32Array(n);                 // 500-4000 Hz: where vowels are strong and murmurs are weak
    for (f = 0; f < n; f++) {
      level[f] -= ref; bl[f] -= bandRef; bm[f] -= bandRef; bh[f] -= bandRef; bx[f] -= bandRef;
      em[f] = dB(Math.pow(10, bm[f] / 10) + Math.pow(10, bh[f] / 10));
    }

    // speaker size: a shorter vocal tract (women, children) shifts every formant up.
    // Estimated from the typical third formant, with pitch as a second opinion.
    var pitches = [], thirds = [];
    for (f = 0; f < n; f++) if (vs[f] > 0.7 && level[f] > -15) {
      if (f0[f] > 70 && f0[f] < 420) pitches.push(f0[f]);
      if (F3[f] > 0) thirds.push(F3[f]);
    }
    var f0med = pitches.length > 5 ? median(pitches) : 160;
    var scale = Math.pow(f0med / 115, 0.28);
    if (thirds.length >= 30) scale = Math.exp(0.65 * Math.log(median(thirds) / 2450) + 0.35 * Math.log(scale));
    scale = clamp(scale, 0.92, 1.38);

    // 4. frame classes
    var VOICED = 0.45, MURMUR = 20, GAP = 21;
    var raw = new Uint8Array(n);   // provisional: SIL, VOW, MURMUR, S, SH, F, H
    for (f = 0; f < n; f++) {
      var L = level[f];
      if (L < silThr) { raw[f] = C.SIL; continue; }
      if (vs[f] >= VOICED) {
        if (bx[f] > -30 && bx[f] - bl[f] > -10 && bx[f] > bm[f] - 4) raw[f] = C.S;                                  // z
        else if (vs[f] < 0.78 && bh[f] > -24 && bh[f] - bl[f] > -8 && bh[f] > bm[f] + 3 && cen[f] > 2700) raw[f] = C.SH; // zh
        else raw[f] = C.VOW;
      } else {
        if ((cen[f] > 4500 || bx[f] > bh[f] + 6) && L > -30) raw[f] = C.S;
        else if (cen[f] > 2700 && bh[f] > bx[f] - 6 && L > -26) raw[f] = C.SH;
        else if (cen[f] > 3000 && L < -16 && Math.abs(bh[f] - bx[f]) < 9 && bm[f] < bh[f] + 8) raw[f] = C.F;
        else raw[f] = C.H;
      }
    }
    for (f = 1; f < n - 1; f++) if (raw[f - 1] === raw[f + 1] && raw[f] !== raw[f - 1]) raw[f] = raw[f - 1];   // single-frame flickers

    function runs(arr) {
      var out = [], s = 0, j;
      for (j = 1; j <= arr.length; j++) if (j === arr.length || arr[j] !== arr[s]) { out.push({ s: s, e: j, c: arr[s] }); s = j; }
      return out;
    }

    // one label per stretch of hiss: energy-weighted vote
    var isNoise = function (c) { return c === C.S || c === C.SH || c === C.F || c === C.H; };
    f = 0;
    while (f < n) {
      if (!isNoise(raw[f])) { f++; continue; }
      var st = f, votes = [0, 0, 0, 0, 0, 0, 0, 0];
      while (f < n && isNoise(raw[f])) { votes[raw[f]] += Math.pow(10, level[f] / 20); f++; }
      var win = C.H, wv = -1; for (k = 4; k <= 7; k++) if (votes[k] > wv) { wv = votes[k]; win = k; }
      for (i = st; i < f; i++) raw[i] = win;
    }

    // murmurs: voiced stretches where the vowel band collapses next to a louder vowel
    // (m, n, ng, l, and the voice bar of b, d, g), or that are low-frequency only
    var ems = gauss(em, 0.8), R = 18;
    for (f = 0; f < n; f++) {
      if (raw[f] !== C.VOW) continue;
      var pkL = -200, pkR = -200;
      for (k = Math.max(0, f - R); k < f; k++) if (raw[k] === C.VOW && ems[k] > pkL) pkL = ems[k];
      for (k = f + 1; k <= Math.min(n - 1, f + R); k++) if (raw[k] === C.VOW && ems[k] > pkR) pkR = ems[k];
      var dL = pkL - ems[f], dR = pkR - ems[f];
      var both = dL >= 8 && dR >= 8, edge = (dL < 3 && dR >= 11) || (dR < 3 && dL >= 11);
      var lowOnly = bl[f] - bm[f] > 16 && bl[f] - bh[f] > 22;
      if (both || edge || lowOnly) murmurish[f] = 1;
    }
    for (f = 0; f < n; f++) if (murmurish[f]) raw[f] = MURMUR;
    for (f = 1; f < n - 1; f++) if (raw[f - 1] === raw[f + 1] && raw[f] !== raw[f - 1] && raw[f - 1] !== C.SIL) raw[f] = raw[f - 1];

    // smooth formants over vowel frames (5-frame median) and normalise for speaker size
    var F1s = new Float32Array(n), F2s = new Float32Array(n);
    for (f = 0; f < n; f++) {
      var a1 = [], a2 = [];
      for (k = -2; k <= 2; k++) { var g = f + k; if (g >= 0 && g < n && fOk[g] && raw[g] === C.VOW) { a1.push(F1[g]); a2.push(F2[g]); } }
      if (a1.length >= 2) { F1s[f] = median(a1) / scale; F2s[f] = median(a2) / scale; } else { F1s[f] = 0; F2s[f] = 0; }
    }

    // 5. segments
    var cls = new Uint8Array(n), seg = runs(raw), si, sg;
    for (si = 0; si < seg.length; si++) {
      sg = seg[si];
      var len0 = sg.e - sg.s;
      if (sg.c === C.SIL) { if (si > 0 && si < seg.length - 1 && len0 <= 18) sg.c = GAP; }     // short silence inside speech = stop closure
      else if (sg.c === MURMUR) {
        // a real murmur is a plateau with a sharp edge; a ramp or a slow glide is just a vowel changing
        var lo = 200, hi = -200, a = sg.s + (len0 > 3 ? 1 : 0), b = sg.e - (len0 > 3 ? 1 : 0);
        for (i = a; i < b; i++) { if (ems[i] < lo) lo = ems[i]; if (ems[i] > hi) hi = ems[i]; }
        var stepIn = sg.s >= 2 ? ems[sg.s - 2] - ems[Math.min(sg.e - 1, sg.s + 1)] : 99;
        var stepOut = sg.e + 1 < n ? ems[sg.e + 1] - ems[Math.max(sg.s, sg.e - 2)] : 99;
        var prevSil = si === 0 || seg[si - 1].c === C.SIL || seg[si - 1].c === GAP, nextSil = si === seg.length - 1 || seg[si + 1].c === C.SIL;
        var sharp = (!prevSil && stepIn >= 7) || (!nextSil && stepOut >= 7);
        if (len0 < 3 || hi - lo > 9 || !sharp) sg.c = C.VOW;
        sg.sharp = Math.max(prevSil ? 0 : stepIn, nextSil ? 0 : stepOut);
      }
    }
    for (si = 0; si < seg.length; si++) for (i = seg[si].s; i < seg[si].e; i++) raw[i] = seg[si].c;

    // a voiced closure that runs into a silent one is a single closure
    var CLOSED = 30, shut = new Uint8Array(n);
    for (f = 0; f < n; f++) shut[f] = raw[f] === MURMUR || raw[f] === GAP ? CLOSED : raw[f];
    seg = runs(shut);

    // --- lips or tongue? ------------------------------------------------------
    // F2 next to the consonant vs. F2 in the middle of the vowel ("locus"): lips pull F2 down,
    // the tongue tip pulls it toward ~1700 Hz. Front vowels (i, e) give no information.
    function vowelSide(idx, dir) {
      var edge = [], mid = [], j = idx, seen = 0, skipped = 0;
      while (j >= 0 && j < n && seen < 9) {
        if (raw[j] === C.VOW && F2s[j] > 0) { if (seen < 2) edge.push(F2s[j]); else if (seen >= 4) mid.push(F2s[j]); seen++; }
        else if (seen > 0 || ++skipped > 5) break;
        j += dir;
      }
      return { edge: median(edge), mid: median(mid) };
    }
    function locusScore(v) {
      if (isNaN(v.edge) || isNaN(v.mid)) return 0;
      var d = v.edge - v.mid, dLip = 200 - 0.2 * v.mid, dTip = 1100 - 0.6 * v.mid, gap = Math.abs(dTip - dLip);
      if (gap < 120) return 0;
      return clamp((Math.abs(d - dTip) - Math.abs(d - dLip)) / gap, -1, 1) * clamp((1850 - v.mid) / 350, 0, 1);
    }

    for (si = 0; si < seg.length; si++) {
      sg = seg[si];
      if (sg.c !== CLOSED) { for (i = sg.s; i < sg.e; i++) cls[i] = sg.c; continue; }
      var hasGap = false, inside = 0, pk = -200;
      for (i = sg.s; i < sg.e; i++) { if (raw[i] === GAP) hasGap = true; inside += Math.max(ems[i], -60); }
      inside /= sg.e - sg.s;
      for (i = Math.max(0, sg.s - 15); i < Math.min(n, sg.e + 15); i++) if (raw[i] === C.VOW && ems[i] > pk) pk = ems[i];
      var stIn = sg.s >= 2 ? ems[sg.s - 2] - ems[Math.min(sg.e - 1, sg.s + 1)] : 0;
      var stOut = sg.e + 1 < n ? ems[sg.e + 1] - ems[Math.max(sg.s, sg.e - 2)] : 0;
      sg.depth = pk - inside; sg.sharp = Math.max(stIn, stOut);
      var after = vowelSide(sg.e, 1), before = vowelSide(sg.s - 1, -1);
      var sLoc = locusScore(after) + 0.8 * locusScore(before);
      // release burst: a tongue stop spits energy above 4 kHz, lips barely do (only ever counts against lips)
      var sBurst = 0, hb = -99;
      for (i = sg.e; i < Math.min(n, sg.e + 8); i++) { if (!isNoise(raw[i]) && i > sg.e + 1) break; if (raw[i] === C.SIL) break; if (bx[i] > hb) hb = bx[i]; if (isNoise(raw[i]) && bh[i] - 4 > hb) hb = bh[i] - 4; }
      sBurst = clamp((-20 - hb) / 6, -1.5, 0);
      sg.score = sLoc + sBurst * 0.9; sg.parts = [sLoc, sBurst, hb];
      // lips only for a real closure (deep, sharp-edged) - a shallow dip is a glide like w, l, r
      var real = hasGap || (sg.depth >= 14 && sg.sharp >= 9);
      var lips = real && sg.score > 0.85;
      sg.lips = lips;
      for (i = sg.s; i < sg.e; i++) cls[i] = lips ? C.LIPS : C.TONGUE;
    }
    var segInfo = seg;

    // short hiss right after a closure is the release burst, not a fricative
    seg = runs(cls);
    for (si = 1; si < seg.length; si++) {
      sg = seg[si];
      var prev = seg[si - 1].c, len = sg.e - sg.s, afterStop = prev === C.LIPS || prev === C.TONGUE;
      if (afterStop && ((sg.c === C.S && len <= 3) || (sg.c === C.SH && len < 5) || (sg.c === C.F && len <= 4)))
        for (i = sg.s; i < sg.e; i++) cls[i] = C.H;
      if (!afterStop && sg.c === C.F && len < 4) for (i = sg.s; i < sg.e; i++) cls[i] = C.H;
    }
    progress(0.93); await tick();

    // 6. vowel targets from formants
    var lv = gauss(level, 1.5);
    var vOpen = new Float32Array(n), vWide = new Float32Array(n), isV = new Uint8Array(n);
    for (f = 0; f < n; f++) {
      if (cls[f] !== C.VOW) continue;
      isV[f] = 1;
      var loud = clamp((lv[f] + 32) / 24, 0, 1), trust = clamp((lv[f] + 28) / 12, 0, 1), f1m = 0.4, wd = 0;
      if (F1s[f] > 0) {
        var roundable = clamp((720 - F1s[f]) / 220, 0, 1);         // rounding only on closer vowels (o, u)
        f1m = clamp((F1s[f] - 300) / 380, 0, 1);
        wd = clamp((F2s[f] - 1400) / 650, -1, 1);
        if (wd < 0) wd *= roundable; else wd *= 1 - 0.35 * f1m;
        if (F2s[f] > 1800 && bh[f] - bl[f] < -42) wd = -0.6 * roundable;                           // "F2" was really F3
        f1m = f1m * trust + 0.35 * (1 - trust); wd *= trust;       // very quiet frames: formants are guesses
      }
      vOpen[f] = (0.14 + 0.86 * Math.pow(f1m, 0.9)) * (0.3 + 0.7 * loud);
      vWide[f] = wd;
    }

    // carrier: what the surrounding vowels want, carried through consonants (coarticulation)
    var cOpen = new Float32Array(n), cWide = new Float32Array(n), prevV = -1, nextV = -1;
    for (f = 0; f < n; f++) {
      if (isV[f]) { cOpen[f] = vOpen[f]; cWide[f] = vWide[f]; prevV = f; continue; }
      if (nextV <= f) { nextV = -1; for (k = f + 1; k < Math.min(n, f + 60); k++) if (isV[k]) { nextV = k; break; } }
      var dp = prevV >= 0 ? f - prevV : 999, dn = nextV >= 0 ? nextV - f : 999;
      if (dp > 40 && dn > 40) { cOpen[f] = 0; cWide[f] = 0; }
      else if (dp > 40) { cOpen[f] = vOpen[nextV]; cWide[f] = vWide[nextV]; }
      else if (dn > 40) { var fade = clamp(1 - (dp - 15) / 25, 0, 1); cOpen[f] = vOpen[prevV] * fade; cWide[f] = vWide[prevV] * fade; }
      else { var w = dp / (dp + dn); cOpen[f] = vOpen[prevV] * (1 - w) + vOpen[nextV] * w; cWide[f] = vWide[prevV] * (1 - w) + vWide[nextV] * w; }
    }

    // 7. per-frame targets
    var tOpen = new Float32Array(n), tWide = new Float32Array(n), tTuck = new Float32Array(n), tTeeth = new Float32Array(n),
        tTongue = new Float32Array(n), seal = new Float32Array(n);
    for (f = 0; f < n; f++) {
      switch (cls[f]) {
        case C.VOW: tOpen[f] = vOpen[f]; tWide[f] = vWide[f]; break;
        case C.LIPS: tOpen[f] = 0; tWide[f] = cWide[f] * 0.5; seal[f] = 1; break;
        case C.TONGUE: tOpen[f] = clamp(cOpen[f] * 0.4, 0.1, 0.25); tWide[f] = cWide[f]; tTongue[f] = 0.7; break;
        case C.S: tOpen[f] = 0.2; tWide[f] = clamp(0.25 + 0.5 * cWide[f], -0.3, 0.7); tTeeth[f] = 1; break;
        case C.SH: tOpen[f] = 0.3; tWide[f] = -0.6; tTeeth[f] = 1; break;
        case C.F: tOpen[f] = 0.16; tWide[f] = cWide[f] * 0.5; tTuck[f] = 1; break;
        case C.H: tOpen[f] = Math.max(0.15, cOpen[f] * 0.7); tWide[f] = cWide[f]; break;
        default: tOpen[f] = 0; tWide[f] = 0;
      }
    }
    // a lip closure must be visible: hold it for at least 50 ms
    seg = runs(cls);
    for (si = 0; si < seg.length; si++) {
      sg = seg[si];
      if (sg.c !== C.LIPS) continue;
      var need = 5 - (sg.e - sg.s), a0 = sg.s - Math.ceil(need / 2), b0 = sg.e + Math.floor(need / 2);
      if (need > 0) for (i = Math.max(0, a0); i < Math.min(n, b0); i++) seal[i] = 1;
    }

    // 8. smooth like muscles do (zero-phase), then force closures shut
    var open = gauss(tOpen, 2.4), wide = gauss(tWide, 3.4), tuck = gauss(tTuck, 2.0), teeth = gauss(tTeeth, 2.0), tongue = gauss(tTongue, 2.2);
    var sealS = gauss(seal, 1.3);
    for (f = 0; f < n; f++) {
      var sl = clamp(sealS[f] * 1.25, 0, 1);
      open[f] = clamp(open[f] * (1 - sl), 0, 1);
      tuck[f] = clamp(tuck[f] * 1.15, 0, 1); teeth[f] = clamp(teeth[f] * 1.15, 0, 1); tongue[f] = clamp(tongue[f] * 1.1, 0, 1);
      sealS[f] = sl;
    }
    var jaw = gauss(tOpen, 4.2);
    for (f = 0; f < n; f++) jaw[f] = Math.max(jaw[f] * 0.9, open[f] * 0.8);
    progress(1);

    return {
      fps: FPS, frames: n, duration: x.length / SR,
      open: open, wide: wide, jaw: jaw, tuck: tuck, teeth: teeth, tongue: tongue, press: sealS,
      cls: cls, level: level,
      info: { pitch: f0med, scale: scale, speechLevelDb: ref, silenceThresholdDb: silThr },
      debug: opts.debug ? { F1: F1s, F2: F2s, vs: vs, bl: bl, bm: bm, bh: bh, bx: bx, cen: cen, raw: raw, em: em, seg: segInfo, f0: f0, F3: F3 } : null
    };
  }

  /* -------------------------------------------------------------------- pose */

  var REST = { open: 0, wide: 0, jaw: 0, tuck: 0, teeth: 0, tongue: 0, press: 0 };
  var KEYS = ['open', 'wide', 'jaw', 'tuck', 'teeth', 'tongue', 'press'];

  // Pose at time t (seconds), linearly interpolated between analysis frames.
  function poseAt(track, t, out) {
    out = out || {};
    var p = t * track.fps, i = Math.floor(p), fr = p - i, j, key, arr;
    if (!(p >= 0) || i >= track.frames - 1) { for (j = 0; j < KEYS.length; j++) out[KEYS[j]] = 0; return out; }
    for (j = 0; j < KEYS.length; j++) { key = KEYS[j]; arr = track[key]; out[key] = arr[i] + (arr[i + 1] - arr[i]) * fr; }
    return out;
  }

  // Hand-made poses for single sounds (used by the "mouth shapes" row, and handy
  // later if you drive the mouth from phoneme timings instead of audio).
  var SHAPES = {
    rest: { open: 0, wide: 0, jaw: 0, tuck: 0, teeth: 0, tongue: 0, press: 0 },
    A:    { open: 0.95, wide: -0.05, jaw: 0.9, tuck: 0, teeth: 0, tongue: 0, press: 0 },
    E:    { open: 0.5, wide: 0.6, jaw: 0.45, tuck: 0, teeth: 0, tongue: 0, press: 0 },
    I:    { open: 0.22, wide: 1, jaw: 0.18, tuck: 0, teeth: 0.4, tongue: 0, press: 0 },
    O:    { open: 0.55, wide: -0.75, jaw: 0.55, tuck: 0, teeth: 0, tongue: 0, press: 0 },
    U:    { open: 0.2, wide: -1, jaw: 0.25, tuck: 0, teeth: 0, tongue: 0, press: 0 },
    M:    { open: 0, wide: 0, jaw: 0.08, tuck: 0, teeth: 0, tongue: 0, press: 1 },
    F:    { open: 0.16, wide: 0.1, jaw: 0.1, tuck: 1, teeth: 0, tongue: 0, press: 0 },
    S:    { open: 0.2, wide: 0.5, jaw: 0.08, tuck: 0, teeth: 1, tongue: 0, press: 0 },
    SH:   { open: 0.3, wide: -0.6, jaw: 0.12, tuck: 0, teeth: 1, tongue: 0, press: 0 },
    L:    { open: 0.3, wide: 0.15, jaw: 0.3, tuck: 0, teeth: 0, tongue: 1, press: 0 }
  };

  return { analyze: analyze, poseAt: poseAt, resample: resample, REST: REST, SHAPES: SHAPES, CLASS: C, CLASS_NAMES: CLASS_NAMES, FPS: FPS };
});
