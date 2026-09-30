'use strict';

/* ------------------------------------------------------------------
   1. DATA – change the paths to match your files
------------------------------------------------------------------- */
const ANIMALS = [
  { id: 'horse', name: 'Horse', image: 'images/horse.png', nameSound: 'sounds/horse.wav', emoji: '🐴' },
  { id: 'goat',  name: 'Goat',  image: 'images/goat.png',  nameSound: 'sounds/goat.wav',  emoji: '🐐' },
  { id: 'sheep', name: 'Sheep', image: 'images/sheep.png', nameSound: 'sounds/sheep.wav', emoji: '🐑' },
  { id: 'cow',   name: 'Cow',   image: 'images/cow.png',   nameSound: 'sounds/cow.wav',   emoji: '🐮' },
  { id: 'dog',   name: 'Dog',   image: 'images/dog.png',   nameSound: 'sounds/dog.wav',   emoji: '🐶' }
];

const WHAT_IS_IT_SOUND = 'sounds/what_is_it.wav';
const ITS_A_SOUND      = 'sounds/its_a.wav';
const PRAISE_SOUNDS    = ['sounds/great.wav', 'sounds/amazing.wav', 'sounds/good.wav'];
const APPLAUSE_SOUND   = 'sounds/applause.m4a';

const LISTEN_MS = 3500;            // how long the fake "listening" lasts
const FIREWORKS_DURATION = 6000;   // same as stage one

/* ------------------------------------------------------------------
   2. ELEMENTS + STATE
------------------------------------------------------------------- */
const $ = id => document.getElementById(id);
const pictureEl = $('picture'), imgEl = $('animal-img'), emojiEl = $('animal-emoji');
const answerEl = $('answer'), statusEl = $('status'), micEl = $('mic'), waveEl = $('wave');
const dotsEl = $('dots'), startEl = $('start'), winEl = $('win');

let deck = [];
let round = 0;
let gameId = 0;            // changes on restart so old async steps stop
let celebrationTimer = null;
let currentAudio = null;

const applause = new Audio(APPLAUSE_SOUND);
applause.preload = 'auto';

/* ------------------------------------------------------------------
   3. HELPERS
------------------------------------------------------------------- */
const wait = ms => new Promise(r => setTimeout(r, ms));
const setStatus = t => { statusEl.textContent = t; };
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Plays a file and resolves when it ends. A missing file resolves quickly.
function play(src) {
  return new Promise(resolve => {
    const audio = new Audio(src);
    currentAudio = audio;
    audio.addEventListener('ended', resolve);
    audio.addEventListener('error', () => setTimeout(resolve, 600));
    audio.play().catch(() => setTimeout(resolve, 600));
  });
}

function stopAllAudio() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  applause.pause();
  applause.currentTime = 0;
}

function renderDots() {
  dotsEl.innerHTML = '';
  ANIMALS.forEach((_, i) => {
    const d = document.createElement('span');
    if (i < round) d.className = 'is-done';
    else if (i === round) d.className = 'is-current';
    dotsEl.appendChild(d);
  });
}

function showAnimal(animal) {
  imgEl.hidden = false;
  emojiEl.hidden = true;
  imgEl.onerror = () => {               // missing picture: show emoji
    imgEl.hidden = true;
    emojiEl.textContent = animal.emoji;
    emojiEl.hidden = false;
  };
  imgEl.src = animal.image;
  answerEl.textContent = '';
  pictureEl.classList.remove('is-entering');
  void pictureEl.offsetWidth;           // restart the entrance animation
  pictureEl.classList.add('is-entering');
}

/* ------------------------------------------------------------------
   4. ROUND FLOW
   prompt -> picture -> mic appears -> child speaks -> praise ->
   "It's a <animal>" -> next round
------------------------------------------------------------------- */
async function runRound() {
  const id = gameId;
  const animal = deck[round];
  renderDots();
  micEl.className = 'mic';
  waveEl.classList.remove('is-on');
  micEl.disabled = true;

  showAnimal(animal);
  setStatus('What is it?');
  await play(WHAT_IS_IT_SOUND);
  if (id !== gameId) return;

  micEl.classList.add('is-visible');
  micEl.disabled = false;
  setStatus('Tap the microphone and say the word.');
  micEl.focus();
}

micEl.addEventListener('click', async () => {
  if (micEl.disabled) return;
  const id = gameId;
  micEl.disabled = true;
  micEl.classList.add('is-listening');
  waveEl.classList.add('is-on');
  setStatus('Listening…');

  /* ---- SPEECH RECOGNITION PLACEHOLDER ----
     For now we just wait. Later, replace this line with the real
     recognition call, e.g.  await recognizeSpeech(deck[round]);   */
  await wait(LISTEN_MS);
  if (id !== gameId) return;

  micEl.classList.remove('is-listening', 'is-visible');
  waveEl.classList.remove('is-on');
  await afterAnswer(id);
});

async function afterAnswer(id) {
  const animal = deck[round];

  setStatus('Great job!');
  await play(pick(PRAISE_SOUNDS));
  if (id !== gameId) return;

  answerEl.textContent = `It's a ${animal.name.toLowerCase()}`;
  await play(ITS_A_SOUND);
  if (id !== gameId) return;
  await play(animal.nameSound);
  if (id !== gameId) return;

  await wait(600);
  if (id !== gameId) return;

  round++;
  if (round < deck.length) {
    runRound();
  } else {
    renderDots();
    finish(id);
  }
}

function finish(id) {
  setStatus('You named all the animals!');
  celebrationTimer = setTimeout(() => {
    if (id !== gameId) return;
    winEl.hidden = false;
    $('play-again').focus();
    celebrate();
  }, 600);
}

/* ------------------------------------------------------------------
   5. CELEBRATION: applause + fireworks (same as stage one)
------------------------------------------------------------------- */
const canvas = $('fireworks');
const ctx = canvas.getContext('2d');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const COLORS = ['#ff4d6d', '#ffd23f', '#3ddc97', '#4cc9f0', '#b388ff', '#ff9f1c', '#ffffff'];

let rockets = [], sparks = [];
let launchTimer = null, stopLaunchTimer = null, animationId = null, lastFrame = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function launchRocket() {
  const w = window.innerWidth, h = window.innerHeight;
  rockets.push({
    x: w * (0.12 + Math.random() * 0.76),
    y: h,
    targetY: h * (0.12 + Math.random() * 0.38),
    vy: -h * (0.9 + Math.random() * 0.4),
    color: pick(COLORS)
  });
}

function explode(x, y, color) {
  const count = 70 + Math.floor(Math.random() * 30);
  const twoTone = Math.random() < 0.4;
  const second = pick(COLORS);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 80 + Math.random() * 260;
    sparks.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life: 0,
      maxLife: 1.1 + Math.random() * 0.7,
      size: 2 + Math.random() * 2.5,
      color: twoTone && i % 2 ? second : color
    });
  }
}

function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.globalCompositeOperation = 'lighter';

  rockets = rockets.filter(r => {
    r.y += r.vy * dt;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (r.y <= r.targetY) { explode(r.x, r.y, r.color); return false; }
    return true;
  });

  sparks = sparks.filter(s => {
    s.life += dt;
    if (s.life >= s.maxLife) return false;
    s.vx *= 0.985;
    s.vy = s.vy * 0.985 + 160 * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    ctx.globalAlpha = 1 - s.life / s.maxLife;
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
    ctx.fill();
    return true;
  });
  ctx.globalAlpha = 1;

  if (launchTimer !== null || rockets.length || sparks.length) {
    animationId = requestAnimationFrame(frame);
  } else {
    animationId = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

function startFireworks() {
  stopFireworks();
  resizeCanvas();
  const interval = reduceMotion ? 900 : 380;
  const duration = reduceMotion ? 2500 : FIREWORKS_DURATION;

  launchRocket();
  launchTimer = setInterval(() => {
    launchRocket();
    if (!reduceMotion && Math.random() < 0.5) launchRocket();
  }, interval);
  stopLaunchTimer = setTimeout(() => {
    clearInterval(launchTimer);
    launchTimer = null;
  }, duration);

  lastFrame = performance.now();
  animationId = requestAnimationFrame(frame);
}

function stopFireworks() {
  clearInterval(launchTimer);
  clearTimeout(stopLaunchTimer);
  launchTimer = stopLaunchTimer = null;
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  rockets = [];
  sparks = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function celebrate() {
  applause.currentTime = 0;
  applause.play().catch(() => {});
  startFireworks();
}

/* ------------------------------------------------------------------
   6. START / RESTART
------------------------------------------------------------------- */
function startGame() {
  gameId++;
  stopAllAudio();
  clearTimeout(celebrationTimer);
  stopFireworks();

  winEl.hidden = true;
  startEl.hidden = true;
  deck = shuffle(ANIMALS);
  round = 0;
  answerEl.textContent = '';
  runRound();
}

$('start-btn').addEventListener('click', startGame);   // click also unlocks audio
$('restart').addEventListener('click', startGame);
$('play-again').addEventListener('click', startGame);

renderDots();