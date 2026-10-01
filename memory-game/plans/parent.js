'use strict';

/* ------------------------------------------------------------------
   SAMPLE DATA – later this object will come from the server / AI.
   Everything on the page is drawn from it, so only this block
   needs to be replaced.
------------------------------------------------------------------- */
const DATA = {
  child: { name: 'Aliya', age: 6, since: 'September 1' },
  stats: [
    { value: 5,    label: 'Days practised',  note: 'Goal: 5 days' },
    { value: 42,   label: 'Minutes played',  note: '+8 from last week' },
    { value: 38,   label: 'Words said',      note: '+12 from last week' },
    { value: '72%', label: 'Average clarity', note: '+6% from last week' }
  ],
  week: [
    { day: 'Mon', minutes: 8 }, { day: 'Tue', minutes: 10 }, { day: 'Wed', minutes: 0 },
    { day: 'Thu', minutes: 9 }, { day: 'Fri', minutes: 7 }, { day: 'Sat', minutes: 8 },
    { day: 'Sun', minutes: 0 }
  ],
  sounds: [
    { letter: 'r',  clarity: 38 },
    { letter: 'sh', clarity: 55 },
    { letter: 'l',  clarity: 68 },
    { letter: 's',  clarity: 82 },
    { letter: 'k',  clarity: 90 },
    { letter: 'm',  clarity: 95 }
  ],
  notes: [
    { type: 'warn', text: 'The letter "r" was not clear. It was often replaced by "w" (for example "horse" sounded like "howse"). This needs the most work.' },
    { type: 'info', text: 'The "sh" sound was clearer at the start of words than in the middle. Short words work best for now.' },
    { type: 'good', text: 'Great progress with "s" and "k". Aliya said "sheep", "cow" and "goat" clearly in most tries.' },
    { type: 'good', text: 'Aliya stayed focused for the whole 8–10 minutes in most sessions, and needed fewer repeats than last week.' }
  ],
  planGoal: 'Goal for next week: make the "r" sound clearer and keep practising "sh".',
  plan: [
    { day: 'Monday',    focus: 'Sound "r"',  minutes: 8,  task: 'Stage 2 with "horse". Growl like a tiger: "rrrr", then say "horse".' },
    { day: 'Tuesday',   focus: 'Sound "r"',  minutes: 8,  task: 'Stage 1 card game, then repeat each animal name aloud after the game.' },
    { day: 'Wednesday', focus: 'Rest day',   minutes: 0,  task: 'No games today. Read a picture book together and name the animals.' },
    { day: 'Thursday',  focus: 'Sound "sh"', minutes: 10, task: 'Stage 2 with "sheep". Say "shhh" like a quiet whisper first.' },
    { day: 'Friday',    focus: 'Sound "r"',  minutes: 8,  task: 'Stage 2, all five animals. Focus on slow, clear "r" in "horse".' },
    { day: 'Saturday',  focus: 'Mixed',      minutes: 10, task: 'Both stages. Let Aliya pick her favourite animals.' },
    { day: 'Sunday',    focus: 'Review',     minutes: 5,  task: 'One short round of Stage 2, then celebrate the week together!' }
  ],
  tips: [
    'Practise in a quiet place, sitting face to face so Aliya can see your mouth.',
    'Praise every try, even when the sound is not perfect.',
    'Keep sessions short. Stop while Aliya is still having fun.',
    'Say the word slowly first, then let Aliya copy you.'
  ]
};

/* ------------------------------------------------------------------
   RENDERING
------------------------------------------------------------------- */
const $ = id => document.getElementById(id);

function el(tag, className, html) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

function renderHeader() {
  const c = DATA.child;
  $('child-line').textContent = `${c.name}, age ${c.age} · Week of practice since ${c.since}`;
}

function renderStats() {
  DATA.stats.forEach(s => {
    $('stats').appendChild(el('div', 'stat-card',
      `<b>${s.value}</b><span>${s.label}</span><em>${s.note}</em>`));
  });
}

function renderChart() {
  const max = Math.max(...DATA.week.map(d => d.minutes), 1);
  DATA.week.forEach(d => {
    const col = el('div', 'col' + (d.minutes ? '' : ' is-zero'),
      `<span>${d.minutes}m</span><i style="height:${Math.max(d.minutes / max * 100, 4)}%"></i><span>${d.day}</span>`);
    $('chart').appendChild(col);
  });
}

function renderSounds() {
  DATA.sounds.forEach(s => {
    const level = s.clarity < 50 ? 'low' : s.clarity < 75 ? 'mid' : 'good';
    const label = { low: 'Needs work', mid: 'Improving', good: 'Clear' }[level];
    const row = el('div', `sound is-${level}`,
      `<div class="sound__letter">${s.letter}</div>
       <div class="bar"><i style="width:0"></i></div>
       <span class="tag">${label}</span>`);
    $('sounds').appendChild(row);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      row.querySelector('.bar i').style.width = s.clarity + '%';
    }));
  });
}

function renderList(id, items) {
  items.forEach(i => {
    const isObj = typeof i === 'object';
    $(id).appendChild(el('li', isObj ? i.type : '', isObj ? i.text : i));
  });
}

function renderPlan() {
  $('plan-goal').textContent = DATA.planGoal;
  $('days').innerHTML = '';
  DATA.plan.forEach(d => {
    const btn = el('button', 'day',
      `<h3>${d.day}</h3>
       <span class="focus">${d.focus}</span>
       <small>${d.minutes ? d.minutes + ' minutes' : 'No games'}</small>
       <p>${d.task}</p>`);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const done = btn.classList.toggle('is-done');
      btn.setAttribute('aria-pressed', done);
      updateProgress();
    });
    $('days').appendChild(btn);
  });
  updateProgress();
}

function updateProgress() {
  const total = DATA.plan.length;
  const done = document.querySelectorAll('.day.is-done').length;
  $('plan-progress').textContent = `${done} of ${total} days done`;
  $('plan-bar').style.width = (done / total * 100) + '%';
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Placeholder: later this will ask the AI for a fresh plan for this child.
$('regen').addEventListener('click', () => {
  renderPlan();
  toast('Sample only: the AI will make a new plan here later.');
});

renderHeader();
renderStats();
renderChart();
renderSounds();
renderList('notes', DATA.notes);
renderList('tips', DATA.tips);
renderPlan();