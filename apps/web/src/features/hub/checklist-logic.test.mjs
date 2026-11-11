// Checklist template: the due/late rules are plain functions between "// LOGIC START" and "// LOGIC END" in the page's script.
// They are cut out of the page and run in node:vm (no DOM, no SDK), for both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const server = new URL('../../../../../crates/server/src/hub/apps/templates/', import.meta.url);
const NAMES = ['createdDay', 'clockOf', 'ymdAdd', 'ymdWeekday', 'weekStartOf', 'windowFor', 'periodFor', 'isDue', 'isLate', 'nextDue', 'groupToday', 'openRunOf', 'missingRequired', 'runProgress', 'shouldNotify'];

function loadLogic(file) {
  const html = readFileSync(new URL(file, server), 'utf8');
  const start = html.indexOf('// LOGIC START'), end = html.indexOf('// LOGIC END');
  assert.ok(start > 0 && end > start, `${file}: LOGIC markers`);
  const block = html.slice(start, end);
  assert.ok(!/document\.|window\.|tendly\.|tkit\./.test(block), `${file}: the block touches no DOM, SDK or kit`);
  return vm.runInNewContext(`${block}\n({ ${NAMES.join(', ')} })`, { Date, Math, String });
}

const A = loadLogic('checklist.html'), B = loadLogic('pt-BR/checklist.html');
test('the LOGIC block is identical in both languages', () => {
  const cut = file => { const h = readFileSync(new URL(file, server), 'utf8'); return h.slice(h.indexOf('// LOGIC START'), h.indexOf('// LOGIC END')); };
  assert.equal(cut('checklist.html'), cut('pt-BR/checklist.html'));
});

const L = A;
const at = (date, time = '12:00') => ({ date, time });
const daily = (extra = {}) => ({ id: 'd', frequency: { kind: 'daily' }, ...extra });
const weekly = (weekdays, extra = {}) => ({ id: 'w', frequency: { kind: 'weekly', weekdays }, ...extra });
const monthly = (day, extra = {}) => ({ id: 'm', frequency: { kind: 'monthly', day }, ...extra });
const once = (date, extra = {}) => ({ id: 'o', frequency: { kind: 'once', date }, ...extra });
const manual = { id: 'x', frequency: { kind: 'manual' } };
const run = (routine, period, status = 'done', extra = {}) => ({ routineId: routine.id, period, status, ...extra });

test('date helpers: weekday, adding days across month and year ends, leap years', () => {
  assert.equal(L.ymdWeekday('2026-11-11'), 3);   // Wednesday
  assert.equal(L.ymdAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(L.ymdAdd('2027-01-01', -1), '2026-12-31');
  assert.equal(L.ymdAdd('2028-02-28', 1), '2028-02-29');
  assert.equal(L.ymdAdd('2027-02-28', 1), '2027-03-01');
  assert.deepEqual({ ...L.clockOf(new Date(2026, 10, 5, 9, 7)) }, { date: '2026-11-05', time: '09:07' });
  assert.deepEqual({ ...L.clockOf({ date: '2026-01-02' }) }, { date: '2026-01-02', time: '00:00' });
});

test('week start: Sunday vs Monday, including a Sunday and the year boundary', () => {
  assert.equal(L.weekStartOf('2026-11-11', 1), '2026-11-09');   // Wed -> Monday
  assert.equal(L.weekStartOf('2026-11-11', 0), '2026-11-08');   // Wed -> Sunday
  assert.equal(L.weekStartOf('2026-11-08', 1), '2026-11-02');   // a Sunday belongs to the Monday-week before
  assert.equal(L.weekStartOf('2026-11-08', 0), '2026-11-08');   // ...but starts the Sunday-week
  assert.equal(L.weekStartOf('2026-11-09', 1), '2026-11-09');
  assert.equal(L.weekStartOf('2027-01-01', 1), '2026-12-28');   // Friday Jan 1 2027
  assert.equal(L.weekStartOf('2027-01-01', 0), '2026-12-27');
});

test('periodFor: daily, weekly (either week start), monthly, once, manual', () => {
  assert.equal(L.periodFor(daily(), '2026-11-11', 0), '2026-11-11');
  assert.equal(L.periodFor(weekly([1, 4]), '2026-11-09', 1), '2026-11-09', 'a chosen weekday is its own period');
  assert.equal(L.periodFor(weekly([1, 4]), '2026-11-12', 0), '2026-11-12');
  assert.equal(L.periodFor(weekly([1, 4]), '2026-11-11', 1), null, 'no period on an unchosen day');
  assert.equal(L.periodFor(weekly([1, 4]), '2026-11-08', 0), null);
  assert.equal(L.periodFor(monthly(15), '2026-11-30', 0), '2026-11-01');
  assert.equal(L.periodFor(monthly(15), '2027-01-01', 0), '2027-01-01');
  assert.equal(L.periodFor(once('2026-12-25'), '2026-11-11', 0), '2026-12-25');
  assert.equal(L.periodFor(once(null), '2026-11-11', 0), null);
  assert.equal(L.periodFor(manual, '2026-11-11', 0), '2026-11-11');
});

test('daily: due until a done or skipped run exists; an open run does not count', () => {
  const r = daily({ dueTime: '09:00' });
  assert.equal(L.isDue(r, [], at('2026-11-11'), 0), true);
  assert.equal(L.isDue(r, [run(r, '2026-11-11', 'open')], at('2026-11-11'), 0), true);
  assert.equal(L.isDue(r, [run(r, '2026-11-11', 'done')], at('2026-11-11'), 0), false);
  assert.equal(L.isDue(r, [run(r, '2026-11-11', 'skipped')], at('2026-11-11'), 0), false);
  assert.equal(L.isDue(r, [run(r, '2026-11-10', 'done')], at('2026-11-11'), 0), true, 'yesterday does not count');
  assert.equal(L.isDue(r, [run({ id: 'other' }, '2026-11-11', 'done')], at('2026-11-11'), 0), true, 'another routine does not count');
  assert.equal(L.isDue({ ...r, active: false }, [], at('2026-11-11'), 0), false);
});

test('late: dueTime passed or not, exactly on the time, and no dueTime', () => {
  const r = daily({ dueTime: '09:00' });
  assert.equal(L.isLate(r, [], at('2026-11-11', '08:59'), 0), false);
  assert.equal(L.isLate(r, [], at('2026-11-11', '09:00'), 0), false, 'on the minute is not late yet');
  assert.equal(L.isLate(r, [], at('2026-11-11', '09:01'), 0), true);
  assert.equal(L.isLate(r, [run(r, '2026-11-11')], at('2026-11-11', '23:00'), 0), false, 'done is never late');
  assert.equal(L.isLate(r, [run(r, '2026-11-11', 'skipped')], at('2026-11-11', '23:00'), 0), false);
  assert.equal(L.isLate(daily(), [], at('2026-11-11', '23:59'), 0), false, 'no dueTime: never late on its own day');
  assert.equal(L.isLate({ ...r, active: false }, [], at('2026-11-11', '23:00'), 0), false);
});

test('late: an open run left from an earlier period is late', () => {
  const r = daily();
  assert.equal(L.isLate(r, [run(r, '2026-11-10', 'open')], at('2026-11-11', '07:00'), 0), true);
  assert.equal(L.isLate(r, [run(r, '2026-11-11', 'open')], at('2026-11-11', '07:00'), 0), false);
  assert.equal(L.isLate(r, [run(r, '2026-11-10', 'done')], at('2026-11-11', '07:00'), 0), false);
});

test('weekly: one run per chosen weekday, so two days make two separate due days in a week', () => {
  const r = weekly([1, 4]);                                    // Monday and Thursday; 2026-11-09 is a Monday
  assert.equal(L.isDue(r, [run(r, '2026-11-05')], at('2026-11-08'), 1), false, 'Sunday before: last Thursday was done, nothing new until Monday');
  assert.equal(L.isDue(r, [], at('2026-11-09'), 1), true, 'Monday');
  assert.equal(L.isDue(r, [run(r, '2026-11-09')], at('2026-11-09'), 1), false, 'Monday done');
  assert.equal(L.isDue(r, [run(r, '2026-11-09', 'skipped')], at('2026-11-09'), 1), false, 'Monday skipped');
  assert.equal(L.isDue(r, [run(r, '2026-11-09')], at('2026-11-10'), 1), false, 'Tuesday: Monday is done, Thursday not yet');
  assert.equal(L.isDue(r, [run(r, '2026-11-09')], at('2026-11-12'), 1), true, 'Thursday is its own run');
  assert.equal(L.isDue(r, [run(r, '2026-11-09'), run(r, '2026-11-12')], at('2026-11-12'), 1), false, 'both done');
  assert.equal(L.isDue(r, [run(r, '2026-11-09'), run(r, '2026-11-12')], at('2026-11-13'), 1), false, 'and nothing on Friday');
  assert.equal(L.isDue(r, [run(r, '2026-11-09'), run(r, '2026-11-12')], at('2026-11-16'), 1), true, 'next Monday again');
  assert.equal(L.windowFor(r, '2026-11-12', 1).period, '2026-11-12');
});

test('weekly: doing Monday does not mark Thursday done (and the other way round)', () => {
  const r = weekly([1, 4]);
  const monday = [run(r, '2026-11-09')];
  assert.equal(L.isDue(r, monday, at('2026-11-12'), 1), true);
  assert.equal(L.isLate(r, monday, at('2026-11-12', '23:00'), 1), false, 'no dueTime: not late on its own day');
  assert.equal(L.isDue(r, [run(r, '2026-11-12')], at('2026-11-09'), 1), true, 'a Thursday run does not cover Monday');
  assert.equal(L.isDue(r, [run(weekly([1, 4], { id: 'other' }), '2026-11-12')], at('2026-11-12'), 1), true, 'another routine does not count');
});

test('weekly: a missed Monday is late on Tuesday and Wednesday and replaced by Thursday', () => {
  const r = weekly([1, 4]);
  assert.equal(L.isLate(r, [], at('2026-11-09', '08:00'), 1), false, 'Monday, no dueTime');
  assert.equal(L.isLate(r, [], at('2026-11-10'), 1), true, 'Tuesday');
  assert.equal(L.isLate(r, [], at('2026-11-11'), 1), true, 'Wednesday');
  assert.equal(L.windowFor(r, '2026-11-11', 1).period, '2026-11-09', 'the late one is Monday');
  assert.equal(L.isLate(r, [run(r, '2026-11-09')], at('2026-11-11'), 1), false, 'done Monday is not late');
  assert.equal(L.isLate(r, [run(r, '2026-11-09', 'skipped')], at('2026-11-11'), 1), false);
  // Thursday: Thursday's occurrence takes over, Monday no longer piles up.
  assert.equal(L.windowFor(r, '2026-11-12', 1).period, '2026-11-12');
  assert.equal(L.isLate(r, [], at('2026-11-12', '08:00'), 1), false, 'Thursday morning, no dueTime: not late yet');
  assert.equal(L.isDue(r, [], at('2026-11-12'), 1), true);
  // Friday to Sunday: Thursday is the single late one; the next Monday starts fresh.
  assert.equal(L.isLate(r, [], at('2026-11-14'), 1), true);
  assert.equal(L.windowFor(r, '2026-11-15', 1).period, '2026-11-12');
  assert.equal(L.isLate(r, [run(r, '2026-11-12')], at('2026-11-14'), 1), false, 'Monday was missed but Thursday is done: not late');
  assert.equal(L.isLate(r, [], at('2026-11-16', '08:00'), 1), false, 'next Monday takes over');
  assert.equal(L.isLate({ ...r, active: false }, [], at('2026-11-11'), 1), false);
});

test('weekly: dueTime applies on the chosen day, not on other days', () => {
  const r = weekly([1, 4], { dueTime: '10:00' });
  assert.equal(L.isLate(r, [], at('2026-11-09', '10:00'), 1), false, 'Monday on the minute');
  assert.equal(L.isLate(r, [], at('2026-11-09', '10:01'), 1), true, 'Monday after dueTime');
  assert.equal(L.isLate(r, [run(r, '2026-11-09')], at('2026-11-09', '10:01'), 1), false);
  assert.equal(L.isLate(r, [run(r, '2026-11-09')], at('2026-11-12', '09:00'), 1), false, 'Thursday before dueTime');
  assert.equal(L.isLate(r, [run(r, '2026-11-09')], at('2026-11-12', '10:01'), 1), true, 'Thursday after dueTime, Monday done does not help');
  assert.equal(L.isLate(r, [], at('2026-11-10', '07:00'), 1), true, 'Tuesday early: Monday is still late');
});

test('weekly: week start does not matter', () => {
  const r = weekly([0, 3]);                                    // Sunday and Wednesday; 2026-11-08 is a Sunday
  for (const ws of [0, 1]) {
    assert.equal(L.periodFor(r, '2026-11-08', ws), '2026-11-08');
    assert.equal(L.periodFor(r, '2026-11-09', ws), null);
    assert.equal(L.isDue(r, [], at('2026-11-08'), ws), true);
    assert.equal(L.isDue(r, [run(r, '2026-11-08')], at('2026-11-11'), ws), true, 'Wednesday is separate from Sunday');
    assert.equal(L.nextDue(r, at('2026-11-09'), [run(r, '2026-11-08')], ws), '2026-11-11');
  }
});

test('weekly: a run stored with the old week-start period is tolerated', () => {
  const r = weekly([1, 4]);
  const old = [run(r, '2026-11-09')];                          // old rule: period = the Monday of the week
  assert.equal(L.isDue(r, old, at('2026-11-09'), 1), false, 'it simply counts for that date');
  assert.equal(L.isDue(r, old, at('2026-11-12'), 1), true);
  const sunday = [run(r, '2026-11-08')];                       // old Sunday-week start: not a chosen day, counts for nothing, no crash
  assert.doesNotThrow(() => { L.isDue(r, sunday, at('2026-11-10'), 0); L.isLate(r, sunday, at('2026-11-10'), 0); L.nextDue(r, at('2026-11-10'), sunday, 0); });
  assert.equal(L.isDue(r, sunday, at('2026-11-10'), 0), true);
  const openOld = [run(r, '2026-11-02', 'open')];
  assert.equal(L.isLate(r, openOld, at('2026-11-10'), 0), true, 'an old open run is late like any earlier open run');
  assert.doesNotThrow(() => L.groupToday([r], old, at('2026-11-10'), 1));
});

test('weekly: across the year boundary', () => {
  const r = weekly([1, 4]);                                    // 2026-12-28 is a Monday, 2027-01-01 a Friday
  const w = L.windowFor(r, '2027-01-01', 1);
  assert.deepEqual({ ...w }, { period: '2026-12-31', opens: '2026-12-31', deadline: '2026-12-31' }, 'Thursday Dec 31');
  assert.equal(L.isLate(r, [], at('2027-01-01'), 1), true, 'Thursday Dec 31 was missed');
  assert.equal(L.isLate(r, [run(r, '2026-12-31')], at('2027-01-01'), 1), false);
  assert.equal(L.isDue(r, [run(r, '2026-12-31')], at('2027-01-04'), 1), true, 'Monday Jan 4');
  assert.equal(L.periodFor(r, '2027-01-04', 1), '2027-01-04');
});

test('monthly: due from the day, late after it, clamped in short months, year boundary', () => {
  const r = monthly(15, { dueTime: '17:00' });
  assert.equal(L.isDue(r, [], at('2026-11-14'), 0), false);
  assert.equal(L.isDue(r, [], at('2026-11-15'), 0), true);
  assert.equal(L.isLate(r, [], at('2026-11-15', '17:00'), 0), false);
  assert.equal(L.isLate(r, [], at('2026-11-15', '17:01'), 0), true);
  assert.equal(L.isLate(r, [], at('2026-11-16', '08:00'), 0), true);
  assert.equal(L.isDue(r, [run(r, '2026-11-01')], at('2026-11-20'), 0), false);
  assert.equal(L.isDue(r, [run(r, '2026-11-01')], at('2026-12-15'), 0), true, 'next month');
  const last = monthly(31);
  assert.equal(L.windowFor(last, '2027-02-10', 0).opens, '2027-02-28');
  assert.equal(L.windowFor(last, '2028-02-10', 0).opens, '2028-02-29', 'leap year');
  assert.equal(L.windowFor(last, '2026-04-10', 0).opens, '2026-04-30');
  assert.equal(L.windowFor(monthly(1), '2027-01-20', 0).opens, '2027-01-01');
  assert.equal(L.isLate(monthly(1), [], at('2027-01-02'), 0), true, 'the 1st of January was missed');
});

test('once: due from its date until finished, then never again', () => {
  const r = once('2026-11-20', { dueTime: '12:00' });
  assert.equal(L.isDue(r, [], at('2026-11-19'), 0), false);
  assert.equal(L.isDue(r, [], at('2026-11-20'), 0), true);
  assert.equal(L.isLate(r, [], at('2026-11-20', '12:01'), 0), true);
  assert.equal(L.isLate(r, [], at('2026-12-01'), 0), true, 'weeks later it is still due and late');
  assert.equal(L.isDue(r, [run(r, '2026-11-20')], at('2026-12-01'), 0), false);
  assert.equal(L.isDue(once(null), [], at('2026-11-20'), 0), false, 'no date: never');
});

test('manual: never due, never late; open runs still found', () => {
  assert.equal(L.isDue(manual, [], at('2026-11-11'), 0), false);
  assert.equal(L.isLate(manual, [run(manual, '2026-11-01', 'open')], at('2026-11-11'), 0), false);
  assert.equal(L.nextDue(manual, at('2026-11-11'), [], 0), null);
  const open = [run(manual, '2026-11-01', 'open', { startedAt: '2026-11-01T08:00:00Z' }), run(manual, '2026-11-05', 'open', { startedAt: '2026-11-05T08:00:00Z' }), run(manual, '2026-11-06', 'done', { startedAt: '2026-11-06T08:00:00Z' })];
  assert.equal(L.openRunOf(manual, open).period, '2026-11-05');
});

test('nextDue: today when open, tomorrow/next week/next month when done, null when paused or finished', () => {
  const now = at('2026-11-11');   // Wednesday
  assert.equal(L.nextDue(daily(), now, [], 0), '2026-11-11');
  assert.equal(L.nextDue(daily(), now, [run(daily(), '2026-11-11')], 0), '2026-11-12');
  assert.equal(L.nextDue(weekly([5]), now, [], 1), '2026-11-11', 'last Friday was missed: due now');
  assert.equal(L.nextDue(weekly([5]), now, [run(weekly([5]), '2026-11-06')], 1), '2026-11-13', 'last Friday done: the next Friday');
  assert.equal(L.nextDue(weekly([1]), now, [], 1), '2026-11-11', 'missed Monday: due now');
  assert.equal(L.nextDue(weekly([1]), now, [run(weekly([1]), '2026-11-09')], 1), '2026-11-16');
  assert.equal(L.nextDue(monthly(20), now, [], 0), '2026-11-20');
  assert.equal(L.nextDue(monthly(5), now, [run(monthly(5), '2026-11-01')], 0), '2026-12-05');
  assert.equal(L.nextDue(monthly(5), at('2026-12-10'), [run(monthly(5), '2026-12-01')], 0), '2027-01-05');
  assert.equal(L.nextDue(monthly(31), at('2027-01-31'), [run(monthly(31), '2027-01-01')], 0), '2027-02-28');
  assert.equal(L.nextDue(once('2026-12-24'), now, [], 0), '2026-12-24');
  assert.equal(L.nextDue(once('2026-12-24'), now, [run(once('2026-12-24'), '2026-12-24')], 0), null);
  assert.equal(L.nextDue(daily({ active: false }), now, [], 0), null);
});

test('nextDue (weekly): today when chosen and not done, skips unchosen days, crosses a week and a year', () => {
  const r = weekly([1, 4]);                                    // Monday and Thursday
  assert.equal(L.nextDue(r, at('2026-11-12'), [run(r, '2026-11-09')], 1), '2026-11-12', 'Thursday, not done: today');
  assert.equal(L.nextDue(r, at('2026-11-09'), [], 1), '2026-11-09', 'Monday, not done: today');
  assert.equal(L.nextDue(r, at('2026-11-09'), [run(r, '2026-11-09')], 1), '2026-11-12', 'Monday done: Thursday, skipping Tue and Wed');
  assert.equal(L.nextDue(r, at('2026-11-10'), [run(r, '2026-11-09')], 1), '2026-11-12', 'Tuesday after Monday done');
  assert.equal(L.nextDue(r, at('2026-11-12'), [run(r, '2026-11-12')], 1), '2026-11-16', 'Thursday done: crosses the week to Monday');
  assert.equal(L.nextDue(r, at('2026-11-14'), [run(r, '2026-11-12')], 0), '2026-11-16', 'Saturday, any week start');
  assert.equal(L.nextDue(r, at('2026-12-31'), [run(r, '2026-12-31')], 1), '2027-01-04', 'crosses the year: Thu Dec 31 -> Mon Jan 4');
  assert.equal(L.nextDue(r, at('2027-01-01'), [run(r, '2026-12-31')], 1), '2027-01-04');
  assert.equal(L.nextDue(weekly([2]), at('2026-11-10'), [run(weekly([2]), '2026-11-10')], 1), '2026-11-17', 'a single day: a week later');
  assert.equal(L.nextDue(weekly([1, 4], { active: false }), at('2026-11-09'), [], 1), null);
});

test('groupToday: late / in progress / for today / done today, sorted by time', () => {
  const a = daily({ id: 'a', name: 'A', dueTime: '08:00' });
  const b = daily({ id: 'b', name: 'B', dueTime: '17:00' });
  const c = daily({ id: 'c', name: 'C' });
  const d = daily({ id: 'd', name: 'D' });
  const e = weekly([1], { id: 'e', name: 'E' });
  const noon = new Date(2026, 10, 11, 12, 0);   // Wed 2026-11-11 12:00 local
  const finishedToday = new Date(2026, 10, 11, 9, 30).toISOString();
  const runs = [
    { id: 'r1', routineId: 'c', period: '2026-11-11', status: 'open', startedAt: '2026-11-11T10:00:00Z', items: [{ done: true }, { done: false }] },
    { id: 'r2', routineId: 'd', period: '2026-11-11', status: 'done', finishedAt: finishedToday },
    { id: 'r3', routineId: 'e', period: '2026-11-09', status: 'done', finishedAt: new Date(2026, 10, 9, 9, 0).toISOString() }
  ];
  const g = L.groupToday([b, a, c, d, e], runs, noon, 1);
  assert.deepEqual(Array.from(g.late, x => x.routine.id), ['a']);
  assert.deepEqual(Array.from(g.open, x => x.routine.id), ['c']);
  assert.deepEqual(Array.from(g.today, x => x.routine.id), ['b']);
  assert.deepEqual(Array.from(g.done, x => x.routine.id), ['d']);
  assert.equal(g.open[0].run.id, 'r1');
  assert.deepEqual({ ...L.runProgress(runs[0]) }, { done: 1, total: 2 });
});

test('required steps and notification rule', () => {
  const r = { items: [{ stepId: 'a', required: true, done: false }, { stepId: 'b', required: true, done: true }, { stepId: 'c', required: false, done: false }] };
  assert.deepEqual(Array.from(L.missingRequired(r), i => i.stepId), ['a']);
  assert.equal(L.missingRequired({ items: [{ required: true, done: true }] }).length, 0);
  const late = [{ routine: { name: 'x' } }];
  assert.equal(L.shouldNotify({ notifyLate: true, lastNotified: null }, late, '2026-11-11'), true);
  assert.equal(L.shouldNotify({ notifyLate: true, lastNotified: '2026-11-11' }, late, '2026-11-11'), false, 'once a day');
  assert.equal(L.shouldNotify({ notifyLate: true, lastNotified: '2026-11-10' }, late, '2026-11-11'), true, 'a new day');
  assert.equal(L.shouldNotify({ notifyLate: false, lastNotified: null }, late, '2026-11-11'), false);
  assert.equal(L.shouldNotify({ notifyLate: true, lastNotified: null }, [], '2026-11-11'), false, 'nothing late');
});

// ---- creation cut-off: routine.since is the day it was made (local 'YYYY-MM-DD'); earlier occurrences never count -------------
test('createdDay: the local day of created_at; unreadable gives undefined', () => {
  assert.equal(L.createdDay(new Date(2026, 10, 11, 23, 30).toISOString()), '2026-11-11', 'late evening stays on its local day');
  assert.equal(L.createdDay(new Date(2026, 10, 12, 0, 5)), '2026-11-12');
  assert.equal(L.createdDay('nonsense'), undefined);
  assert.equal(L.createdDay(undefined), undefined);
});

test('since: a weekly Friday routine made on a Wednesday is not late until the first Friday after creation', () => {
  const r = weekly([5], { since: '2026-11-11' });              // created Wednesday 2026-11-11; last Friday (11-06) is before it
  assert.equal(L.isLate(weekly([5]), [], at('2026-11-11'), 1), true, 'without since the missed Friday would be late (old behaviour)');
  for (const day of ['2026-11-11', '2026-11-12']) {
    assert.equal(L.windowFor(r, day, 1), null, day);
    assert.equal(L.isDue(r, [], at(day, '23:00'), 1), false, `${day}: not due`);
    assert.equal(L.isLate(r, [], at(day, '23:00'), 1), false, `${day}: not late`);
  }
  assert.equal(L.nextDue(r, at('2026-11-11'), [], 1), '2026-11-13', 'next due is the first Friday');
  assert.equal(L.isDue(r, [], at('2026-11-13', '08:00'), 1), true, 'Friday: due');
  assert.equal(L.isLate(r, [], at('2026-11-13', '23:00'), 1), false, 'Friday without dueTime: not late on its day');
  assert.equal(L.isLate(r, [], at('2026-11-14'), 1), true, 'Saturday: the Friday was missed');
  assert.equal(L.isLate(r, [run(r, '2026-11-13')], at('2026-11-14'), 1), false, 'done Friday is not late');
  assert.equal(L.isLate({ ...r, dueTime: '10:00' }, [], at('2026-11-13', '10:01'), 1), true, 'Friday after dueTime');
  const g = L.groupToday([{ ...r, name: 'F' }], [], at('2026-11-12'), 1);
  assert.equal(g.late.length + g.today.length + g.open.length, 0, 'Today shows nothing');
});

test('since: weekly Monday and Thursday made on a Wednesday starts with Thursday', () => {
  const r = weekly([1, 4], { since: '2026-11-11' });
  assert.equal(L.isDue(r, [], at('2026-11-11'), 1), false, 'Monday is before creation: not due on Wednesday');
  assert.equal(L.isDue(r, [], at('2026-11-12'), 1), true);
  assert.equal(L.nextDue(r, at('2026-11-10'), [], 1), '2026-11-12', 'even asked from a day before');
});

test('since: a daily routine made today at 15:00 with dueTime 09:00 is due today but not late today', () => {
  const r = daily({ dueTime: '09:00', since: '2026-11-11' });
  assert.equal(L.isDue(r, [], at('2026-11-11', '15:00'), 0), true);
  assert.equal(L.isLate(r, [], at('2026-11-11', '15:00'), 0), false, 'dueTime already passed, but it was made after it');
  assert.equal(L.isLate(r, [], at('2026-11-11', '23:59'), 0), false);
  assert.equal(L.isLate(daily({ dueTime: '09:00' }), [], at('2026-11-11', '15:00'), 0), true, 'without since it would be late');
  assert.equal(L.isLate(r, [], at('2026-11-12', '08:00'), 0), false, 'tomorrow: a new occurrence, its time has not come');
  assert.equal(L.isLate(r, [], at('2026-11-12', '09:01'), 0), true, 'tomorrow after dueTime: late as usual');
  assert.equal(L.isDue(r, [], at('2026-11-10'), 0), false, 'a clock before creation: nothing');
  assert.equal(L.nextDue(r, at('2026-11-10'), [], 0), '2026-11-11', 'the first day is the creation day');
});

test('since: monthly and once routines', () => {
  const m = monthly(5, { since: '2026-11-11', dueTime: '17:00' });
  assert.equal(L.isDue(m, [], at('2026-11-20'), 0), false, 'November 5th was before creation');
  assert.equal(L.isLate(m, [], at('2026-11-30'), 0), false);
  assert.equal(L.nextDue(m, at('2026-11-20'), [], 0), '2026-12-05');
  assert.equal(L.isDue(m, [], at('2026-12-05'), 0), true);
  assert.equal(L.isLate(m, [], at('2026-12-06'), 0), true);
  const same = monthly(11, { since: '2026-11-11', dueTime: '09:00' });   // the day it was made is its day
  assert.equal(L.isDue(same, [], at('2026-11-11', '15:00'), 0), true);
  assert.equal(L.isLate(same, [], at('2026-11-11', '15:00'), 0), false, 'made today: late only from tomorrow');
  assert.equal(L.isLate(same, [], at('2026-11-12', '07:00'), 0), true, 'tomorrow: late');
  assert.equal(L.nextDue(same, at('2026-11-11'), [], 0), '2026-11-11');
  const old = once('2026-11-05', { since: '2026-11-11' });
  assert.equal(L.isDue(old, [], at('2026-11-20'), 0), false, 'a one-off dated before creation never counts');
  assert.equal(L.nextDue(old, at('2026-11-11'), [], 0), null);
  const today = once('2026-11-11', { since: '2026-11-11', dueTime: '09:00' });
  assert.equal(L.isDue(today, [], at('2026-11-11', '15:00'), 0), true);
  assert.equal(L.isLate(today, [], at('2026-11-11', '15:00'), 0), false);
  assert.equal(L.isLate(today, [], at('2026-11-12'), 0), true);
  assert.equal(L.nextDue(weekly([5], { since: '2026-11-11', active: false }), at('2026-11-11'), [], 1), null, 'paused stays null');
  assert.equal(L.nextDue({ ...manual, since: '2026-11-11' }, at('2026-11-11'), [], 1), null);
});

test('the Portuguese twin runs the same rules', () => {
  const r = weekly([1, 4]);
  assert.equal(B.periodFor(r, '2026-11-12', 1), '2026-11-12');
  assert.equal(B.periodFor(r, '2026-11-11', 1), null);
  assert.equal(B.isLate(r, [], at('2026-11-11'), 1), true);
  assert.equal(B.isLate(daily({ dueTime: '09:00' }), [], at('2026-11-11', '09:01'), 0), true);
  assert.equal(B.isLate(weekly([5], { since: '2026-11-11' }), [], at('2026-11-12'), 1), false);
  assert.equal(B.createdDay(new Date(2026, 10, 11, 12)), '2026-11-11');
});
