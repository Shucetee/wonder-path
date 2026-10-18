/* Wonder Path — projection engine (pure functions, no DOM).
   Dates are 'YYYY-MM-DD' strings, interpreted in local time.
   A curriculum shape for these functions:
   { startDate, weekdays: [0-6], lessonsPerDay, totalLessons, completions: { 'YYYY-MM-DD': count } }
   vacations: [ { start: 'YYYY-MM-DD', end: 'YYYY-MM-DD' } ]
*/

function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(dateStr, n) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}
function daysBetween(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / 86400000);
}
function isVacation(dateStr, vacations) {
  return (vacations || []).some(v => dateStr >= v.start && dateStr <= v.end);
}
function isScheduledDay(dateStr, curr, vacations) {
  if (dateStr < curr.startDate) return false;
  if (!curr.weekdays.includes(parseDate(dateStr).getDay())) return false;
  return !isVacation(dateStr, vacations);
}
function completedCount(curr) {
  return Object.values(curr.completions || {}).reduce((a, b) => a + b, 0);
}

/* Trailing pace: lessons completed per scheduled school day over the last
   `windowDays` scheduled days before today. Today counts as a history day only
   if lessons were already completed on it (so an unchecked morning doesn't
   read as "behind"). Falls back to planned lessonsPerDay with fewer than
   minHistory scheduled days, or if pace is 0 (nothing done — the remaining
   count already pushes the date later). */
function computePace(curr, todayStr, vacations, windowDays = 14, minHistory = 3) {
  const comps = curr.completions || {};
  const history = [];
  let cursor = todayStr;
  if (!(comps[todayStr] > 0)) cursor = addDays(todayStr, -1);
  let guard = 0;
  while (history.length < windowDays && cursor >= curr.startDate && guard < 400) {
    if (isScheduledDay(cursor, curr, vacations)) history.push(comps[cursor] || 0);
    cursor = addDays(cursor, -1);
    guard++;
  }
  if (history.length < minHistory) return { pace: curr.lessonsPerDay, source: 'planned' };
  const done = history.reduce((a, b) => a + b, 0);
  const pace = done / history.length;
  if (pace <= 0) return { pace: curr.lessonsPerDay, source: 'planned' };
  return { pace, source: 'actual' };
}

/* Walk forward through future scheduled days (skipping vacations), consuming
   remaining lessons at `pace` per day. Returns 'YYYY-MM-DD' or null when the
   curriculum is already finished. Today counts as a working day if scheduled
   and not all of today's share is done yet. */
function projectFinishDate(curr, todayStr, vacations) {
  const remaining = curr.totalLessons - completedCount(curr);
  if (remaining <= 0) return null;
  const { pace } = computePace(curr, todayStr, vacations);
  let consumed = 0;
  let day = todayStr;
  const doneToday = (curr.completions || {})[todayStr] || 0;
  let guard = 0;
  while (guard < 3000) {
    if (isScheduledDay(day, curr, vacations)) {
      if (day === todayStr) {
        // credit only what's still plausibly left to do today
        consumed += Math.max(0, pace - doneToday);
      } else {
        consumed += pace;
      }
      if (consumed >= remaining - 1e-9) return day;
    }
    day = addDays(day, 1);
    guard++;
  }
  return null; // unschedulable (e.g. no weekdays selected)
}

/* Human delta note. Compares projection to target date when set, otherwise to
   a previously stored projection. Returns {text, tone: 'good'|'ok'|'warn'} */
function deltaNote(projected, targetDate, previousProjection) {
  if (!projected) return { text: 'Finished! 🎉', tone: 'good' };
  if (targetDate) {
    const diff = daysBetween(projected, targetDate); // + = ahead of target
    if (diff === 0) return { text: 'right on target', tone: 'good' };
    if (diff > 0) return { text: `${diff} day${diff === 1 ? '' : 's'} ahead of target`, tone: 'good' };
    return { text: `${-diff} day${diff === -1 ? '' : 's'} behind target`, tone: 'warn' };
  }
  if (previousProjection && previousProjection !== projected) {
    const diff = daysBetween(projected, previousProjection); // + = moved earlier
    if (diff > 0) return { text: `${diff} day${diff === 1 ? '' : 's'} earlier than before`, tone: 'good' };
    return { text: `${-diff} day${diff === -1 ? '' : 's'} later than before`, tone: 'warn' };
  }
  return { text: 'on pace', tone: 'ok' };
}

const Projection = {
  parseDate, fmtDate, addDays, daysBetween,
  isVacation, isScheduledDay, completedCount,
  computePace, projectFinishDate, deltaNote,
};

if (typeof module !== 'undefined' && module.exports) module.exports = Projection;
if (typeof window !== 'undefined') window.Projection = Projection;
