/* Under the City
   Reads the checked directory (data/listings.json), filters it with plain code,
   ranks what's left, and shows it as a For you page, cards, and map pins. No accounts, no server. */

const CONFIG = {
  // Where "Report a problem" emails go. Replace with your team's address.
  reportEmail: 'underthecity@example.com',
  // Distances are measured from these neighborhood centers.
  neighborhoods: {
    'Jackson Heights': [40.7557, -73.8831],
    'Elmhurst': [40.7365, -73.8780],
    'Corona': [40.7470, -73.8601],
    'Woodside': [40.7454, -73.9027],
    'Astoria': [40.7644, -73.9235],
    'Flushing': [40.7593, -73.8301],
  },
  mapCenter: [40.7480, -73.8740],
};

const TYPES = {
  study:        { label: 'Study space',     plural: 'Study spots',     letter: 'S', need: 'Study',            noun: 'place' },
  tutoring:     { label: 'Tutoring',        plural: 'Tutoring',        letter: 'T', need: 'Tutoring',         noun: 'program' },
  music:        { label: 'Music',           plural: 'Music',           letter: 'M', need: 'Music',            noun: 'program' },
  volunteering: { label: 'Volunteering',    plural: 'Volunteering',    letter: 'V', need: 'Volunteer',        noun: 'program' },
  workshop:     { label: 'Workshop',        plural: 'Workshops',       letter: 'W', need: 'Workshops',        noun: 'program' },
  support:      { label: 'Student support', plural: 'Student support', letter: 'H', need: 'Help and support', noun: 'program' },
  explore:      { label: 'Place to explore', plural: 'Places to explore', letter: 'E', need: 'Explore',        noun: 'place' },
  jobs:         { label: 'Jobs and internships', plural: 'Jobs and internships', letter: 'J', need: 'Jobs',     noun: 'program' },
};

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_SHORT = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };
const DAY_LONG = { sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday' };
const TODAY = DAYS[new Date().getDay()];

const UNKNOWN = 'Unknown. Check the source.';

const DEFAULTS = {
  need: 'any', hood: '', day: 'any', from: 'any', to: 'any',
  budget: 'any', travel: 'any', age: 'any', keywords: [], now: false,
};

let listings = [];
let view = 'list';
let saved = new Set(readStore('utc-saved', []));
// Age, neighborhood, and interests from setup. Stored only in this browser; every search starts from here.
let basics = readStore('utc-basics', {});
let state = base();

function base() {
  const hood = CONFIG.neighborhoods[basics.hood] ? basics.hood : '';
  return { ...DEFAULTS, keywords: [], hood, age: basics.age || 'any' };
}

/* ---------- small helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function readStore(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: saving just won't persist */ }
}

const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

function fmtTime(min) {
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 12 && m === 0) return 'noon';
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 || h === 24 ? 'am' : 'pm'}`;
}
function fmtRange(a, b) {
  // "3:30–5:30 pm" when both ends share am/pm, else "11 am–2 pm"
  const sa = fmtTime(a), sb = fmtTime(b);
  if (sa.slice(-2) === sb.slice(-2) && sa !== 'noon' && sb !== 'noon') return `${sa.slice(0, -3)}–${sb}`;
  return `${sa}–${sb}`;
}

function miles([lat1, lng1], [lat2, lng2]) {
  const R = 3958.8, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function costLabel(l) {
  if (l.cost == null) return { text: 'Cost unknown', cls: 'unknown' };
  if (l.cost === 0) return { text: 'Free', cls: 'free' };
  return { text: l.costText || `$${l.cost}`, cls: 'paid' };
}
const costShort = (l) => (l.cost == null ? 'Cost unknown' : l.cost === 0 ? 'Free' : `$${l.cost}`);

function ageLabel(l) {
  if (l.ageText) return l.ageText;
  if (l.ageMin == null && l.ageMax == null) return null;
  if (l.ageMax == null) return `Ages ${l.ageMin}+`;
  if (l.ageMin == null) return `Up to age ${l.ageMax}`;
  return `Ages ${l.ageMin} to ${l.ageMax}`;
}

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function checkedLabel(l) {
  if (!l.lastChecked) return { text: 'Not checked yet', cls: 'checked--no' };
  const d = new Date(l.lastChecked + 'T12:00:00');
  return { text: `Checked ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`, cls: '' };
}

// Library branch names are long. "Queens Public Library at Corona" reads as "Corona Library" in tight spots.
const shortName = (l) => l.name.replace(/^Queens Public Library at (.+)$/, '$1 Library');
const where = (r) => (r.l.online ? 'Online or by phone' : `${r.l.neighborhood}${r.dist != null ? `, about ${r.dist.toFixed(1)} mi` : ''}`);

// Application windows: "Apply by Oct 31", "Applications open Dec 1", or closed. Null when there's no window.
function applyNote(l) {
  if (!l.deadline && !l.opens) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = (iso) => new Date(iso + 'T00:00:00');
  const fmt = (iso) => day(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (l.opens && today < day(l.opens)) return { text: `Applications open ${fmt(l.opens)}`, soon: false, at: day(l.opens) };
  if (l.deadline && today <= day(l.deadline)) {
    const left = Math.round((day(l.deadline) - today) / 864e5);
    const tail = left === 0 ? ', last day' : left <= 14 ? `, ${left} day${left === 1 ? '' : 's'} left` : '';
    return { text: `Apply by ${fmt(l.deadline)}${tail}`, soon: left <= 14, at: day(l.deadline) };
  }
  return { text: 'Applications closed for now', soon: false, closed: true };
}

/* ---------- typed request → filters (no AI, just patterns) ---------- */

const NEED_WORDS = [
  ['jobs', ['job', 'internship', 'paid', 'apprenticeship', 'work']],
  ['explore', ['museum', 'garden', 'gym', 'rec center', 'explore', 'basketball']],
  ['tutoring', ['tutor', 'tutoring']],
  ['music', ['music', 'piano', 'guitar', 'violin', 'drum', 'band', 'choir', 'sing', 'jazz', 'practice']],
  ['volunteering', ['volunteer', 'community service', 'service hours']],
  ['workshop', ['workshop', 'class', 'coding', 'art', 'club', 'drawing']],
  ['support', ['college', 'career', 'counseling', 'support']],
  ['study', ['study', 'homework', 'quiet', 'place to work']],
  ['tutoring', ['math', 'algebra', 'geometry', 'physics', 'chemistry', 'biology', 'science', 'sat', 'essay', 'english']],
];
const KEYWORDS = ['math', 'algebra', 'geometry', 'physics', 'chemistry', 'biology', 'science', 'english', 'writing',
  'essay', 'reading', 'sat', 'spanish', 'coding', 'piano', 'guitar', 'violin', 'drums', 'jazz', 'art', 'drawing', 'chess', 'college'];

const word = (w) => new RegExp(`\\b${w.replace(/ /g, '\\s+')}(s|es|ing)?\\b`, 'i');

function parseClock(h, m, ampm) {
  let hour = Number(h);
  if (ampm === 'pm' && hour < 12) hour += 12;
  else if (ampm === 'am' && hour === 12) hour = 0;
  else if (!ampm && hour >= 1 && hour <= 7) hour += 12; // "before 5" means 5 pm for a student
  return hour * 60 + Number(m || 0);
}
const snap = (min) => Math.min(21 * 60, Math.max(7 * 60, Math.round(min / 30) * 30));

function parseRequest(raw) {
  const t = raw.toLowerCase();
  const f = base();

  for (const [type, words] of NEED_WORDS) {
    if (words.some((w) => word(w).test(t))) { f.need = type; break; }
  }
  for (const h of Object.keys(CONFIG.neighborhoods)) if (t.includes(h.toLowerCase())) f.hood = h;

  if (/\bfree\b/.test(t)) f.budget = '0';
  const under = t.match(/(?:under|less than|below|max|up to)\s*\$\s?(\d+)|(?:under|less than|below)\s+(\d+)\s*(?:dollars|bucks)/);
  if (under) {
    const n = Number(under[1] || under[2]);
    f.budget = String(BUDGETS.find((b) => b >= n) ?? 'any');
  }

  const before = t.match(/\b(?:before|until|by)\s+(\d{1,2})(?::(\d\d))?\s*(am|pm)?/);
  if (before) f.to = String(snap(parseClock(before[1], before[2], before[3])));
  const after = t.match(/\bafter\s+(\d{1,2})(?::(\d\d))?\s*(am|pm)?/);
  if (after) f.from = String(snap(parseClock(after[1], after[2], after[3])));
  if (/after school/.test(t)) f.from = String(15 * 60);
  if (/\b(tonight|evening)\b/.test(t)) f.from = String(18 * 60);
  if (/\bmorning\b/.test(t)) f.to = String(12 * 60);

  if (/\bweekends?\b/.test(t)) f.day = 'weekend';
  else if (/\btoday\b|\btonight\b/.test(t)) f.day = TODAY;
  else if (/\btomorrow\b/.test(t)) f.day = DAYS[(new Date().getDay() + 1) % 7];
  else for (const d of DAYS) if (new RegExp(`\\b${DAY_LONG[d].toLowerCase()}s?\\b`).test(t)) { f.day = d; break; }

  const dist = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|miles?)\b/);
  if (dist) f.travel = String(TRAVELS.find((x) => x >= Number(dist[1])) ?? 'any');
  else if (f.hood && /\b(walking distance|close by|nearby)\b/.test(t)) f.travel = '1';
  else if (f.hood && /\bget to\b/.test(t)) f.travel = '2'; // a short bus or train ride

  const age = t.match(/\b(\d{2})\s*(?:years? old|yo)\b|\bage\s*(\d{1,2})\b|\bgrade\s*(\d{1,2})\b/);
  if (age) f.age = String(age[1] ? +age[1] : age[2] ? +age[2] : +age[3] + 5);

  f.keywords = KEYWORDS.filter((k) => word(k).test(t));
  return f;
}

/* ---------- filtering and ranking ---------- */

function daysToCheck(f) {
  if (f.day === 'weekend') return ['sat', 'sun'];
  if (f.day !== 'any') return [f.day];
  const start = new Date().getDay();
  return DAYS.map((_, i) => DAYS[(start + i) % 7]); // today first
}

// A session counts for a time window when it overlaps it by half an hour, or entirely if it's shorter.
const fits = (s, e, from, to) => Math.min(e, to) - Math.max(s, from) >= Math.min(30, e - s);

// Returns the first session that fits, { unknown: true } when hours aren't listed, or null when nothing fits.
function matchTime(l, f) {
  if (!l.hours) return { unknown: true };
  const from = f.from === 'any' ? 0 : Number(f.from);
  const to = f.to === 'any' ? 24 * 60 : Number(f.to);
  for (const d of daysToCheck(f)) {
    for (const [s, e] of l.hours[d] || []) {
      const a = toMin(s), b = toMin(e);
      if (fits(a, b, from, to)) return { day: d, start: a, end: b };
    }
  }
  return null;
}

// Unknown values never hide a listing. They lower its rank and are said out loud.
function evaluate(l, f) {
  if (f.need !== 'any' && l.type !== f.need) return null;

  const unknowns = [];
  if (l.cost == null) unknowns.push('cost');
  else if (f.budget !== 'any' && l.cost > Number(f.budget)) return null;

  const age = f.age === 'any' ? null : Number(f.age);
  if (l.ageMin == null && l.ageMax == null) unknowns.push('age');
  else if (age != null && ((l.ageMin != null && age < l.ageMin) || (l.ageMax != null && age > l.ageMax))) return null;

  let dist = null;
  if (f.hood && !l.online) {
    dist = miles(CONFIG.neighborhoods[f.hood], [l.lat, l.lng]);
    if (f.travel !== 'any' && dist > Number(f.travel)) return null;
  }

  const slot = matchTime(l, f);
  if (!slot) return null;
  // "Open now" is a promise, so unlisted hours can't count toward it.
  if (slot.unknown && f.now) return null;
  if (slot.unknown) unknowns.push('hours');

  const hay = [l.name, ...(l.tags || [])].join(' ').toLowerCase();
  const matched = f.keywords.filter((k) => word(k).test(hay));

  let score = 100;
  if (dist != null) score -= dist * 12;
  else if (l.online && f.hood) score -= 8; // nearby places edge out online help, which is always there
  if (applyNote(l)?.soon) score += 15;
  if (l.cost === 0) score += 10;
  score += matched.length * 25;
  score -= unknowns.length * 10;

  return { l, slot, dist, matched, unknowns, score };
}

function search(f = state) {
  return listings.map((l) => evaluate(l, f)).filter(Boolean).sort((a, b) => b.score - a.score);
}

function whyLine(r) {
  const { l, slot, dist, matched } = r;
  const parts = [];
  const c = costLabel(l);
  parts.push(c.cls === 'free' ? 'free' : c.cls === 'paid' ? c.text : 'cost not listed');
  const day = slot.day === TODAY ? 'today' : DAY_SHORT[slot.day];
  if (slot.unknown) { if (!l.whenText) parts.push('hours not listed'); }
  else if (l.type === 'study') parts.push(`open until ${fmtTime(slot.end)} ${day}`);
  else parts.push(`meets ${day} ${fmtRange(slot.start, slot.end)}`);
  if (dist != null) parts.push(`about ${dist.toFixed(1)} mi away`);
  else if (l.online) parts.push('online or by phone');
  const a = ageLabel(l);
  parts.push(a ? a.toLowerCase() : 'age range not listed');
  if (matched.length) parts.push(`covers ${matched.join(' and ')}`);
  const s = parts.join(', ');
  return s[0].toUpperCase() + s.slice(1);
}

// The next time a listing is open or meeting, starting from right now. `only` limits the days looked at.
function nextSession(l, only = DAYS) {
  if (!l.hours) return null;
  const d = new Date(), nowMin = d.getHours() * 60 + d.getMinutes();
  for (let offset = 0; offset <= 7; offset++) {
    const day = DAYS[(d.getDay() + offset) % 7];
    if (!only.includes(day)) continue;
    const slots = (l.hours[day] || []).map(([s, e]) => [toMin(s), toMin(e)]).sort((a, b) => a[0] - b[0]);
    for (const [start, end] of slots) {
      if (offset === 0 && end <= nowMin) continue;
      return { day, offset, start, end, live: offset === 0 && start <= nowMin };
    }
  }
  return null;
}

function whenLabel(n, l) {
  if (!n) return l.whenText || 'Hours not listed';
  if (n.live) return `${l.type === 'study' ? 'Open' : 'On'} now until ${fmtTime(n.end)}`;
  const day = n.offset === 0 ? 'Today' : n.offset === 1 ? 'Tomorrow' : n.offset === 7 ? `Next ${DAY_SHORT[n.day]}` : DAY_SHORT[n.day];
  return `${day} ${fmtRange(n.start, n.end)}`;
}

/* ---------- controls ---------- */

const BUDGETS = [0, 5, 10, 20];
const TRAVELS = [0.5, 1, 2];

function fillSelect(el, options) {
  el.innerHTML = options.map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
}

function setupControls() {
  const needs = $('#needs');
  needs.innerHTML = `<button type="button" class="need need--all" role="radio" data-need="any">Anything</button>` +
    Object.entries(TYPES).map(([k, t]) =>
      `<button type="button" class="need" role="radio" data-need="${k}"><span class="bullet bullet--sm bullet--${k}" aria-hidden="true">${t.letter}</span>${t.need}</button>`).join('');
  needs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-need]');
    if (b) update({ need: b.dataset.need });
  });

  fillSelect($('#f-hood'), [['', 'Anywhere'], ...Object.keys(CONFIG.neighborhoods).map((h) => [h, h])]);
  fillSelect($('#f-day'), [['any', 'Any day'], [TODAY, `Today (${DAY_SHORT[TODAY]})`], ['weekend', 'Weekend'],
    ...['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, DAY_LONG[d]])]);
  const times = []; for (let m = 7 * 60; m <= 21 * 60; m += 30) times.push([String(m), fmtTime(m)]);
  fillSelect($('#f-from'), [['any', 'Any time'], ...times]);
  fillSelect($('#f-to'), [['any', 'Any time'], ...times]);
  fillSelect($('#f-budget'), [['any', 'Any cost'], ['0', 'Free only'], ...BUDGETS.slice(1).map((b) => [String(b), `Up to $${b}`])]);
  fillSelect($('#f-travel'), [['any', 'Any distance'], ...TRAVELS.map((t) => [String(t), `About ${t} mi`])]);
  const ages = []; for (let a = 10; a <= 19; a++) ages.push([String(a), String(a)]);
  fillSelect($('#f-age'), [['any', 'Any age'], ...ages]);

  const map = { '#f-hood': 'hood', '#f-day': 'day', '#f-from': 'from', '#f-to': 'to', '#f-budget': 'budget', '#f-travel': 'travel', '#f-age': 'age' };
  for (const [sel, key] of Object.entries(map)) {
    // Changing the day or time by hand turns "Free right now" off.
    const off = ['day', 'from', 'to'].includes(key) ? { now: false } : {};
    $(sel).addEventListener('change', (e) => update({ [key]: e.target.value, ...off }));
  }

  $('#filters-toggle').addEventListener('click', (e) => {
    const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
    e.currentTarget.setAttribute('aria-expanded', String(!open));
    $('#filters').hidden = open;
  });
  $('#filters-reset').addEventListener('click', () => { $('#q').value = ''; update(base(), true); });

  $('#right-now').addEventListener('click', () => {
    $('#q').value = '';
    if (state.now) return update(base(), true);
    const d = new Date();
    const from = Math.floor((d.getHours() * 60 + d.getMinutes()) / 30) * 30;
    update({ ...base(), now: true, day: TODAY, from: String(from), to: String(Math.min(from + 120, 24 * 60 - 1)), budget: '0' }, true);
    $('.summary').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  });

  $('#share-saved').addEventListener('click', shareSaved);
  $('#shared-save').addEventListener('click', () => {
    const n = sharedIds.filter((id) => !saved.has(id)).length;
    sharedIds.forEach((id) => saved.add(id));
    writeStore('utc-saved', [...saved]);
    closeShared();
    renderSaved();
    renderUpcoming();
    toast(n === 1 ? 'Saved 1 place.' : `Saved ${n} places.`);
  });
  $('#shared-dismiss').addEventListener('click', closeShared);

  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#q').value.trim();
    if (!q) return;
    update(parseRequest(q), true);
  });
  $('#examples').addEventListener('click', (e) => {
    const b = e.target.closest('.example');
    if (!b) return;
    $('#q').value = b.textContent;
    update(parseRequest(b.textContent), true);
  });

  $('#active-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-clear]');
    if (b) update(clearPatch(b.dataset.clear));
  });

  document.querySelectorAll('.viewtoggle button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

  document.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return openDetails(open.dataset.open);
    const save = e.target.closest('[data-save]');
    if (save) return toggleSave(save.dataset.save);
    const kind = e.target.closest('[data-kind]');
    if (kind) { $('#q').value = ''; update({ ...base(), need: kind.dataset.kind }, true); return showResults(); }
    const stop = e.target.closest('[data-stop]');
    if (stop) return selectStop(Number(stop.dataset.stop));
    if (e.target.closest('[data-stop-more]')) return seeStop();
    const go = e.target.closest('[data-goto]');
    if (go) { showTab(go.dataset.goto); if (go.dataset.focus) $(go.dataset.focus)?.focus(); return; }
    const relax = e.target.closest('[data-relax]');
    if (relax) return update(clearPatch(relax.dataset.relax));
    if (e.target.closest('[data-sample-hide]')) { writeStore('utc-sample-hidden', true); return renderSampleNotes(); }
    if (e.target.closest('#setup-start, #you-setup')) return startOnboarding();
  });

  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => {
    // Tapping the tab you're on goes back to the top, like a phone app.
    if (b.dataset.tab === currentTab) return window.scrollTo({ top: 0, behavior: reduceMotion() ? 'auto' : 'smooth' });
    showTab(b.dataset.tab, true);
  }));

  $('#tab-you').addEventListener('click', (e) => {
    const a = e.target.closest('[data-you-age]');
    if (a) return setBasics({ age: basics.age === a.dataset.youAge ? '' : a.dataset.youAge });
    const h = e.target.closest('[data-you-hood]');
    if (h) return setBasics({ hood: h.dataset.youHood });
    const i = e.target.closest('[data-you-into]');
    if (i) {
      const set = new Set(basics.interests || []);
      set.has(i.dataset.youInto) ? set.delete(i.dataset.youInto) : set.add(i.dataset.youInto);
      return setBasics({ interests: [...set] });
    }
  });
  $('#you-forget').addEventListener('click', forgetEverything);

  const ob = $('#onboard');
  ob.addEventListener('click', onboardingClick);
  // Escape skips setup. It closes at once, since keyboard actions shouldn't wait on an animation.
  ob.addEventListener('cancel', (e) => { e.preventDefault(); finishOnboarding(true, true); });
  ob.addEventListener('close', () => finishOnboarding(true, true));

  const report = `mailto:${CONFIG.reportEmail}?subject=${encodeURIComponent('Under the City: correction')}`;
  $('#about-report').href = report;
}

function update(patch, fromSearch = false) {
  state = fromSearch ? { ...DEFAULTS, keywords: [], ...patch } : { ...state, ...patch };
  if (!fromSearch && !('keywords' in patch)) state.keywords = state.keywords || [];
  syncControls();
  renderExplore();
}

function syncControls() {
  $('#f-hood').value = state.hood;
  $('#f-day').value = state.day;
  setTimeSelect($('#f-from'), state.from);
  setTimeSelect($('#f-to'), state.to);
  $('#right-now').setAttribute('aria-pressed', String(state.now));
  $('#f-budget').value = state.budget;
  $('#f-travel').value = state.travel;
  $('#f-age').value = state.age;
  $('#f-travel').disabled = !state.hood;
  document.querySelectorAll('.need').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.need === state.need)));
  const n = ['day', 'from', 'to', 'budget', 'travel', 'age'].filter((k) => state[k] !== 'any').length;
  $('#filters-count').textContent = n || '';
}

// "Free right now" late at night, or an hour picked on the line, can fall outside the 7 am to 9 pm list.
// Add that time instead of showing a blank.
function setTimeSelect(el, v) {
  if (![...el.options].some((o) => o.value === v)) el.add(new Option(fmtTime(+v), v));
  el.value = v;
}

/* ---------- active filters as chips, and how to relax them ---------- */

function activeFilters() {
  const s = state, out = [];
  if (s.need !== 'any') out.push(['need', TYPES[s.need].label]);
  if (s.hood) out.push(['hood', `Near ${s.hood}`]);
  if (s.now) out.push(['time', `Open now, until ${fmtTime(+s.to)}`]);
  else if (s.day !== 'any') out.push(['day', s.day === 'weekend' ? 'Weekend' : DAY_LONG[s.day]]);
  if (!s.now && (s.from !== 'any' || s.to !== 'any')) {
    const label = s.from !== 'any' && s.to !== 'any' ? fmtRange(+s.from, +s.to)
      : s.from !== 'any' ? `After ${fmtTime(+s.from)}` : `Before ${fmtTime(+s.to)}`;
    out.push(['time', label]);
  }
  if (s.budget !== 'any') out.push(['budget', s.budget === '0' ? 'Free' : `Up to $${s.budget}`]);
  if (s.travel !== 'any' && s.hood) out.push(['travel', `Within about ${s.travel} mi`]);
  if (s.age !== 'any') out.push(['age', `Age ${s.age}`]);
  for (const k of s.keywords) out.push([`kw:${k}`, k === 'sat' ? 'SAT' : k[0].toUpperCase() + k.slice(1)]);
  return out;
}

function clearPatch(key) {
  if (key === 'time') return state.now ? { from: 'any', to: 'any', day: 'any', now: false } : { from: 'any', to: 'any' };
  if (key === 'hood') return { hood: '', travel: 'any' };
  if (key.startsWith('kw:')) return { keywords: state.keywords.filter((k) => k !== key.slice(3)) };
  return { [key]: DEFAULTS[key] };
}

// For an empty result, suggest loosening one filter. Try the ones students give up most easily
// first (distance, time) and only suggest changing what they need as a last resort.
const RELAX_ORDER = ['travel', 'time', 'day', 'budget', 'age', 'need'];

function bestRelaxation() {
  const active = new Map(activeFilters());
  for (const key of RELAX_ORDER) {
    if (!active.has(key)) continue;
    const n = search({ ...state, ...clearPatch(key) }).length;
    if (n) return { key, label: active.get(key), n };
  }
  return null;
}

/* ---------- rendering ---------- */

const ICON_SAVE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z"/></svg>';
const ICON_DIR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.8l9.2 9.2-9.2 9.2L2.8 12z"/><path d="M9 13.5v-2.5h5.5M12.5 8.5l2.5 2.5-2.5 2.5"/></svg>';
const ICON_CAL = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
const ICON_PIN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/></svg>';

const ICON_SHARE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3.5M7.5 8L12 3.5 16.5 8"/><path d="M5 12.5v6.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-6.5"/></svg>';

const directionsUrl = (l) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(l.address)}`;

function hoursLine(r) {
  if (r.slot.unknown) return r.l.whenText ? esc(r.l.whenText) : `<span class="unknown">Hours: ${UNKNOWN}</span>`;
  return `${r.slot.day === TODAY ? 'Today' : DAY_LONG[r.slot.day]}, ${fmtRange(r.slot.start, r.slot.end)}`;
}

function renderCard(r) {
  const { l, dist } = r;
  const t = TYPES[l.type];
  const c = costLabel(l);
  const ch = checkedLabel(l);
  const isSaved = saved.has(l.id);
  const ap = applyNote(l);
  return `<li><article class="card" aria-labelledby="n-${l.id}">
    <div class="card__head">
      <span class="bullet bullet--${l.type}" aria-hidden="true">${t.letter}</span>
      <div>
        <button type="button" class="card__name" id="n-${l.id}" data-open="${l.id}">${esc(l.name)}</button>
        <p class="card__type">${t.label}</p>
      </div>
      <span class="cost cost--${c.cls}">${c.text}</span>
    </div>
    <div class="card__facts">
      <p>${l.online ? esc(l.address) : `${esc(l.address.split(',')[0])}, ${esc(l.neighborhood)}`}${dist != null ? `<span class="muted">, about ${dist.toFixed(1)} mi</span>` : ''}</p>
      <p>${hoursLine(r)}</p>
      ${ap ? `<p class="apply${ap.soon ? ' apply--soon' : ''}${ap.closed ? ' apply--closed' : ''}">${esc(ap.text)}</p>` : ''}
    </div>
    <p class="why">${esc(whyLine(r))}</p>
    <p class="card__source">Source: <a href="${esc(l.sourceUrl)}" target="_blank" rel="noopener">${esc(domain(l.sourceUrl))}</a>, <span class="${ch.cls}">${ch.text}</span></p>
    <div class="card__actions">
      <button type="button" class="btn btn--quiet save" data-save="${l.id}" aria-pressed="${isSaved}">${ICON_SAVE}${isSaved ? 'Saved' : 'Save'}</button>
      ${l.online ? `<a class="btn btn--quiet" href="${esc(l.contact?.web || l.sourceUrl)}" target="_blank" rel="noopener">Open the site</a>`
        : `<a class="btn btn--quiet" href="${directionsUrl(l)}" target="_blank" rel="noopener">${ICON_DIR}Directions</a>`}
    </div>
  </article></li>`;
}

// A compact listing row, used on the line and in "Coming up".
function rowHtml(l, meta) {
  const c = costLabel(l);
  return `<li><button type="button" class="row" data-open="${l.id}">
    <span class="bullet bullet--${l.type}" aria-hidden="true">${TYPES[l.type].letter}</span>
    <span><span class="row__name">${esc(shortName(l))}</span><span class="row__meta">${esc(meta)}</span></span>
    <span class="cost cost--${c.cls}">${costShort(l)}</span>
  </button></li>`;
}

function posterHtml(r, when) {
  const l = r.l, t = TYPES[l.type];
  const label = [shortName(l), t.label, costShort(l), when, where(r)].join(', ');
  return `<li><button type="button" class="poster k-${l.type}" data-open="${l.id}" aria-label="${esc(label)}">
    <span class="poster__mark">${t.letter}</span>
    <span class="poster__kind">${t.label}</span>
    <span class="poster__sticker">${costShort(l)}</span>
    <span class="poster__name">${esc(shortName(l))}</span>
    <span class="poster__when">${esc(when)}</span>
    <span class="poster__where">${esc(where(r))}</span>
  </button></li>`;
}

let lastResults = [];

function renderExplore() {
  const results = search();
  lastResults = results;

  const where = state.hood ? ` near ${state.hood}` : '';
  const noun = state.now ? 'open now' : results.length === 1 ? 'match' : 'matches';
  $('#count').textContent = `${results.length} ${noun}${where}`;

  $('#active-chips').innerHTML = activeFilters()
    .map(([k, label]) => `<li><button type="button" class="chip" data-clear="${esc(k)}" aria-label="Remove filter: ${esc(label)}">${esc(label)}${ICON_X}</button></li>`).join('');

  $('#list').innerHTML = results.map(renderCard).join('');

  const empty = $('#empty');
  if (results.length) {
    empty.hidden = true;
  } else {
    const r = bestRelaxation();
    const title = state.now ? 'Nothing here is open in the next 2 hours' : 'Nothing fits every filter';
    empty.innerHTML = `<p class="empty__title">${title}</p>` + (r
      ? `<p>Remove "${esc(r.label)}" to see ${r.n === 1 ? '1 listing' : `${r.n} listings`}.</p>
         <button type="button" class="btn btn--primary" data-relax="${esc(r.key)}">Remove "${esc(r.label)}"</button>`
      : `<p>Try a different neighborhood or kind of listing.</p>
         <button type="button" class="btn btn--primary" id="empty-reset">Clear all filters</button>`);
    empty.hidden = false;
    $('#empty-reset')?.addEventListener('click', () => { $('#q').value = ''; update(base(), true); });
  }

  drawMap(results);
}

function renderSaved() {
  const f = { ...DEFAULTS, hood: state.hood };
  const items = listings.filter((l) => saved.has(l.id)).map((l) => evaluate(l, f)).filter(Boolean);
  $('#saved-list').innerHTML = items.map(renderCard).join('');
  $('#saved-empty').hidden = items.length > 0;
  $('#share-saved').hidden = !items.length;
  renderShared();
}

function renderBasics() {
  const hood = base().hood;
  const who = [basics.age && `age ${esc(basics.age)}`, hood && `near ${esc(hood)}`].filter(Boolean).join(', ');
  $('#basics').innerHTML = who
    ? `Searches start at <b>${who}</b>. <button type="button" class="link-btn" data-goto="you">Change</button>`
    : `Set your age and neighborhood once, and every search starts there. <button type="button" class="link-btn" data-goto="you">Set them</button>`;
}

function renderSampleNotes() {
  const show = !readStore('utc-sample-hidden', false) && listings.some((l) => l.sample);
  document.querySelectorAll('.sample-note').forEach((p) => { p.hidden = !show; });
}

/* ---------- For you ---------- */

function renderHome() {
  const all = search(base());
  const into = new Set(basics.interests || []);
  const hood = base().hood;

  const free = all.filter((r) => r.l.cost === 0).length;
  const sessions = all.reduce((n, r) => n + Object.values(r.l.hours || {}).reduce((m, iv) => m + iv.length, 0), 0);
  const place = hood ? `near ${hood}` : 'in Queens';
  const hr = new Date().getHours();
  $('#home-when').textContent = `${DAY_LONG[TODAY]} ${hr < 12 ? 'morning' : hr < 17 ? 'afternoon' : 'evening'}`;
  $('#home-title').textContent = free ? `${free} free things to do ${place}` : `${all.length} things to do ${place}`;
  $('#home-sub').textContent = `${sessions} sessions and open hours every week${basics.age ? `, picked for age ${basics.age}` : ''}.`;
  $('#home-hood').innerHTML = `${ICON_PIN}${esc(hood || 'Neighborhood')}`;
  $('#home-hood').setAttribute('aria-label', hood ? `Neighborhood: ${hood}. Change it` : 'Pick a neighborhood');
  $('#home-lines').innerHTML = Object.entries(TYPES).map(([k, t]) => `<span class="bullet bullet--${k}">${t.letter}</span>`).join('');

  $('#setup-card').hidden = Boolean(basics.done && basics.age && (basics.interests || []).length);

  buildStrip();
  renderStrip();

  // Interests go first, and programs edge out study rooms, which are always there.
  const picked = all.map((r) => ({ r, s: r.score + (into.has(r.l.type) ? 40 : 0) + (r.l.type !== 'study' ? 8 : 0) }))
    .sort((a, b) => b.s - a.s).slice(0, 8).map((x) => x.r);
  $('#picked-title').textContent = into.size ? 'Picked for you' : 'Good places to start';
  $('#picked').innerHTML = picked.map((r) => posterHtml(r, whenLabel(nextSession(r.l), r.l))).join('');

  $('#kinds').innerHTML = Object.entries(TYPES).map(([k, t]) => {
    const n = all.filter((r) => r.l.type === k).length;
    return `<button type="button" class="kind k-${k}" data-kind="${k}">
      <span class="bullet" aria-hidden="true">${t.letter}</span>
      <span><span class="kind__name">${t.plural}</span><span class="kind__count">${n} ${t.noun}${n === 1 ? '' : 's'}</span></span>
    </button>`;
  }).join('');

  const apply = listings.map((l) => ({ l, a: applyNote(l) })).filter((x) => x.a && !x.a.closed)
    .sort((x, y) => x.a.at - y.a.at);
  $('#apply').hidden = !apply.length;
  $('#apply-track').innerHTML = apply.map(({ l, a }) => posterHtml(evaluate(l, { ...DEFAULTS, hood }) || { l, dist: null }, a.text)).join('');

  const weekend = all.filter((r) => r.l.type !== 'study')
    .map((r) => ({ r, n: nextSession(r.l, ['sat', 'sun']) })).filter((x) => x.n)
    .sort((a, b) => into.has(b.r.l.type) - into.has(a.r.l.type) || a.n.offset - b.n.offset || a.n.start - b.n.start)
    .slice(0, 8);
  $('#weekend').hidden = !weekend.length;
  $('#weekend-track').innerHTML = weekend.map(({ r, n }) => posterHtml(r, whenLabel(n, r.l))).join('');

  renderUpcoming();
}

function renderUpcoming() {
  const f = { ...DEFAULTS, hood: base().hood };
  const items = listings.filter((l) => saved.has(l.id))
    .map((l) => ({ l, n: nextSession(l), r: evaluate(l, f) })).filter((x) => x.n)
    .sort((a, b) => a.n.offset - b.n.offset || a.n.start - b.n.start).slice(0, 4);
  $('#upcoming').hidden = !items.length;
  $('#upcoming-rows').innerHTML = items.map(({ l, n, r }) => rowHtml(l, `${whenLabel(n, l)}, ${r ? where(r) : l.neighborhood}`)).join('');
}

/* ---------- the line: what's on, hour by hour ---------- */

let strip = { day: TODAY, offset: 0, stops: [], sel: 0 };

// Each hour from 7 am to 9 pm is a stop. A listing is at a stop when it's open or meeting then.
// If nothing is left today, the line moves to the next day that has something.
function buildStrip() {
  const pool = search(base()).filter((r) => r.l.hours);
  const into = new Set(basics.interests || []);
  const rank = (r) => (into.has(r.l.type) ? 0 : 2) + (r.l.type === 'study' ? 1 : 0);
  const keep = strip.stops[strip.sel];
  const d = new Date(), nowMin = d.getHours() * 60 + d.getMinutes();

  for (let offset = 0; offset < 7; offset++) {
    const day = DAYS[(d.getDay() + offset) % 7];
    const all = [];
    for (let h = 7; h <= 21; h++) {
      if (offset === 0 && h * 60 + 60 <= nowMin) continue;
      const now = offset === 0 && h * 60 <= nowMin;
      const from = now ? Math.floor(nowMin / 30) * 30 : h * 60;
      const to = from + 60;
      const items = [];
      for (const r of pool) {
        const hit = (r.l.hours[day] || []).map(([s, e]) => [toMin(s), toMin(e)])
          .find(([s, e]) => fits(s, e, from, to) && (!now || e > nowMin));
        if (hit) items.push({ ...r, start: hit[0], end: hit[1] });
      }
      items.sort((x, y) => rank(x) - rank(y) || (x.dist ?? 0) - (y.dist ?? 0) || x.start - y.start);
      all.push({ h, now, from, to, items });
    }
    const first = all.findIndex((s) => s.items.length);
    if (first === -1) continue;
    let last = all.length - 1;
    while (!all[last].items.length) last--;
    const stops = all.slice(first, last + 1);
    if (all[0].now && first > 0) stops.unshift(all[0]);

    // Keep the hour the student picked when the page redraws; otherwise start at now, or the first busy stop.
    let sel = keep && strip.day === day ? stops.findIndex((s) => s.h === keep.h && s.items.length) : -1;
    if (sel === -1) sel = stops.findIndex((s) => s.now && s.items.length);
    if (sel === -1) sel = stops.findIndex((s) => s.items.length);
    strip = { day, offset, stops, sel };
    return;
  }
  strip = { day: TODAY, offset: 0, stops: [], sel: 0 };
}

function renderStrip() {
  $('#strip-card').hidden = !strip.stops.length;
  if (!strip.stops.length) return;
  $('#strip-title').textContent = strip.offset === 0 ? "What's on today"
    : strip.offset === 1 ? "What's on tomorrow" : `What's on ${DAY_LONG[strip.day]}`;

  $('#stops').innerHTML = strip.stops.map((s, i) => {
    const n = s.items.length;
    const time = s.now ? 'Now' : fmtTime(s.h * 60);
    const minis = s.items.slice(0, 5).map((r) => `<span class="bullet bullet--xs bullet--${r.l.type}">${TYPES[r.l.type].letter}</span>`).join('')
      + (n > 5 ? `<span class="stop__more">+${n - 5}</span>` : '');
    return `<li><button type="button" class="stop${s.now ? ' stop--now' : ''}${n ? '' : ' stop--empty'}" data-stop="${i}"
      aria-pressed="${i === strip.sel}" aria-label="${time}: ${n === 1 ? '1 listing' : `${n} listings`}">
      <span class="stop__time">${time}</span><span class="stop__dot"></span><span class="stop__minis">${minis}</span>
    </button></li>`;
  }).join('');
  renderStopRows();

  const sc = $('.strip__scroll'), btn = $(`#stops [data-stop="${strip.sel}"]`);
  if (btn) sc.scrollLeft = Math.max(0, btn.getBoundingClientRect().left - sc.getBoundingClientRect().left + sc.scrollLeft - 24);
}

function renderStopRows() {
  const s = strip.stops[strip.sel];
  if (!s) return;
  const day = strip.offset === 0 ? 'today' : strip.offset === 1 ? 'tomorrow' : `on ${DAY_LONG[strip.day]}`;
  $('#stop-title').textContent = s.now ? 'On now' : `At ${fmtTime(s.h * 60)} ${day}`;
  const rows = s.items.slice(0, 6).map((r) =>
    rowHtml(r.l, `${r.start > s.from ? `Starts ${fmtTime(r.start)}` : `Until ${fmtTime(r.end)}`}, ${where(r)}`));
  if (!s.items.length) rows.push('<li class="rows__empty">Nothing listed for this hour. Try another stop on the line.</li>');
  if (s.items.length > 6) rows.push('<li class="rows__more"><button type="button" class="link-btn" data-stop-more>See all of them in Explore</button></li>');
  $('#stop-rows').innerHTML = rows.join('');
}

function selectStop(i) {
  strip.sel = i;
  document.querySelectorAll('#stops .stop').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.stop) === i)));
  renderStopRows();
}

function seeStop() {
  const s = strip.stops[strip.sel];
  $('#q').value = '';
  update({ ...base(), day: strip.day, from: String(s.from), to: String(s.to) }, true);
  showResults();
}

// Shortcuts into Explore land on the results, with the chosen need chip in view.
function showResults() {
  showTab('explore');
  const row = $('#needs');
  const on = $('[aria-checked="true"]', row);
  if (on) row.scrollLeft += on.getBoundingClientRect().left - row.getBoundingClientRect().left - 16;
  window.scrollTo(0, row.getBoundingClientRect().top + window.scrollY - 72);
}

/* ---------- first-run setup ---------- */

const OB_STEPS = ['welcome', 'age', 'hood', 'interests'];
// hood: null means not answered yet, '' means "somewhere else".
let ob = null;

function startOnboarding() {
  ob = {
    step: 0, dir: 1,
    age: basics.age || '',
    hood: 'hood' in basics ? basics.hood : null,
    interests: [...(basics.interests || [])],
  };
  const dlg = $('#onboard');
  dlg.classList.remove('is-closing');
  renderOnboarding();
  if (!dlg.open) dlg.showModal();
  $('#ob-title').focus();
}

function obReady() {
  const step = OB_STEPS[ob.step];
  if (step === 'age') return Boolean(ob.age);
  if (step === 'hood') return ob.hood !== null;
  if (step === 'interests') return ob.interests.length > 0;
  return true;
}

function obPick(attr, value, label, pressed, extra = '') {
  return `<button type="button" class="pick pick--ob" data-ob-${attr}="${esc(value)}" aria-pressed="${pressed}">${extra}${esc(label)}</button>`;
}

function renderOnboarding() {
  const step = OB_STEPS[ob.step];
  const last = ob.step === OB_STEPS.length - 1;
  let body = '';

  if (step === 'welcome') {
    body = `<div class="ob__art" aria-hidden="true">${Object.entries(TYPES)
      .map(([k, t], i) => `<span class="bullet bullet--${k}" style="--i:${i}">${t.letter}</span>`).join('')}</div>
      <h2 class="ob__title" id="ob-title" tabindex="-1">There's a lot going on near you</h2>
      <p class="ob__lede">Free study spots, tutoring, museums, volunteering, and paid programs for teens, checked and in one place. Answer three quick questions and we'll line them up for you.</p>`;
  } else if (step === 'age') {
    const ages = []; for (let a = 10; a <= 19; a++) ages.push(obPick('age', String(a), String(a), ob.age === String(a)));
    body = `<h2 class="ob__title" id="ob-title" tabindex="-1">How old are you?</h2>
      <p class="ob__lede">Some programs are only for certain ages. We'll leave out the ones that don't fit.</p>
      <div class="picks picks--ages" role="group" aria-labelledby="ob-title">${ages.join('')}</div>`;
  } else if (step === 'hood') {
    const hoods = [...Object.keys(CONFIG.neighborhoods), ''];
    body = `<h2 class="ob__title" id="ob-title" tabindex="-1">Where do you spend time after school?</h2>
      <p class="ob__lede">Distances start from the middle of the neighborhood, never your exact location.</p>
      <div class="picks picks--rows" role="group" aria-labelledby="ob-title">${hoods.map((h) => obPick('hood', h, h || 'Somewhere else', ob.hood === h)).join('')}</div>`;
  } else {
    body = `<h2 class="ob__title" id="ob-title" tabindex="-1">What are you into?</h2>
      <p class="ob__lede">Pick as many as you like. They go first on your For you page.</p>
      <div class="picks picks--two" role="group" aria-labelledby="ob-title">${Object.entries(TYPES).map(([k, t]) =>
        obPick('into', k, t.plural, ob.interests.includes(k), `<span class="bullet bullet--sm bullet--${k}" aria-hidden="true">${t.letter}</span>`)).join('')}</div>`;
  }

  const label = step === 'welcome' ? 'Get started' : last ? "Show me what's on" : 'Next';
  const progress = ob.step
    ? `<div class="ob__progress" aria-label="Question ${ob.step} of ${OB_STEPS.length - 1}">${OB_STEPS.slice(1).map((_, i) => `<span class="${i < ob.step ? 'is-on' : ''}"></span>`).join('')}</div>`
    : '<span></span>';

  $('#onboard').innerHTML = `<div class="ob">
    <div class="ob__top">
      ${ob.step ? '<button type="button" class="ob__back" data-ob="back">Back</button>' : '<span></span>'}
      ${progress}
      <button type="button" class="ob__skip" data-ob="skip">Skip</button>
    </div>
    <div class="ob__step" style="--from:${ob.dir * 24}px">${body}</div>
    <div class="ob__foot">
      <button type="button" class="btn btn--sun btn--block" data-ob="next"${obReady() ? '' : ' disabled'}>${label}</button>
      ${step === 'welcome' ? '<p class="ob__fine">No account. Your answers stay on this device.</p>' : ''}
    </div>
  </div>`;
}

// Picking an answer updates the buttons in place, so the step doesn't replay its entrance.
function syncObPicks() {
  const dlg = $('#onboard');
  dlg.querySelectorAll('[data-ob-age]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.obAge === ob.age)));
  dlg.querySelectorAll('[data-ob-hood]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.obHood === ob.hood)));
  dlg.querySelectorAll('[data-ob-into]').forEach((b) => b.setAttribute('aria-pressed', String(ob.interests.includes(b.dataset.obInto))));
  $('[data-ob="next"]', dlg).disabled = !obReady();
}

function onboardingClick(e) {
  if (!ob) return;
  const age = e.target.closest('[data-ob-age]');
  if (age) { ob.age = age.dataset.obAge; return syncObPicks(); }
  const hood = e.target.closest('[data-ob-hood]');
  if (hood) { ob.hood = hood.dataset.obHood; return syncObPicks(); }
  const into = e.target.closest('[data-ob-into]');
  if (into) {
    const k = into.dataset.obInto;
    ob.interests = ob.interests.includes(k) ? ob.interests.filter((x) => x !== k) : [...ob.interests, k];
    return syncObPicks();
  }
  const act = e.target.closest('[data-ob]')?.dataset.ob;
  if (act === 'skip') return finishOnboarding(true);
  if (act === 'back') { ob.step--; ob.dir = -1; }
  if (act === 'next') {
    if (!obReady()) return;
    if (ob.step === OB_STEPS.length - 1) return finishOnboarding(false);
    ob.step++; ob.dir = 1;
  }
  if (act === 'back' || act === 'next') { renderOnboarding(); $('#ob-title').focus(); }
}

// Skipping keeps whatever was answered so far.
function finishOnboarding(skipped, instant = false) {
  if (!ob) return;
  const a = ob;
  ob = null;
  basics = { ...basics, done: true };
  if (a.age) basics.age = a.age;
  if (a.hood !== null) basics.hood = a.hood;
  if (a.interests.length) basics.interests = a.interests;
  writeStore('utc-basics', basics);
  state = base();
  $('#q').value = '';
  renderAll();

  const dlg = $('#onboard');
  const done = () => {
    if (dlg.open) dlg.close();
    dlg.classList.remove('is-closing');
    if (skipped) toast('Set up For you any time from the You tab.');
  };
  if (instant || reduceMotion() || !dlg.open) return done();
  dlg.classList.add('is-closing');
  setTimeout(done, 220);
}

/* ---------- You ---------- */

function renderYou() {
  if (!$('#you-age').children.length) {
    const ages = []; for (let a = 10; a <= 19; a++) ages.push(`<button type="button" class="pick" data-you-age="${a}">${a}</button>`);
    $('#you-age').innerHTML = ages.join('');
    $('#you-hood').innerHTML = [...Object.keys(CONFIG.neighborhoods), '']
      .map((h) => `<button type="button" class="pick" data-you-hood="${esc(h)}">${esc(h || 'Somewhere else')}</button>`).join('');
    $('#you-into').innerHTML = Object.entries(TYPES).map(([k, t]) =>
      `<button type="button" class="pick" data-you-into="${k}"><span class="bullet bullet--sm bullet--${k}" aria-hidden="true">${t.letter}</span>${t.plural}</button>`).join('');
  }
  // Update in place so a keyboard user's focus stays on the button they pressed.
  const into = basics.interests || [];
  document.querySelectorAll('[data-you-age]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.youAge === basics.age)));
  document.querySelectorAll('[data-you-hood]').forEach((b) => b.setAttribute('aria-pressed', String('hood' in basics && b.dataset.youHood === basics.hood)));
  document.querySelectorAll('[data-you-into]').forEach((b) => b.setAttribute('aria-pressed', String(into.includes(b.dataset.youInto))));
}

function setBasics(patch) {
  basics = { ...basics, ...patch, done: true };
  writeStore('utc-basics', basics);
  const b = base();
  state = { ...state, age: b.age, hood: b.hood };
  if (!state.hood) state.travel = 'any';
  renderAll();
}

function forgetEverything() {
  if (!window.confirm('Forget your age, neighborhood, interests, and saved listings on this device?')) return;
  for (const k of ['utc-basics', 'utc-saved', 'utc-sample-hidden']) {
    try { localStorage.removeItem(k); } catch { /* nothing stored */ }
  }
  basics = {};
  saved = new Set();
  state = base();
  $('#q').value = '';
  renderAll();
  toast('Forgot everything on this device.');
}

function renderAll() {
  renderBasics();
  syncControls();
  renderExplore();
  renderHome();
  renderYou();
  renderSampleNotes();
  if (currentTab === 'saved') renderSaved();
}

/* ---------- shared lists ---------- */

let sharedIds = [];

function readSharedLink() {
  const p = new URLSearchParams(location.search).get('list');
  if (!p) return;
  sharedIds = [...new Set(p.split(','))].filter((id) => listings.some((l) => l.id === id));
  if (sharedIds.length) showTab('saved');
  else history.replaceState(null, '', location.pathname);
}

function renderShared() {
  $('#shared').hidden = !sharedIds.length;
  if (!sharedIds.length) return;
  const f = { ...DEFAULTS, hood: state.hood };
  const items = sharedIds.map((id) => evaluate(listings.find((l) => l.id === id), f)).filter(Boolean);
  $('#shared-title').textContent = items.length === 1 ? 'A friend shared 1 place' : `A friend shared ${items.length} places`;
  $('#shared-list').innerHTML = items.map(renderCard).join('');
  $('#shared-save').hidden = sharedIds.every((id) => saved.has(id));
}

function closeShared() {
  sharedIds = [];
  history.replaceState(null, '', location.pathname);
  renderShared();
}

// The phone's share sheet when there is one, else the clipboard, else a box to copy from.
async function shareLink(query, text) {
  const url = `${location.origin}${location.pathname}?${query}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Under the City', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Link copied. Paste it to a friend.'); }
  catch { window.prompt('Copy this link and send it to a friend:', url); }
}

function shareSaved() {
  const ids = listings.filter((l) => saved.has(l.id)).map((l) => l.id);
  shareLink(`list=${ids.join(',')}`, ids.length === 1 ? 'A place I found on Under the City' : `${ids.length} places I found on Under the City`);
}

function invite(l) {
  const n = nextSession(l);
  const when = n ? ` ${whenLabel(n, l).replace(/^Today/, 'today').replace(/^Tomorrow/, 'tomorrow')}` : '';
  shareLink(`open=${encodeURIComponent(l.id)}`, `Want to go to ${shortName(l)}${n && !n.live ? when : ''}? It's ${costShort(l).toLowerCase()}.`);
}

let toastTimer = null, toastHide = null;
function toast(msg) {
  const t = $('#toast');
  // An open dialog sits in the top layer, so the toast has to live inside it to be seen.
  const open = [...document.querySelectorAll('dialog[open]')].pop();
  (open || document.body).append(t);
  t.textContent = msg;
  t.classList.remove('is-leaving');
  t.hidden = false;
  clearTimeout(toastTimer);
  clearTimeout(toastHide);
  toastTimer = setTimeout(() => {
    t.classList.add('is-leaving');
    toastHide = setTimeout(() => { t.hidden = true; t.classList.remove('is-leaving'); }, 200);
  }, 3200);
}

/* ---------- add to calendar (.ics) ---------- */

const ICS_DAY = { sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA' };
const CAL_WEEKS = 10;
const pad2 = (n) => String(n).padStart(2, '0');
const icsText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
// Calendar lines longer than 75 bytes must wrap, with a space starting each continuation.
const icsFold = (line) => line.match(/.{1,70}/g).join('\r\n ');

function nextDate(day, endMin) {
  const d = new Date();
  let diff = (DAYS.indexOf(day) - d.getDay() + 7) % 7;
  if (diff === 0 && d.getHours() * 60 + d.getMinutes() >= endMin) diff = 7;
  d.setDate(d.getDate() + diff);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

function downloadCalendar(l) {
  const at = (date, min) => `${date}T${pad2(Math.floor(min / 60))}${pad2(min % 60)}00`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const desc = [l.costText || costLabel(l).text, l.join && `How to join: ${l.join}`, `Source: ${l.sourceUrl}`,
    'Hours can change. Check the source before you go.'].filter(Boolean).join('\n');
  const events = [];
  for (const d of DAYS) {
    for (const [s, e] of l.hours[d] || []) {
      const date = nextDate(d, toMin(e));
      events.push(['BEGIN:VEVENT', `UID:${l.id}-${d}-${s.replace(':', '')}@underthecity`, `DTSTAMP:${stamp}`,
        `DTSTART;TZID=America/New_York:${at(date, toMin(s))}`, `DTEND;TZID=America/New_York:${at(date, toMin(e))}`,
        `RRULE:FREQ=WEEKLY;BYDAY=${ICS_DAY[d]};COUNT=${CAL_WEEKS}`, `SUMMARY:${icsText(l.name)}`,
        `LOCATION:${icsText(l.address)}`, `DESCRIPTION:${icsText(desc)}`, `URL:${l.sourceUrl}`, 'END:VEVENT'].join('\r\n'));
    }
  }
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Under the City//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York',
    'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'END:VTIMEZONE', ...events, 'END:VCALENDAR'].join('\r\n').split('\r\n').map(icsFold).join('\r\n') + '\r\n';

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
  a.download = `${l.id}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Calendar file downloaded. Open it to add the sessions.');
}

function toggleSave(id) {
  saved.has(id) ? saved.delete(id) : saved.add(id);
  writeStore('utc-saved', [...saved]);
  document.querySelectorAll(`[data-save="${id}"]`).forEach((b) => {
    const on = saved.has(id);
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `${ICON_SAVE}${on ? 'Saved' : 'Save'}`;
  });
  renderUpcoming();
  if (currentTab === 'saved') renderSaved();
}

/* ---------- tabs, app bar, and views ---------- */

let currentTab = 'home';
const scrollPos = {};

// Switching tabs is instant, like a phone's tab bar. Each tab keeps its own scroll position.
function showTab(name, restore = false) {
  if (name !== currentTab) scrollPos[currentTab] = window.scrollY;
  currentTab = name;
  document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  if (name === 'home') renderHome();
  if (name === 'saved') renderSaved();
  if (name === 'you') renderYou();
  if (name === 'explore' && map) setTimeout(() => { map.invalidateSize(); if (mapNeedsFit) drawMap(lastResults); }, 0);
  window.scrollTo(0, restore ? scrollPos[name] || 0 : 0);
  observeTitle();
}

// When a tab's big title scrolls away, a small one appears in the bar at the top.
let titleObs = null;
function observeTitle() {
  titleObs?.disconnect();
  const tab = $(`#tab-${currentTab}`);
  $('#appbar-title').textContent = tab.dataset.title;
  titleObs = new IntersectionObserver(([e]) => {
    const on = !e.isIntersecting && e.boundingClientRect.top < 0;
    $('#appbar').classList.toggle('is-on', on);
    $('meta[name="theme-color"]').content = currentTab === 'home' && !on ? '#B933AD' : '#F3EEF7';
  }, { rootMargin: '-56px 0px 0px 0px' });
  titleObs.observe($('.largetitle', tab));
}

const wide = window.matchMedia('(min-width: 960px)');

function setView(v) {
  view = v;
  $('#results').dataset.view = v;
  document.querySelectorAll('.viewtoggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  if (v === 'map' || wide.matches) {
    ensureMap();
    setTimeout(() => { map.invalidateSize(); drawMap(lastResults); }, 0);
  }
}

/* ---------- map ---------- */

let map = null, pins = null, mapNeedsFit = false;

function tiles() {
  return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
}

function bulletIcon(type) {
  return L.divIcon({
    className: 'pin',
    html: `<span class="bullet bullet--${type}">${TYPES[type].letter}</span>`,
    iconSize: [30, 30], iconAnchor: [15, 15],
  });
}

function ensureMap() {
  if (map || typeof L === 'undefined') return;
  map = L.map('map', { scrollWheelZoom: false }).setView(CONFIG.mapCenter, 14);
  tiles().addTo(map);
  pins = L.layerGroup().addTo(map);
}

function drawMap(results) {
  if (!map) return;
  pins.clearLayers();
  const pts = [];
  // Several programs share one building: nudge repeats apart so every pin can be tapped.
  const seen = {};
  for (const r of results) {
    if (r.l.online) continue;
    const key = `${r.l.lat},${r.l.lng}`;
    const n = seen[key] = (seen[key] || 0) + 1;
    const ll = [r.l.lat + (n - 1) * 0.00028, r.l.lng + (n - 1) * 0.00034];
    pts.push(ll);
    L.marker(ll, { icon: bulletIcon(r.l.type), title: r.l.name, alt: r.l.name, keyboard: true })
      .on('click', () => openDetails(r.l.id))
      .addTo(pins);
  }
  if (state.hood) {
    const c = CONFIG.neighborhoods[state.hood];
    pts.push(c);
    L.marker(c, { icon: L.divIcon({ className: '', html: '<span class="pin-origin"></span>', iconSize: [18, 18], iconAnchor: [9, 9] }), title: `Center of ${state.hood}`, interactive: false }).addTo(pins);
  }
  // A map inside a hidden tab has no size yet, so fitting it then would pick the wrong zoom.
  mapNeedsFit = map.getSize().x === 0;
  if (pts.length && !mapNeedsFit) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 });
}

/* ---------- details sheet ---------- */

let miniMap = null;

function scheduleRows(l, highlight) {
  if (!l.hours) return l.whenText ? `<p>${esc(l.whenText)}</p><p class="card__type">Exact times are on the source page.</p>` : `<p class="unknown">${UNKNOWN}</p>`;
  const closed = l.type === 'study' ? 'Closed' : 'No session';
  const rows = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => {
    const iv = l.hours[d];
    const val = iv && iv.length ? iv.map(([s, e]) => fmtRange(toMin(s), toMin(e))).join(', ') : closed;
    return `<tr class="${d === highlight ? 'is-day' : ''}"><th scope="row">${DAY_LONG[d]}</th><td>${val}</td></tr>`;
  }).join('');
  return `<table class="sched"><caption class="vh">Weekly schedule</caption><tbody>${rows}</tbody></table>`;
}

function openDetails(id) {
  const l = listings.find((x) => x.id === id);
  if (!l) return;
  const r = evaluate(l, { ...DEFAULTS, hood: state.hood, day: state.day, from: state.from, to: state.to, keywords: state.keywords })
    || evaluate(l, { ...DEFAULTS, hood: state.hood });
  const t = TYPES[l.type];
  const c = costLabel(l);
  const ch = checkedLabel(l);
  const age = ageLabel(l);
  const isSaved = saved.has(l.id);
  const ap = applyNote(l);
  const contact = [
    l.contact?.phone && `<a href="tel:${esc(l.contact.phone)}">${esc(l.contact.phone)}</a>`,
    l.contact?.email && `<a href="mailto:${esc(l.contact.email)}">${esc(l.contact.email)}</a>`,
    l.contact?.web && `<a href="${esc(l.contact.web)}" target="_blank" rel="noopener">${esc(domain(l.contact.web))}</a>`,
  ].filter(Boolean).join('<br>');
  const report = `mailto:${CONFIG.reportEmail}?subject=${encodeURIComponent(`Problem with listing: ${l.name}`)}&body=${encodeURIComponent(`Listing id: ${l.id}\nWhat's wrong:\n`)}`;

  if (miniMap) { miniMap.remove(); miniMap = null; }
  const dlg = $('#details');
  dlg.innerHTML = `
    <div class="sheet__bar k-${l.type}" id="d-grab">
      <span class="grab" aria-hidden="true"></span>
      <button type="button" class="sheet__close" id="d-close" aria-label="Close">${ICON_X}</button>
    </div>
    <header class="sheet__hero k-${l.type}">
      <div class="sheet__kindrow"><span class="bullet bullet--inv" aria-hidden="true">${t.letter}</span><span class="sheet__kind">${t.label}</span></div>
      <h2 id="d-name">${esc(l.name)}</h2>
      <span class="sheet__cost">${esc(c.cls === 'paid' ? l.costText || c.text : c.text)}</span>
    </header>
    <div class="sheet__body">
      ${r ? `<p class="why">${esc(whyLine(r))}</p>` : ''}
      <dl>
        <dt>Cost</dt><dd>${l.cost == null ? `<span class="unknown">${UNKNOWN}</span>` : esc(l.costText || c.text)}</dd>
        <dt>Ages</dt><dd>${age ? esc(age) : `<span class="unknown">${UNKNOWN}</span>`}</dd>
        <dt>Eligibility</dt><dd>${l.eligibility ? esc(l.eligibility) : `<span class="unknown">${UNKNOWN}</span>`}</dd>
        <dt>How to join</dt><dd>${l.join ? esc(l.join) : `<span class="unknown">${UNKNOWN}</span>`}</dd>
        <dt>Contact</dt><dd>${contact || `<span class="unknown">${UNKNOWN}</span>`}</dd>
        ${ap ? `<dt>Apply</dt><dd>${esc(ap.text)}</dd>` : ''}
        <dt>${l.online ? 'Where' : 'Address'}</dt><dd>${esc(l.address)}${r && r.dist != null ? `<br><span class="card__type">About ${r.dist.toFixed(1)} mi from the center of ${esc(state.hood)}</span>` : ''}</dd>
      </dl>
      <div><h3>Schedule</h3>${scheduleRows(l, r && !r.slot.unknown ? r.slot.day : null)}</div>
      ${l.online ? '' : `<div id="minimap" role="img" aria-label="Map showing ${esc(l.name)}"></div>`}
      <div class="card__actions">
        <button type="button" class="btn btn--quiet save" data-save="${l.id}" aria-pressed="${isSaved}">${ICON_SAVE}${isSaved ? 'Saved' : 'Save'}</button>
        ${l.online ? `<a class="btn btn--primary" href="${esc(l.contact?.web || l.sourceUrl)}" target="_blank" rel="noopener">Open the site</a>`
          : `<a class="btn btn--primary" href="${directionsUrl(l)}" target="_blank" rel="noopener">${ICON_DIR}Directions</a>`}
      </div>
      <div class="sheet__cal">
        <button type="button" class="btn btn--quiet btn--block" id="d-invite">${ICON_SHARE}Invite a friend</button>
        <p class="card__type">Sends a link to this listing. Nothing about you goes with it.</p>
      </div>
      ${l.hours && l.type !== 'study' ? `<div class="sheet__cal">
        <button type="button" class="btn btn--quiet btn--block" id="d-cal">${ICON_CAL}Add to calendar</button>
        <p class="card__type">Adds each weekly session for the next ${CAL_WEEKS} weeks.</p>
      </div>` : ''}
      <div class="sheet__links">
        <p>Source: <a href="${esc(l.sourceUrl)}" target="_blank" rel="noopener">${esc(domain(l.sourceUrl))}</a>, <span class="${ch.cls}">${ch.text}</span></p>
        <p><a href="${report}">Report a problem with this listing</a></p>
      </div>
    </div>`;
  $('#d-close').addEventListener('click', closeSheet);
  $('#d-cal')?.addEventListener('click', () => downloadCalendar(l));
  $('#d-invite').addEventListener('click', () => invite(l));
  dragToDismiss(dlg, $('#d-grab'));
  dlg.classList.remove('is-closing');
  if (!dlg.open) dlg.showModal();
  dlg.scrollTop = 0;
  $('#d-close').focus();

  if (typeof L !== 'undefined' && !l.online) {
    miniMap = L.map('minimap', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false })
      .setView([l.lat, l.lng], 16);
    tiles().addTo(miniMap);
    L.marker([l.lat, l.lng], { icon: bulletIcon(l.type), interactive: false }).addTo(miniMap);
    setTimeout(() => miniMap && miniMap.invalidateSize(), 50);
  }
}

// Pull the colored bar down to close the sheet. A quick flick is enough; a slow pull has to go 120px.
function dragToDismiss(dlg, bar) {
  let id = null, startY = 0, startT = 0, dy = 0;
  bar.addEventListener('pointerdown', (e) => {
    if (wide.matches || id !== null || e.target.closest('button')) return;
    id = e.pointerId; startY = e.clientY; startT = performance.now(); dy = 0;
    bar.setPointerCapture(id);
    dlg.classList.add('is-dragging');
  });
  bar.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    const raw = e.clientY - startY;
    // Pulling up past the top meets more and more resistance instead of a wall.
    dy = raw < 0 ? -Math.sqrt(-raw) * 2 : raw;
    dlg.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    dlg.classList.remove('is-dragging');
    const velocity = dy / (performance.now() - startT);
    if (dy > 120 || (dy > 10 && velocity > 0.11)) return closeSheet();
    dlg.style.transition = 'transform 260ms var(--ease-drawer)';
    dlg.style.transform = '';
    setTimeout(() => { dlg.style.transition = ''; }, 280);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
}

function closeSheet() {
  const dlg = $('#details');
  if (!dlg.open || dlg.classList.contains('is-closing')) return;
  if (reduceMotion()) return dlg.close();
  dlg.style.transition = '';
  dlg.style.transform = '';
  dlg.classList.add('is-closing');
  setTimeout(() => dlg.close(), 240);
}

$('#details').addEventListener('close', (e) => {
  const dlg = e.currentTarget;
  if (miniMap) { miniMap.remove(); miniMap = null; }
  dlg.classList.remove('is-closing', 'is-dragging');
  dlg.style.transition = '';
  dlg.style.transform = '';
  const t = $('#toast');
  if (dlg.contains(t)) document.body.append(t);
});
$('#details').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });

/* ---------- start ---------- */

async function start() {
  try {
    const res = await fetch('data/listings.json');
    listings = await res.json();
  } catch {
    $('#home-title').textContent = 'The directory could not load';
    $('#home-sub').textContent = 'Open the app from a web server, not as a file.';
    return;
  }
  setupControls();
  renderAll();
  readSharedLink();
  const openId = new URLSearchParams(location.search).get('open');
  setView(wide.matches ? 'list' : view);
  wide.addEventListener('change', () => setView(view));
  observeTitle();
  // First visit: run setup, unless a friend's shared list is what brought them here.
  if (openId && listings.some((l) => l.id === openId)) {
    history.replaceState(null, '', location.pathname);
    openDetails(openId);
  } else if (!basics.done && !sharedIds.length) startOnboarding();
}

start();
