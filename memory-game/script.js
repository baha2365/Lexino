'use strict';

/* ------------------------------------------------------------------
   1. ANIMAL DATA
   Put your files in the project folder and make sure these paths
   match your file names:
     memory-game/
       index.html, style.css, script.js
       images/horse.png, goat.png, sheep.png, cow.png, dog.png
       sounds/horse.mp3, goat.mp3, sheep.mp3, cow.mp3, dog.mp3
------------------------------------------------------------------- */
const ANIMALS = [
  { id: 'horse', name: 'Horse', image: 'images/horse.png', sound: 'sounds/horse.wav', emoji: '🐴' },
  { id: 'goat',  name: 'Goat',  image: 'images/goat.png',  sound: 'sounds/goat.wav',  emoji: '🐐' },
  { id: 'sheep', name: 'Sheep', image: 'images/sheep.png', sound: 'sounds/sheep.wav', emoji: '🐑' },
  { id: 'cow',   name: 'Cow',   image: 'images/cow.png',   sound: 'sounds/cow.wav',   emoji: '🐮' },
  { id: 'dog',   name: 'Dog',   image: 'images/dog.png',   sound: 'sounds/dog.wav',   emoji: '🐶' }
];

const FLIP_BACK_DELAY = 1000; // ms a wrong pair stays visible

// Celebration sound played when the child finds every pair.
// Put your file at sounds/applause.m4a (or change the path here).
const APPLAUSE_SOUND = 'sounds/applause.m4a';
const FIREWORKS_DURATION = 6000; // ms of new fireworks being launched

/* ------------------------------------------------------------------
   2. ELEMENTS + STATE
------------------------------------------------------------------- */
const boardEl    = document.getElementById('board');
const movesEl    = document.getElementById('moves');
const statusEl   = document.getElementById('status');
const winEl      = document.getElementById('win');
const winMovesEl = document.getElementById('win-moves');

let firstCard = null;
let secondCard = null;
let lockBoard = false;
let moves = 0;
let matchedPairs = 0;
let celebrationTimer = null;

const NEXT_STAGE_DELAY = 9000; // ms after the win screen before moving on
let nextStageTimer = null;

// One Audio object per animal, created once
const sounds = {};
ANIMALS.forEach(a => {
  const audio = new Audio(a.sound);
  audio.preload = 'auto';
  sounds[a.id] = audio;
});

const applause = new Audio(APPLAUSE_SOUND);
applause.preload = 'auto';

/* ------------------------------------------------------------------
   3. HELPERS
------------------------------------------------------------------- */
function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playSound(id) {
  // Stop any other animal that is still making noise
  Object.values(sounds).forEach(s => { s.pause(); s.currentTime = 0; });
  const audio = sounds[id];
  audio.play().catch(() => { /* file missing or blocked: ignore */ });
}

function setStatus(text) {
  statusEl.textContent = text;
}

function createCard(animal) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'card';
  card.dataset.id = animal.id;
  card.setAttribute('aria-label', 'Hidden card');

  card.innerHTML = `
    <div class="card__inner">
      <div class="card__face card__back"></div>
      <div class="card__face card__front">
        <img src="${animal.image}" alt="">
        <span class="card__name">${animal.name}</span>
      </div>
    </div>`;

  // If the picture file is missing, show an emoji instead
  const img = card.querySelector('img');
  img.addEventListener('error', () => {
    const emoji = document.createElement('span');
    emoji.className = 'card__emoji';
    emoji.textContent = animal.emoji;
    img.replaceWith(emoji);
  });

  card.addEventListener('click', () => onCardClick(card));
  return card;
}

/* ------------------------------------------------------------------
   4. GAME LOGIC
------------------------------------------------------------------- */
function onCardClick(card) {
  if (lockBoard) return;
  if (card === firstCard) return;
  if (card.classList.contains('is-matched')) return;

  flip(card);
  playSound(card.dataset.id);

  if (!firstCard) {
    firstCard = card;
    setStatus('Now find the other one.');
    return;
  }

  secondCard = card;
  moves++;
  movesEl.textContent = moves;
  checkForMatch();
}

function flip(card) {
  card.classList.add('is-flipped');
  const name = ANIMALS.find(a => a.id === card.dataset.id).name;
  card.setAttribute('aria-label', name);
}

function unflip(card) {
  card.classList.remove('is-flipped');
  card.setAttribute('aria-label', 'Hidden card');
}

function checkForMatch() {
  if (firstCard.dataset.id === secondCard.dataset.id) {
    handleMatch();
  } else {
    handleMismatch();
  }
}

function handleMatch() {
  firstCard.classList.add('is-matched');
  secondCard.classList.add('is-matched');
  matchedPairs++;
  resetTurn();

  if (matchedPairs === ANIMALS.length) {
    setStatus('You found all the animals!');
    // Let the last animal sound and flip play a moment, then celebrate
    celebrationTimer = setTimeout(() => {
      winMovesEl.textContent = moves;
      winEl.hidden = false;
      document.getElementById('play-again').focus();
      celebrate();
    }, 1200);
  } else {
    setStatus('A match! Find the next pair.');
  }
}

function handleMismatch() {
  lockBoard = true;
  setStatus('Not a match. Try again!');
  setTimeout(() => {
    unflip(firstCard);
    unflip(secondCard);
    resetTurn();
  }, FLIP_BACK_DELAY);
}

function resetTurn() {
  firstCard = null;
  secondCard = null;
  lockBoard = false;
}

/* ------------------------------------------------------------------
   5. CELEBRATION: applause + fireworks
------------------------------------------------------------------- */
const canvas = document.getElementById('fireworks');
const ctx = canvas.getContext('2d');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const COLORS = [
  '#ff4d6d', '#ffd23f', '#3ddc97', '#4cc9f0',
  '#b388ff', '#ff9f1c', '#ffffff'
];

let rockets = [];
let sparks = [];
let launchTimer = null;
let stopLaunchTimer = null;
let animationId = null;
let lastFrame = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resizeCanvas);

function launchRocket() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  rockets.push({
    x: w * (0.12 + Math.random() * 0.76),
    y: h,
    targetY: h * (0.12 + Math.random() * 0.38),
    vy: -h * (0.9 + Math.random() * 0.4),       // px per second
    color: COLORS[Math.floor(Math.random() * COLORS.length)]
  });
}

function explode(x, y, color) {
  const count = 70 + Math.floor(Math.random() * 30);
  const twoTone = Math.random() < 0.4;
  const second = COLORS[Math.floor(Math.random() * COLORS.length)];
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

  // Fade what is already drawn so moving sparks leave short trails
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.globalCompositeOperation = 'lighter';

  // Rockets rise, then burst
  rockets = rockets.filter(r => {
    r.y += r.vy * dt;
    ctx.fillStyle = r.color;
    ctx.beginPath();
    ctx.arc(r.x, r.y, 3, 0, Math.PI * 2);
    ctx.fill();
    if (r.y <= r.targetY) {
      explode(r.x, r.y, r.color);
      return false;
    }
    return true;
  });

  // Sparks fly out, fall with gravity, and fade
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

  const stillLaunching = launchTimer !== null;
  if (stillLaunching || rockets.length || sparks.length) {
    animationId = requestAnimationFrame(frame);
  } else {
    animationId = null;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

function startFireworks() {
  stopFireworks();
  resizeCanvas();

  // Reduced-motion users get a short, gentle show
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
  launchTimer = null;
  stopLaunchTimer = null;
  if (animationId) cancelAnimationFrame(animationId);
  animationId = null;
  rockets = [];
  sparks = [];
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function celebrate() {
  applause.currentTime = 0;
  applause.play().catch(() => { /* file missing or blocked: ignore */ });
  startFireworks();
}

/* ------------------------------------------------------------------
   6. START / RESTART
------------------------------------------------------------------- */
function startGame() {
  Object.values(sounds).forEach(s => { s.pause(); s.currentTime = 0; });
  applause.pause();
  applause.currentTime = 0;
  clearTimeout(celebrationTimer);
  stopFireworks();

  moves = 0;
  matchedPairs = 0;
  movesEl.textContent = '0';
  winEl.hidden = true;
  resetTurn();
  setStatus('Tap a card to find the animal.');

  // Two cards for each animal, shuffled
  const deck = shuffle([...ANIMALS, ...ANIMALS]);
  boardEl.innerHTML = '';
  deck.forEach(animal => boardEl.appendChild(createCard(animal)));
}

document.getElementById('restart').addEventListener('click', startGame);
document.getElementById('play-again').addEventListener('click', startGame);

startGame();