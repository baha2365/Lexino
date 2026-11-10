/*
 * app.js — loading a recording, playback, timeline, and feeding poses to the character.
 */
(function () {
  'use strict';

  /* Recordings to offer in the list. The page also reads the audio/ folder by itself
     when it is opened through a local web server (see README), so this can stay empty. */
  var AUDIO_FILES = [
    // 'audio/hello.mp3',
  ];
  var AUDIO_FOLDER = 'audio/';
  var AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;

  var $ = function (id) { return document.getElementById(id); };
  var Engine = window.LipSyncEngine, Character = window.Character;

  var audio = new Audio();
  audio.preload = 'auto';
  var track = null, peaks = null, objectUrl = null, loadToken = 0;
  var syncMs = 0;                 // + : mouth later, - : mouth earlier
  var heldShape = null;
  var pose = { open: 0, wide: 0, jaw: 0, tuck: 0, teeth: 0, tongue: 0, press: 0 }, target = {}, shown = {};
  var KEYS = ['open', 'wide', 'jaw', 'tuck', 'teeth', 'tongue', 'press'];
  var clock = { base: 0, wall: 0 };

  var CUE_COLORS = { 2: '#E9554B', 3: '#5E8F87', 4: '#F4B93E', 5: '#7D6BD8', 6: '#3A97D4' };
  var CUE_LABELS = { 2: 'lips closed (m, b, p)', 3: 'tongue (n, t, d, k, g, l)', 4: 's, z', 5: 'sh, zh', 6: 'f, v' };

  /* ------------------------------------------------------------- loading */

  function setStatus(text, isError) {
    $('status').textContent = text;
    $('status').parentNode.classList.toggle('is-error', !!isError);
  }

  function decode(buffer) {
    var OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new OAC(1, 2, 44100);
    return new Promise(function (resolve, reject) {
      var p = ctx.decodeAudioData(buffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  async function loadBuffer(buffer, name) {
    var token = ++loadToken;
    audio.pause();
    $('playBtn').disabled = true;
    setStatus('Reading ' + name + '…');
    try {
      var decoded = await decode(buffer.slice(0));
      if (token !== loadToken) return;
      var len = decoded.length, mono = new Float32Array(len), ch, c, i;
      for (c = 0; c < decoded.numberOfChannels; c++) { ch = decoded.getChannelData(c); for (i = 0; i < len; i++) mono[i] += ch[i]; }
      if (decoded.numberOfChannels > 1) for (i = 0; i < len; i++) mono[i] /= decoded.numberOfChannels;

      var result = await Engine.analyze(mono, decoded.sampleRate, {
        onProgress: function (p) { if (token === loadToken) setStatus('Working out the mouth movements… ' + Math.round(p * 100) + '%'); }
      });
      if (token !== loadToken) return;

      track = result;
      peaks = makePeaks(mono, 1600);
      // Play back exactly the samples that were analysed (as WAV), so the mouth and the
      // sound share one timeline in every browser, and seeking is exact.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(toWav(decoded));
      audio.src = objectUrl;
      audio.playbackRate = currentRate();
      $('timeline').classList.remove('is-empty');
      $('timeline').setAttribute('aria-valuemax', track.duration.toFixed(1));
      $('playBtn').disabled = false;
      $('legend').hidden = false;
      setStatus(name);
      drawTimeline();
      updateTime();
    } catch (err) {
      if (token !== loadToken) return;
      setStatus(name + ' could not be read as audio. Try an MP3, WAV, M4A or OGG file.', true);
      $('playBtn').disabled = !track;                 // the previous recording, if any, still plays
    }
  }

  function toWav(buf) {
    var chans = Math.min(2, buf.numberOfChannels), len = buf.length, bytes = len * chans * 2;
    var view = new DataView(new ArrayBuffer(44 + bytes)), data = [], c, i, o = 44;
    var text = function (at, str) { for (var j = 0; j < str.length; j++) view.setUint8(at + j, str.charCodeAt(j)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, chans, true); view.setUint32(24, buf.sampleRate, true);
    view.setUint32(28, buf.sampleRate * chans * 2, true); view.setUint16(32, chans * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, bytes, true);
    for (c = 0; c < chans; c++) data.push(buf.getChannelData(c));
    for (i = 0; i < len; i++) for (c = 0; c < chans; c++, o += 2) {
      var v = data[c][i]; v = v < -1 ? -1 : v > 1 ? 1 : v;
      view.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
    }
    return new Blob([view], { type: 'audio/wav' });
  }

  function loadFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadBuffer(reader.result, file.name); };
    reader.onerror = function () { setStatus(file.name + ' could not be opened.', true); };
    reader.readAsArrayBuffer(file);
  }

  async function loadUrl(url) {
    var name = decodeURIComponent(url.split('/').pop());
    setStatus('Reading ' + name + '…');
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      loadBuffer(await res.arrayBuffer(), name);
    } catch (err) {
      setStatus(name + ' was not found in the audio folder.', true);
    }
  }

  // Find recordings in the audio/ folder. Works when the page is served by a local
  // web server that lists folders (python -m http.server, VS Code Live Server, npx serve).
  async function findFolderAudio() {
    var found = AUDIO_FILES.slice();
    if (/^https?:$/.test(location.protocol)) {
      try {
        var res = await fetch(AUDIO_FOLDER, { cache: 'no-store' });
        if (res.ok) {
          var html = await res.text(), re = /href\s*=\s*["']([^"'#?]+)["']/gi, m;
          while ((m = re.exec(html))) {
            var file = m[1].split('/').pop();
            if (AUDIO_EXT.test(file) && found.indexOf(AUDIO_FOLDER + file) < 0) found.push(AUDIO_FOLDER + file);
          }
        }
      } catch (err) { /* no listing: the list just stays as configured */ }
    }
    var list = $('fileList');
    list.innerHTML = '';
    found.forEach(function (url) {
      var opt = document.createElement('option');
      opt.value = url; opt.textContent = decodeURIComponent(url.split('/').pop());
      list.appendChild(opt);
    });
    $('pickList').hidden = !found.length;
    if (found.length) loadUrl(found[0]);
    else if (/^https?:$/.test(location.protocol)) $('hint').textContent = 'Put a speech recording in the audio folder and reload, or drop one here.';
  }

  /* ------------------------------------------------------------ timeline */

  function makePeaks(samples, bins) {
    var out = new Float32Array(bins), step = samples.length / bins, i, j, max = 1e-6;
    for (i = 0; i < bins; i++) {
      var a = Math.floor(i * step), b = Math.min(samples.length, Math.floor((i + 1) * step) + 1), pk = 0;
      for (j = a; j < b; j++) { var v = Math.abs(samples[j]); if (v > pk) pk = v; }
      out[i] = pk; if (pk > max) max = pk;
    }
    for (i = 0; i < bins; i++) out[i] /= max;
    return out;
  }

  function drawTimeline() {
    var canvas = $('wave'), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    var w = Math.max(1, Math.round(box.width)), h = Math.max(1, Math.round(box.height));
    canvas.width = w * dpr; canvas.height = h * dpr;
    var g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (!track || !peaks) return;

    var lane = 8, mid = (h - lane) / 2, x, i;
    g.fillStyle = '#A9CCC4';
    for (x = 0; x < w; x += 3) {
      var a = Math.floor(x / w * peaks.length), b = Math.max(a + 1, Math.floor((x + 3) / w * peaks.length)), pk = 0;
      for (i = a; i < b; i++) if (peaks[i] > pk) pk = peaks[i];
      var bar = Math.max(1.5, Math.pow(pk, 0.6) * (mid - 6));
      g.fillRect(x, mid - bar, 2, bar * 2);
    }
    // cue lane: what the engine heard, along the bottom edge
    var cls = track.cls, n = track.frames, start = 0;
    for (i = 1; i <= n; i++) {
      if (i < n && cls[i] === cls[start]) continue;
      var color = CUE_COLORS[cls[start]];
      if (color) { g.fillStyle = color; g.fillRect(start / n * w, h - lane, Math.max(1.5, (i - start) / n * w), lane); }
      start = i;
    }
  }

  function fmt(t) { t = Math.max(0, t || 0); var m = Math.floor(t / 60), s = (t % 60).toFixed(1); if (s === '60.0') { m++; s = '0.0'; } return m + ':' + (s.length < 4 ? '0' : '') + s; }

  function updateTime() {
    var d = track ? track.duration : 0, t = Math.min(audio.currentTime || 0, d);
    $('time').textContent = fmt(t) + ' / ' + fmt(d);
    $('timeline').setAttribute('aria-valuenow', t.toFixed(1));
    $('timeline').setAttribute('aria-valuetext', fmt(t) + ' of ' + fmt(d));
  }

  function seekTo(fraction) {
    if (!track) return;
    audio.currentTime = Math.max(0, Math.min(1, fraction)) * track.duration;
    anchorClock(); updateTime();
  }

  /* ------------------------------------------------------------- playback */

  function currentRate() { var on = document.querySelector('[data-rate].is-on'); return on ? parseFloat(on.dataset.rate) : 1; }

  function anchorClock() { clock.base = audio.currentTime; clock.wall = performance.now(); }

  // audio.currentTime can advance in small jumps; run our own clock between its updates.
  function playTime() {
    if (audio.paused || audio.ended) return audio.currentTime;
    var now = performance.now(), est = clock.base + (now - clock.wall) / 1000 * audio.playbackRate, real = audio.currentTime;
    if (Math.abs(real - est) > 0.08) { clock.base = real; clock.wall = now; return real; }
    clock.base += (real - est) * 0.04;
    return est;
  }

  function togglePlay() {
    if (!track) return;
    if (audio.paused) {
      if (audio.ended || audio.currentTime >= track.duration - 0.05) audio.currentTime = 0;
      audio.play().catch(function () { setStatus('The browser blocked playback. Press play again.', true); });
    } else audio.pause();
  }

  function frame() {
    var playing = !audio.paused && !audio.ended, t = playTime(), k, key;
    if (heldShape) target = Engine.SHAPES[heldShape];
    else if (track && (playing || (t > 0.01 && t < track.duration - 0.02))) Engine.poseAt(track, t - syncMs / 1000, target);
    else target = Engine.REST;

    var ease = playing && !heldShape ? 1 : 0.28, changed = false;
    for (k = 0; k < KEYS.length; k++) {
      key = KEYS[k];
      pose[key] += ((target[key] || 0) - pose[key]) * ease;
      if (Math.abs(pose[key] - (shown[key] || 0)) > 0.002) changed = true;
    }
    if (changed) { Character.setPose(pose); for (k = 0; k < KEYS.length; k++) shown[KEYS[k]] = pose[KEYS[k]]; }

    if (track) {
      var w = $('timeline').clientWidth;
      $('playhead').style.transform = 'translateX(' + (Math.min(1, t / track.duration) * w).toFixed(1) + 'px)';
      if (playing) updateTime();
    }
    requestAnimationFrame(frame);
  }

  /* ------------------------------------------------------------------ UI */

  function setSync(ms) {
    syncMs = Math.max(-300, Math.min(300, ms));
    $('syncValue').textContent = (syncMs > 0 ? '+' : syncMs < 0 ? '−' : '') + Math.abs(syncMs) + ' ms';
    try { localStorage.setItem('lipsync.syncMs', String(syncMs)); } catch (err) { /* private mode */ }
  }

  function buildShapes() {
    var row = $('shapeRow'), labels = { A: 'A', E: 'E', I: 'I', O: 'O', U: 'U', M: 'M B P', F: 'F V', S: 'S Z', SH: 'Sh', L: 'L N T D' };
    Object.keys(labels).forEach(function (id) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'chip'; b.textContent = labels[id]; b.setAttribute('aria-pressed', 'false');
      var hold = function (e) { if (e.type === 'keydown' && e.key !== ' ' && e.key !== 'Enter') return; if (e.type === 'keydown') e.preventDefault(); heldShape = id; b.setAttribute('aria-pressed', 'true'); };
      var release = function () { if (heldShape === id) heldShape = null; b.setAttribute('aria-pressed', 'false'); };
      b.addEventListener('pointerdown', hold); b.addEventListener('keydown', hold);
      ['pointerup', 'pointerleave', 'pointercancel', 'keyup', 'blur'].forEach(function (ev) { b.addEventListener(ev, release); });
      row.appendChild(b);
    });
  }

  function buildLegend() {
    var list = $('legend');
    Object.keys(CUE_LABELS).forEach(function (c) {
      var li = document.createElement('li'), dot = document.createElement('i');
      dot.style.setProperty('--c', CUE_COLORS[c]);
      li.appendChild(dot); li.appendChild(document.createTextNode(CUE_LABELS[c]));
      list.appendChild(li);
    });
  }

  function init() {
    Character.init();
    buildShapes(); buildLegend();
    $('timeline').classList.add('is-empty');
    var saved = 0; try { saved = parseInt(localStorage.getItem('lipsync.syncMs'), 10) || 0; } catch (err) { /* ignore */ }
    setSync(saved);

    $('playBtn').addEventListener('click', togglePlay);
    audio.addEventListener('play', function () { $('playBtn').classList.add('is-playing'); $('playBtn').setAttribute('aria-label', 'Pause'); anchorClock(); });
    audio.addEventListener('playing', anchorClock);
    audio.addEventListener('seeked', anchorClock);
    audio.addEventListener('ratechange', anchorClock);
    ['pause', 'ended'].forEach(function (ev) {
      audio.addEventListener(ev, function () { $('playBtn').classList.remove('is-playing'); $('playBtn').setAttribute('aria-label', 'Play'); updateTime(); });
    });

    $('fileInput').addEventListener('change', function (e) { loadFile(e.target.files[0]); e.target.value = ''; });
    $('fileList').addEventListener('change', function (e) { loadUrl(e.target.value); });

    // drop a file anywhere on the page
    var depth = 0, tl = $('timeline');
    window.addEventListener('dragenter', function (e) { e.preventDefault(); depth++; tl.classList.add('is-drop'); });
    window.addEventListener('dragleave', function () { if (--depth <= 0) { depth = 0; tl.classList.remove('is-drop'); } });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); depth = 0; tl.classList.remove('is-drop'); loadFile(e.dataTransfer.files[0]); });

    // scrub
    var scrubbing = false, scrub = function (e) { var r = tl.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width); };
    tl.addEventListener('pointerdown', function (e) { if (!track) return; scrubbing = true; tl.setPointerCapture(e.pointerId); scrub(e); });
    tl.addEventListener('pointermove', function (e) { if (scrubbing) scrub(e); });
    ['pointerup', 'pointercancel'].forEach(function (ev) { tl.addEventListener(ev, function () { scrubbing = false; }); });
    tl.addEventListener('keydown', function (e) {
      if (!track) return;
      var step = e.key === 'ArrowRight' ? 0.1 : e.key === 'ArrowLeft' ? -0.1 : 0;      // 0.1 s: small enough to study one sound
      if (step) { e.preventDefault(); seekTo((audio.currentTime + step) / track.duration); }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== ' ' || /^(BUTTON|SELECT|INPUT|LABEL)$/.test(e.target.tagName)) return;
      e.preventDefault(); togglePlay();
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-rate]'), function (b) {
      b.setAttribute('aria-pressed', b.classList.contains('is-on'));
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('[data-rate]'), function (o) { o.classList.toggle('is-on', o === b); o.setAttribute('aria-pressed', o === b); });
        audio.playbackRate = parseFloat(b.dataset.rate);
      });
    });
    $('syncEarlier').addEventListener('click', function () { setSync(syncMs - 20); });
    $('syncLater').addEventListener('click', function () { setSync(syncMs + 20); });
    $('zoomBtn').addEventListener('click', function () {
      var on = this.getAttribute('aria-pressed') !== 'true';
      this.setAttribute('aria-pressed', on); this.textContent = on ? 'Whole face' : 'Close-up';
      Character.setCloseUp(on);
    });

    var resizeTimer = 0;
    window.addEventListener('resize', function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawTimeline, 120); });

    findFolderAudio();
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
