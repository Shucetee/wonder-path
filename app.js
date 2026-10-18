/* Wonder Path — app logic. Local-first: everything in localStorage. */
(function () {
'use strict';
const P = window.Projection;
const LS_KEY = 'wonderpath-v1';
const $ = (sel, el = document) => el.querySelector(sel);

const SUBJECTS = {
  Math:    { bg: '#BFD9F2', deep: '#3D74B8', em: '🧮' },
  Reading: { bg: '#F6C9BC', deep: '#C25B3F', em: '📖' },
  Spanish: { bg: '#F7E3A1', deep: '#A8842B', em: '🌎' },
  Science: { bg: '#CBE3C3', deep: '#4C8A4F', em: '🔬' },
  Other:   { bg: '#DED4EE', deep: '#7A5FB0', em: '✨' },
};
const STUDENT_COLORS = ['#E58C7B', '#6FA8DC', '#8FBC8B', '#C9A0DC', '#E8B04C', '#7FB8C9'];
const EVENT_TYPES = {
  fieldtrip:  { em: '🎒', label: 'Field trip' },
  coop:       { em: '👥', label: 'Co-op day' },
  vacation:   { em: '🌴', label: 'Vacation' },
  compliance: { em: '🚩', label: 'Compliance deadline' },
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MILESTONE_MSGS = {
  p25: (s, c) => `🌱 ${s} is 25% through ${c}!`,
  p50: (s, c) => `🌼 Halfway there! ${s} is 50% through ${c}!`,
  p75: (s, c) => `🌟 75% done — ${s} is in the home stretch of ${c}!`,
  p100:(s, c) => `🏆 Congratulations! ${s} finished ${c}!!`,
  r10: (s, c) => `🎉 Only 10 lessons until ${s} finishes ${c}!`,
  r5:  (s, c) => `🎉 Only 5 lessons until ${s} finishes ${c}!`,
  r1:  (s, c) => `🎉 Just 1 lesson left until ${s} finishes ${c}!`,
};

const uid = () => Math.random().toString(36).slice(2, 10);
const todayStr = () => P.fmtDate(new Date());

/* ---------- state ---------- */
let state = null;
let extraShown = {};   // currId -> extra undone lessons revealed today
let openCardId = null; // accordion
let calCursor = null;  // {y, m}
let calSelected = null;
let detailCurrId = null;
let prevTab = 'today';

function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }
function load() {
  try { state = JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { state = null; }
  if (!state || !Array.isArray(state.students)) state = seed(setupFromHash());
  state.curricula.forEach(c => {
    if (!Array.isArray(c.studentIds)) c.studentIds = c.studentId ? [c.studentId] : [];
    delete c.studentId;
  });
  state.events = state.events || [];
  state.milestones = state.milestones || {};
  state.lastProjections = state.lastProjections || {};
  save();
}

// Family names travel in the URL fragment, which browsers never send to the server,
// so the hosted code itself carries no personal data. Two formats:
//   #f=Teacher-Name1.lb-Name2.b-Name3   (short; after the dot: l = Llamitas 1, b = Beast Academy 1A)
//   #setup=<base64url JSON> {"teacher":"...","students":[{"name":"...","curricula":["ba1a","llamitas1"]}]}
const SHORT_CODES = { l: 'llamitas1', b: 'ba1a' };
function setupFromHash() {
  if (location.hash.startsWith('#f=')) {
    const [teacher, ...kids] = decodeURIComponent(location.hash.slice(3)).split('-');
    const students = kids.filter(Boolean).map(k => {
      const [name, codes = ''] = k.split('.');
      return { name, curricula: [...codes].map(c => SHORT_CODES[c]).filter(Boolean) };
    });
    return students.length ? { teacher, students } : null;
  }
  if (!location.hash.startsWith('#setup=')) return null;
  try {
    const b64 = location.hash.slice(7).replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const spec = JSON.parse(json);
    return Array.isArray(spec.students) && spec.students.length ? spec : null;
  } catch (e) { return null; }
}

function seed(spec) {
  spec = spec || { students: [{ name: 'Student 1', curricula: ['ba1a', 'llamitas1'] }] };
  const students = spec.students.map((s, i) => ({ id: uid(), name: String(s.name).slice(0, 40), color: STUDENT_COLORS[i % STUDENT_COLORS.length] }));
  const start = todayStr();
  const DEFAULT_DAYS = { ba1a: [1, 3, 5], llamitas1: [1, 2, 3, 4] };
  const libByKey = Object.fromEntries(CURRICULUM_LIBRARY.map(e => [e.key, e]));
  const fromLibrary = (key, studentIds) => {
    const e = libByKey[key];
    return { id: uid(), studentIds, name: e.name, subject: e.subject,
      lessons: e.lessons.map(title => ({ id: uid(), title, doneDate: null })),
      weekdays: DEFAULT_DAYS[key] || [1, 2, 3, 4, 5], lessonsPerDay: 1, startDate: start, targetDate: null };
  };
  // Students listing the same template share one family-style curriculum.
  const byKey = {};
  spec.students.forEach((s, i) => (s.curricula || []).forEach(key => {
    if (libByKey[key]) (byKey[key] = byKey[key] || []).push(students[i].id);
  }));
  const curricula = Object.entries(byKey).map(([key, ids]) => fromLibrary(key, ids));
  return {
    version: 1,
    students,
    curricula,
    events: [
      { id: uid(), type: 'compliance', title: 'EXAMPLE — Proof of progress due (Virginia) — delete me!', start: '2027-08-01', end: null },
    ],
    milestones: {}, lastProjections: {},
    teacherName: spec.teacher ? String(spec.teacher).slice(0, 40) : '',
    selectedStudentId: students[0].id,
  };
}

/* ---------- derived helpers ---------- */
const subj = c => SUBJECTS[c.subject] || SUBJECTS.Other;
const studentById = id => state.students.find(s => s.id === id);
const currById = id => state.curricula.find(c => c.id === id);
// A curriculum can be shared by several students (family-style): one check-off counts for all of them.
const hasStudent = (c, sid) => c.studentIds.includes(sid);
const namesFor = c => c.studentIds.map(studentById).filter(Boolean).map(s => s.name).join(' & ');
const vacations = () => state.events.filter(e => e.type === 'vacation').map(e => ({ start: e.start, end: e.end || e.start }));

function toPure(c) {
  const completions = {};
  c.lessons.forEach(l => { if (l.doneDate) completions[l.doneDate] = (completions[l.doneDate] || 0) + 1; });
  return { startDate: c.startDate, weekdays: c.weekdays, lessonsPerDay: c.lessonsPerDay, totalLessons: c.lessons.length, completions };
}
function doneCount(c) { return c.lessons.filter(l => l.doneDate).length; }

function projectionInfo(c) {
  const pure = toPure(c);
  const t = todayStr();
  const projected = P.projectFinishDate(pure, t, vacations());
  const prev = state.lastProjections[c.id];
  const note = P.deltaNote(projected, c.targetDate, prev && prev.date !== projected ? prev.date : null);
  if (!prev || prev.asOf !== t) {
    state.lastProjections[c.id] = { date: projected, asOf: t };
    save();
  }
  return { projected, note };
}
function niceDate(s) {
  if (!s) return '—';
  const d = P.parseDate(s);
  return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}, ${d.getFullYear()}`;
}

/* ---------- celebrations ---------- */
function checkMilestones(c) {
  const total = c.lessons.length, done = doneCount(c);
  const remaining = total - done;
  const pct = total ? (done / total) * 100 : 0;
  const shown = state.milestones[c.id] = state.milestones[c.id] || [];
  const fire = [];
  [['p100', pct >= 100], ['p75', pct >= 75 && pct < 100], ['p50', pct >= 50 && pct < 75], ['p25', pct >= 25 && pct < 50]]
    .forEach(([k, hit]) => { if (hit && !shown.includes(k)) fire.push(k); });
  [['r1', remaining === 1], ['r5', remaining === 5], ['r10', remaining === 10]]
    .forEach(([k, hit]) => { if (hit && !shown.includes(k) && pct < 100) fire.push(k); });
  if (!fire.length) return;
  const key = fire[0]; // one at a time, biggest first
  shown.push(...fire);
  save();
  celebrate(MILESTONE_MSGS[key](namesFor(c), c.name));
}

let toastTimer = null;
function celebrate(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 4500);
  const layer = $('#confetti-layer');
  const colors = ['#E8A05C', '#6FA8DC', '#E58C7B', '#8FBC8B', '#C9A0DC', '#F7D154'];
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('div');
    c.className = 'confetto';
    c.style.left = Math.random() * 100 + 'vw';
    c.style.background = colors[i % colors.length];
    c.style.animationDuration = 1.8 + Math.random() * 1.6 + 's';
    c.style.animationDelay = Math.random() * 0.6 + 's';
    if (i % 3 === 0) c.style.borderRadius = '50%';
    layer.appendChild(c);
    setTimeout(() => c.remove(), 4200);
  }
}

/* ---------- tabs ---------- */
function showView(name) {
  ['today', 'curriculum', 'currdetail', 'calendar', 'settings'].forEach(v =>
    $('#view-' + v).classList.toggle('hidden', v !== name));
  document.querySelectorAll('.tab').forEach(t => {
    const tabFor = name === 'currdetail' ? 'curriculum' : name;
    t.classList.toggle('active', t.dataset.tab === tabFor);
  });
  if (name !== 'settings' && name !== 'currdetail') prevTab = name;
}
document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
  showView(t.dataset.tab);
  renderAll();
}));
$('#btn-settings').addEventListener('click', () => { showView('settings'); renderSettings(); });
$('#btn-back-settings').addEventListener('click', () => { showView(prevTab); renderAll(); });
$('#btn-back-curr').addEventListener('click', () => { showView('curriculum'); renderCurriculumList(); });

/* ---------- TODAY ---------- */
function renderToday() {
  const h = new Date().getHours();
  $('#greeting').textContent = (h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening') + (state.teacherName ? ', ' + state.teacherName : '') + ' ☀️';
  const chips = $('#student-chips');
  chips.innerHTML = '';
  if (!state.students.find(s => s.id === state.selectedStudentId)) {
    state.selectedStudentId = state.students[0] && state.students[0].id;
  }
  state.students.forEach(s => {
    const b = document.createElement('button');
    b.className = 'chip' + (s.id === state.selectedStudentId ? ' active' : '');
    b.innerHTML = `<div class="avatar" style="background:${s.color}">${s.name[0]}</div><div class="chip-name">${esc(s.name)}</div>`;
    b.addEventListener('click', () => { state.selectedStudentId = s.id; save(); openCardId = null; renderToday(); });
    chips.appendChild(b);
  });

  const wrap = $('#today-cards');
  wrap.innerHTML = '';
  const t = todayStr();
  const currs = state.curricula.filter(c => hasStudent(c, state.selectedStudentId));
  if (!currs.length) {
    wrap.innerHTML = `<div class="card"><p class="muted">No curriculums yet for this student. Add one on the Curriculum tab 📚</p></div>`;
    return;
  }
  if (openCardId === null || !currs.find(c => c.id === openCardId)) {
    const sched = currs.find(c => P.isScheduledDay(t, toPure(c), vacations()));
    openCardId = (sched || currs[0]).id;
  }
  currs.forEach(c => wrap.appendChild(todayCard(c, t)));
}

function todayCard(c, t) {
  const S = subj(c);
  const open = c.id === openCardId;
  const scheduled = P.isScheduledDay(t, toPure(c), vacations());
  const onVacation = P.isVacation(t, vacations());
  const card = document.createElement('div');
  card.className = 'subject-card card' + (open ? ' open' : '');
  const head = document.createElement('button');
  head.className = 'subject-head';
  head.style.background = S.bg;
  head.innerHTML = `<span class="em">${S.em}</span>${esc(c.name)}<span class="caret">▾</span>`;
  head.addEventListener('click', () => { openCardId = open ? null : c.id; renderToday(); });
  card.appendChild(head);
  if (!open) return card;

  const body = document.createElement('div');
  body.className = 'subject-body';
  const doneTodayList = c.lessons.filter(l => l.doneDate === t);
  const undone = c.lessons.filter(l => !l.doneDate);
  const baseCount = scheduled ? Math.max(c.lessonsPerDay - doneTodayList.length, undone.length ? 1 : 0) : 0;
  const extra = extraShown[c.id] || 0;
  const toShow = doneTodayList.concat(undone.slice(0, baseCount + extra));

  if (!scheduled && !toShow.length) {
    body.innerHTML = `<p class="not-scheduled">${onVacation ? '🌴 Vacation day — no lessons!' : 'No lessons scheduled today.'}</p>`;
    if (undone.length && !onVacation) body.appendChild(extraBtn(c, '＋ Do a lesson anyway'));
  } else {
    if (!scheduled) body.innerHTML = `<p class="not-scheduled">Not scheduled today, but look at you go! ✨</p>`;
    toShow.forEach(l => body.appendChild(lessonRow(c, l, t)));
    if (undone.length > baseCount + extra) body.appendChild(extraBtn(c, '＋ Do one more lesson'));
    if (doneTodayList.length) {
      const enc = document.createElement('p');
      enc.className = 'encourage';
      enc.textContent = doneTodayList.length >= 2 ? `🔥 ${doneTodayList.length} lessons today — amazing pace!` : '✨ Nice work! Keep it up!';
      body.appendChild(enc);
    }
  }

  const done = doneCount(c), total = c.lessons.length;
  const bar = document.createElement('div');
  bar.innerHTML = `<div class="mini-progress"><div style="width:${total ? (done/total*100) : 0}%;background:${S.deep}"></div></div>
    <div class="mini-meta"><span>${done} of ${total}</span><span>${projShort(c)}</span></div>`;
  body.appendChild(bar);
  card.appendChild(body);
  return card;
}
function projShort(c) {
  const { projected } = projectionInfo(c);
  return projected ? `finish ~ ${niceDate(projected)}` : 'Finished! 🎉';
}
function extraBtn(c, label) {
  const b = document.createElement('button');
  b.className = 'extra-btn';
  b.textContent = label;
  b.addEventListener('click', () => { extraShown[c.id] = (extraShown[c.id] || 0) + 1; renderToday(); });
  return b;
}
function lessonRow(c, l, t) {
  const row = document.createElement('div');
  row.className = 'lesson-row' + (l.doneDate ? ' done' : '');
  const chk = document.createElement('button');
  chk.className = 'lesson-check' + (l.doneDate ? ' done' : '');
  chk.innerHTML = l.doneDate ? '✓' : '';
  chk.setAttribute('aria-label', (l.doneDate ? 'Uncheck ' : 'Check off ') + l.title);
  chk.addEventListener('click', () => {
    l.doneDate = l.doneDate ? null : t;
    save();
    if (l.doneDate) checkMilestones(c);
    renderToday();
  });
  const title = document.createElement('div');
  title.className = 'lesson-title';
  const idx = c.lessons.indexOf(l) + 1;
  title.innerHTML = `${esc(l.title)}<span class="sub">Lesson ${idx} of ${c.lessons.length}</span>`;
  row.appendChild(chk); row.appendChild(title);
  return row;
}

/* ---------- CURRICULUM LIST ---------- */
function renderCurriculumList() {
  const wrap = $('#curriculum-list');
  wrap.innerHTML = '';
  state.students.forEach(s => {
    const currs = state.curricula.filter(c => hasStudent(c, s.id));
    const h = document.createElement('div');
    h.className = 'student-group-title';
    h.innerHTML = `<span class="dot" style="background:${s.color}"></span>${esc(s.name)}`;
    wrap.appendChild(h);
    if (!currs.length) {
      const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No curriculums yet.';
      wrap.appendChild(p);
    }
    currs.forEach(c => {
      const S = subj(c);
      const done = doneCount(c), total = c.lessons.length;
      const b = document.createElement('button');
      b.className = 'curr-item';
      b.innerHTML = `<div class="curr-swatch" style="background:${S.bg}">${S.em}</div>
        <div><div class="t">${esc(c.name)}</div><div class="s">${c.subject} · ${done} of ${total} lessons</div></div>
        <div class="pct" style="color:${S.deep}">${total ? Math.round(done/total*100) : 0}%</div>`;
      b.addEventListener('click', () => { detailCurrId = c.id; showView('currdetail'); renderCurrDetail(); });
      wrap.appendChild(b);
    });
  });
}

/* ---------- CURRICULUM DETAIL ---------- */
function renderCurrDetail() {
  const c = currById(detailCurrId);
  const wrap = $('#currdetail-body');
  if (!c) { wrap.innerHTML = '<p class="muted">Curriculum not found.</p>'; return; }
  const S = subj(c);
  const done = doneCount(c), total = c.lessons.length;
  const pct = total ? done / total : 0;
  const { projected, note } = projectionInfo(c);
  const R = 52, CIRC = 2 * Math.PI * R;

  wrap.innerHTML = `
    <h1 class="detail-title">${esc(c.name)}</h1>
    <p class="detail-sub">${S.em} ${c.subject} · ${esc(namesFor(c))} · ${c.weekdays.map(d => DOW[d]).join(' ')} · ${c.lessonsPerDay}/day</p>
    <div class="card ring-wrap">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r="${R}" fill="none" stroke="#EFE9DB" stroke-width="12"/>
        <circle cx="70" cy="70" r="${R}" fill="none" stroke="${S.deep}" stroke-width="12"
          stroke-linecap="round" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC * (1 - pct)}"
          transform="rotate(-90 70 70)"/>
        <text x="70" y="78" text-anchor="middle" font-size="26" font-weight="bold" fill="#3E3A33" font-family="Georgia">${Math.round(pct * 100)}%</text>
      </svg>
      <div class="ring-sub">${done} of ${total} lessons</div>
    </div>
    <div class="card">
      <div class="proj-line">📅 <span>Projected finish: <span class="big">${projected ? niceDate(projected) : 'Done!'}</span></span></div>
      <div class="proj-line" style="margin-top:6px">🍃 <span class="tone-${note.tone}">${note.text}</span></div>
      ${c.targetDate ? `<div class="proj-line" style="margin-top:6px">🎯 <span class="muted">Target: ${niceDate(c.targetDate)}</span></div>` : ''}
      <div class="proj-line" style="margin-top:6px">🚀 <span class="muted">Started ${niceDate(c.startDate)}</span></div>
    </div>
    <div class="card">
      <div class="chart-title">Lessons per week</div>
      ${weekChart(c, S.deep)}
    </div>
    <div class="card">
      <h3 style="margin-bottom:8px">Lessons</h3>
      <div class="lesson-list-detail" id="detail-lessons"></div>
    </div>
    <div class="row-gap" style="margin-bottom:20px">
      <button class="small-btn" id="btn-edit-curr">✏️ Edit</button>
      <button class="small-btn danger" id="btn-del-curr">🗑 Delete</button>
    </div>`;

  const list = $('#detail-lessons');
  const t = todayStr();
  c.lessons.forEach(l => list.appendChild(lessonRow(c, l, t)));
  // re-render detail (not today) on checks inside detail
  list.querySelectorAll('.lesson-check').forEach(chk =>
    chk.addEventListener('click', () => renderCurrDetail()));
  $('#btn-edit-curr').addEventListener('click', () => openCurrModal(c));
  $('#btn-del-curr').addEventListener('click', () => {
    if (confirm(`Delete "${c.name}" and its progress?`)) {
      state.curricula = state.curricula.filter(x => x.id !== c.id);
      delete state.milestones[c.id]; delete state.lastProjections[c.id];
      save(); showView('curriculum'); renderCurriculumList();
    }
  });
}

function weekChart(c, color) {
  // lessons completed per week, last 8 weeks (Mon-start)
  const now = new Date();
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weeks = [];
  for (let i = 7; i >= 0; i--) {
    const start = new Date(monday); start.setDate(monday.getDate() - i * 7);
    const s = P.fmtDate(start), e = P.addDays(s, 6);
    const count = c.lessons.filter(l => l.doneDate && l.doneDate >= s && l.doneDate <= e).length;
    weeks.push({ label: `${start.getMonth() + 1}/${start.getDate()}`, count });
  }
  const max = Math.max(4, ...weeks.map(w => w.count));
  const W = 320, H = 120, pad = 8, bw = (W - pad * 2) / weeks.length;
  let bars = '';
  weeks.forEach((w, i) => {
    const bh = (w.count / max) * (H - 36);
    const x = pad + i * bw;
    bars += `<rect x="${x + 4}" y="${H - 24 - bh}" width="${bw - 8}" height="${Math.max(bh, 2)}" rx="4" fill="${w.count ? color : '#EFE9DB'}"/>`;
    bars += `<text x="${x + bw / 2}" y="${H - 10}" text-anchor="middle" font-size="9" fill="#9B937F">${w.label}</text>`;
    if (w.count) bars += `<text x="${x + bw / 2}" y="${H - 29 - bh}" text-anchor="middle" font-size="10" fill="#3E3A33">${w.count}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%">${bars}</svg>`;
}

/* ---------- CALENDAR ---------- */
function renderCalendar() {
  if (!calCursor) { const n = new Date(); calCursor = { y: n.getFullYear(), m: n.getMonth() }; }
  $('#cal-month').textContent = `${MONTHS[calCursor.m]} ${calCursor.y}`;
  const grid = $('#cal-grid');
  grid.innerHTML = DOW.map(d => `<div class="cal-dow">${d}</div>`).join('');
  const first = new Date(calCursor.y, calCursor.m, 1);
  const startOffset = first.getDay();
  const t = todayStr();
  const vacs = vacations();
  for (let i = 0; i < 42; i++) {
    const d = new Date(calCursor.y, calCursor.m, 1 + i - startOffset);
    const ds = P.fmtDate(d);
    const cell = document.createElement('button');
    cell.className = 'cal-cell';
    if (d.getMonth() !== calCursor.m) cell.classList.add('other-month');
    if (ds === t) cell.classList.add('today');
    if (ds === calSelected) cell.classList.add('selected');
    if (P.isVacation(ds, vacs)) cell.classList.add('vacation');
    let html = `${d.getDate()}`;
    if (state.events.some(e => e.type === 'compliance' && e.start === ds)) html += `<span class="cal-flag">🚩</span>`;
    const dots = [];
    state.curricula.forEach(c => {
      if (P.isScheduledDay(ds, toPure(c), vacs)) dots.push(subj(c).deep);
    });
    state.events.forEach(e => {
      if (e.type !== 'vacation' && e.type !== 'compliance' && ds >= e.start && ds <= (e.end || e.start)) dots.push('#7A5FB0');
    });
    html += `<div class="cal-dots">${dots.slice(0, 4).map(col => `<span class="cal-dot" style="background:${col}"></span>`).join('')}</div>`;
    cell.innerHTML = html;
    cell.addEventListener('click', () => { calSelected = ds; renderCalendar(); });
    grid.appendChild(cell);
  }
  renderDayList();
}

function renderDayList() {
  const wrap = $('#cal-daylist');
  wrap.innerHTML = '';
  if (!calSelected) { wrap.innerHTML = `<p class="muted center">Tap a day to see what's on.</p>`; return; }
  const h = document.createElement('h3');
  h.style.cssText = 'font-family:Georgia,serif;margin:4px 0 10px';
  h.textContent = niceDate(calSelected);
  wrap.appendChild(h);
  const vacs = vacations();
  let any = false;
  state.events.filter(e => calSelected >= e.start && calSelected <= (e.end || e.start)).forEach(e => {
    any = true;
    const ET = EVENT_TYPES[e.type] || EVENT_TYPES.fieldtrip;
    const row = document.createElement('div');
    row.className = 'event-row' + (e.type === 'compliance' ? ' event-compliance' : '');
    row.innerHTML = `<span class="em">${ET.em}</span>
      <div><div class="t">${esc(e.title || ET.label)}</div>
      <div class="s">${ET.label}${e.end && e.end !== e.start ? ` · ${niceDate(e.start)} – ${niceDate(e.end)}` : ''}</div></div>
      <button class="del" aria-label="Delete event">🗑</button>`;
    row.querySelector('.del').addEventListener('click', () => {
      if (confirm(`Delete "${e.title || ET.label}"?`)) {
        state.events = state.events.filter(x => x.id !== e.id);
        save(); renderCalendar();
      }
    });
    wrap.appendChild(row);
  });
  state.curricula.forEach(c => {
    if (P.isScheduledDay(calSelected, toPure(c), vacs)) {
      any = true;
      const S = subj(c);
      const row = document.createElement('div');
      row.className = 'event-row';
      row.innerHTML = `<span class="em">${S.em}</span>
        <div><div class="t">${esc(c.name)}</div><div class="s">${esc(namesFor(c))} · ${c.lessonsPerDay} lesson${c.lessonsPerDay > 1 ? 's' : ''}</div></div>`;
      wrap.appendChild(row);
    }
  });
  if (!any) wrap.innerHTML += `<p class="muted">Nothing scheduled.</p>`;
}

$('#cal-prev').addEventListener('click', () => { calCursor.m--; if (calCursor.m < 0) { calCursor.m = 11; calCursor.y--; } renderCalendar(); });
$('#cal-next').addEventListener('click', () => { calCursor.m++; if (calCursor.m > 11) { calCursor.m = 0; calCursor.y++; } renderCalendar(); });
$('#btn-add-event').addEventListener('click', () => openEventModal(calSelected || todayStr()));

/* ---------- SETTINGS ---------- */
function renderSettings() {
  const wrap = $('#settings-students');
  wrap.innerHTML = '';
  state.students.forEach(s => {
    const row = document.createElement('div');
    row.className = 'settings-student-row';
    row.innerHTML = `<div class="avatar-sm" style="background:${s.color}">${s.name[0]}</div>
      <div class="nm">${esc(s.name)}</div>
      <button class="small-btn ed">✏️</button><button class="small-btn danger de">🗑</button>`;
    row.querySelector('.ed').addEventListener('click', () => openStudentModal(s));
    row.querySelector('.de').addEventListener('click', () => {
      const n = state.curricula.filter(c => hasStudent(c, s.id) && c.studentIds.length === 1).length;
      if (confirm(`Delete ${s.name}${n ? ` and ${n} curriculum(s)` : ''}?`)) {
        state.students = state.students.filter(x => x.id !== s.id);
        state.curricula.forEach(c => { c.studentIds = c.studentIds.filter(id => id !== s.id); });
        state.curricula = state.curricula.filter(c => c.studentIds.length);
        save(); renderSettings();
      }
    });
    wrap.appendChild(row);
  });
}
$('#btn-add-student').addEventListener('click', () => openStudentModal(null));
$('#btn-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `wonderpath-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!Array.isArray(data.students) || !Array.isArray(data.curricula)) throw new Error('bad shape');
      if (!confirm('Replace everything with this backup?')) return;
      state = data; save(); load(); renderAll(); renderSettings();
      celebrate('✅ Backup restored!');
    } catch (err) { alert("That file doesn't look like a Wonder Path backup."); }
  };
  r.readAsText(f);
  e.target.value = '';
});

/* ---------- MODALS ---------- */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-backdrop').classList.remove('hidden');
}
function closeModal() { $('#modal-backdrop').classList.add('hidden'); }
$('#modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(); });

function openStudentModal(s) {
  const color = s ? s.color : STUDENT_COLORS[state.students.length % STUDENT_COLORS.length];
  openModal(`
    <h2>${s ? 'Edit' : 'Add'} student</h2>
    <div class="field"><label>Name</label><input type="text" id="m-name" value="${s ? esc(s.name) : ''}" placeholder="Name"></div>
    <div class="field"><label>Color</label><div class="color-picker" id="m-colors">
      ${STUDENT_COLORS.map(c => `<button data-c="${c}" style="background:${c}" class="${c === color ? 'on' : ''}"></button>`).join('')}
    </div></div>
    <div class="modal-actions">
      <button class="small-btn" id="m-cancel">Cancel</button>
      <button class="big-btn" id="m-save">Save</button>
    </div>`);
  let picked = color;
  $('#m-colors').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    picked = b.dataset.c;
    $('#m-colors').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  }));
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', () => {
    const name = $('#m-name').value.trim();
    if (!name) return alert('Please enter a name.');
    if (s) { s.name = name; s.color = picked; }
    else state.students.push({ id: uid(), name, color: picked });
    save(); closeModal(); renderSettings(); renderToday();
  });
}

$('#btn-add-curr').addEventListener('click', () => openCurrModal(null));

function openCurrModal(c) {
  const namedDefault = c ? c.lessons.map(l => l.title).join('\n') : '';
  openModal(`
    <h2>${c ? 'Edit' : 'Add'} curriculum</h2>
    ${c ? '' : `<div class="field"><label>📚 Find in library</label>
      <input type="search" id="m-lib" list="m-lib-list" placeholder="Start typing, e.g. Good and Beautiful" autocomplete="off">
      <datalist id="m-lib-list">${CURRICULUM_LIBRARY.map(e => `<option value="${esc(e.name)}">${esc(e.publisher)} · ${e.lessons.length} lessons</option>`).join('')}</datalist>
      <p class="muted" id="m-lib-note">Not listed? Type the lessons below, or ask Dominus to add it to the library.</p></div>`}
    <div class="field"><label>Students <span class="muted">(pick more than one for family-style)</span></label><div class="weekday-picker" id="m-students">
      ${state.students.map(s => `<button data-sid="${s.id}" class="${(c ? hasStudent(c, s.id) : s.id === state.selectedStudentId) ? 'on' : ''}">${esc(s.name)}</button>`).join('')}
    </div></div>
    <div class="field"><label>Curriculum name</label><input type="text" id="m-cname" value="${c ? esc(c.name) : ''}" placeholder="e.g. Beast Academy 1B"></div>
    <div class="field"><label>Subject (sets the color)</label><select id="m-subject">
      ${Object.keys(SUBJECTS).map(k => `<option ${c && c.subject === k ? 'selected' : ''}>${k}</option>`).join('')}
    </select></div>
    <div class="field"><label>Lessons — either a total count…</label>
      <input type="number" id="m-total" min="1" placeholder="e.g. 61" value="${c && !namedDefault ? c.lessons.length : ''}"></div>
    <div class="field"><label>…or named lessons (one per line, wins if filled)</label>
      <textarea id="m-named" placeholder="Unit 1 · Lesson 1&#10;Unit 1 · Lesson 2">${esc(namedDefault)}</textarea></div>
    <div class="field"><label>School days</label><div class="weekday-picker" id="m-days">
      ${DOW.map((d, i) => `<button data-d="${i}" class="${c && c.weekdays.includes(i) ? 'on' : (!c && [1,2,3,4,5].includes(i) ? 'on' : '')}">${d}</button>`).join('')}
    </div></div>
    <div class="field"><label>Lessons per day</label><input type="number" id="m-lpd" min="1" value="${c ? c.lessonsPerDay : 1}"></div>
    <div class="field"><label>Start date</label><input type="date" id="m-start" value="${c ? c.startDate : todayStr()}"></div>
    <div class="field"><label>Target finish date (optional)</label><input type="date" id="m-target" value="${c && c.targetDate ? c.targetDate : ''}"></div>
    <div class="modal-actions">
      <button class="small-btn" id="m-cancel">Cancel</button>
      <button class="big-btn" id="m-save">Save</button>
    </div>`);
  $('#m-days').querySelectorAll('button').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  $('#m-students').querySelectorAll('button').forEach(b => b.addEventListener('click', () => b.classList.toggle('on')));
  if (!c) $('#m-lib').addEventListener('input', () => {
    const e = CURRICULUM_LIBRARY.find(x => x.name.toLowerCase() === $('#m-lib').value.trim().toLowerCase());
    if (!e) return;
    $('#m-cname').value = e.name;
    $('#m-subject').value = SUBJECTS[e.subject] ? e.subject : 'Other';
    $('#m-named').value = e.lessons.join('\n');
    $('#m-total').value = '';
    $('#m-lib-note').textContent = `✓ Loaded all ${e.lessons.length} lessons from ${e.publisher}`;
  });
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', () => {
    const name = $('#m-cname').value.trim();
    if (!name) return alert('Please enter a curriculum name.');
    const weekdays = [...$('#m-days').querySelectorAll('button.on')].map(b => Number(b.dataset.d));
    if (!weekdays.length) return alert('Pick at least one school day.');
    const studentIds = [...$('#m-students').querySelectorAll('button.on')].map(b => b.dataset.sid);
    if (!studentIds.length) return alert('Pick at least one student.');
    const namedRaw = $('#m-named').value.split('\n').map(x => x.trim()).filter(Boolean);
    const total = Number($('#m-total').value);
    if (!namedRaw.length && (!total || total < 1)) return alert('Enter a lesson count or named lessons.');
    const titles = namedRaw.length ? namedRaw : Array.from({ length: total }, (_, i) => `Lesson ${i + 1}`);
    const old = c ? c.lessons : [];
    const lessons = titles.map((title, i) => ({
      id: old[i] ? old[i].id : uid(),
      title,
      doneDate: old[i] ? old[i].doneDate : null,
    }));
    const data = {
      studentIds,
      name,
      subject: $('#m-subject').value,
      lessons, weekdays,
      lessonsPerDay: Math.max(1, Number($('#m-lpd').value) || 1),
      startDate: $('#m-start').value || todayStr(),
      targetDate: $('#m-target').value || null,
    };
    if (c) Object.assign(c, data);
    else state.curricula.push(Object.assign({ id: uid() }, data));
    save(); closeModal();
    renderCurriculumList();
    if (detailCurrId && !$('#view-currdetail').classList.contains('hidden')) renderCurrDetail();
    renderToday();
  });
}

function openEventModal(dateStr) {
  openModal(`
    <h2>Add event</h2>
    <div class="field"><label>Type</label><select id="m-etype">
      ${Object.entries(EVENT_TYPES).map(([k, v]) => `<option value="${k}">${v.em} ${v.label}</option>`).join('')}
    </select></div>
    <div class="field"><label>Title</label><input type="text" id="m-etitle" placeholder="e.g. Aquarium trip"></div>
    <div class="field"><label>Date</label><input type="date" id="m-estart" value="${dateStr}"></div>
    <div class="field" id="m-eend-wrap" style="display:none"><label>Last day (for ranges)</label><input type="date" id="m-eend"></div>
    <div class="modal-actions">
      <button class="small-btn" id="m-cancel">Cancel</button>
      <button class="big-btn" id="m-save">Save</button>
    </div>`);
  const typeSel = $('#m-etype');
  const toggleEnd = () => { $('#m-eend-wrap').style.display = typeSel.value === 'vacation' ? '' : 'none'; };
  typeSel.addEventListener('change', toggleEnd); toggleEnd();
  $('#m-cancel').addEventListener('click', closeModal);
  $('#m-save').addEventListener('click', () => {
    const start = $('#m-estart').value;
    if (!start) return alert('Pick a date.');
    let end = typeSel.value === 'vacation' ? ($('#m-eend').value || start) : null;
    if (end && end < start) { const t2 = end; end = start; $('#m-estart').value = t2; }
    state.events.push({
      id: uid(), type: typeSel.value,
      title: $('#m-etitle').value.trim() || EVENT_TYPES[typeSel.value].label,
      start, end,
    });
    save(); closeModal(); calSelected = start;
    const d = P.parseDate(start); calCursor = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  });
}

/* ---------- utils & boot ---------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function renderAll() {
  if (!$('#view-today').classList.contains('hidden')) renderToday();
  if (!$('#view-curriculum').classList.contains('hidden')) renderCurriculumList();
  if (!$('#view-calendar').classList.contains('hidden')) renderCalendar();
}

load();
renderToday();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
})();
