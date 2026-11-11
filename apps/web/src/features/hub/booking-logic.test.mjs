// Bookings template: the slot and conflict rules are plain functions between "// LOGIC START" and "// LOGIC END" in the page's script.
// They are cut out of the page and run in node:vm (no DOM, no SDK), for both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const server = new URL('../../../../../crates/server/src/hub/apps/templates/', import.meta.url);
const NAMES = ['toMin', 'toHm', 'ymdWeekday', 'ymdAdd', 'rangeEnd', 'weekOf', 'timeline', 'slotsFor', 'overlaps', 'conflicts', 'lostRace', 'dateProblem', 'slotProblem', 'slotGrid', 'freeSlots', 'runFrom', 'checkBooking'];

const cut = file => {
  const html = readFileSync(new URL(file, server), 'utf8');
  const start = html.indexOf('// LOGIC START'), end = html.indexOf('// LOGIC END');
  assert.ok(start > 0 && end > start, `${file}: LOGIC markers`);
  return html.slice(start, end);
};
function loadLogic(file) {
  const block = cut(file);
  assert.ok(!/document\.|window\.|tendly\.|tkit\./.test(block), `${file}: the block touches no DOM, SDK or kit`);
  return vm.runInNewContext(`${block}\n({ ${NAMES.join(', ')} })`, {});
}

const L = loadLogic('booking.html');
const arr = x => [...x];
test('the LOGIC block is identical in both languages and loads in both', () => {
  assert.equal(cut('booking.html'), cut('pt-BR/booking.html'));
  const pt = loadLogic('pt-BR/booking.html');
  assert.deepEqual(pt.slotsFor({ kind: 'slots', slot: { minutes: 60, from: '09:00', to: '11:00', weekdays: [3] } }, '2026-11-11').length, 2);
});

const room = (slot = {}, extra = {}) => ({ id: 'r1', kind: 'slots', slot: { minutes: 30, from: '08:00', to: '10:00', weekdays: [1, 2, 3, 4, 5], ...slot }, ...extra });
const car = { id: 'c1', kind: 'days' };
const slotB = (start, end, extra = {}) => ({ id: `b${start}${end}`, resourceId: 'r1', date: '2026-11-11', start, end, endDate: null, status: 'confirmed', created_at: '2026-11-10T10:00:00.000Z', ...extra });
const dayB = (date, endDate, extra = {}) => ({ id: `d${date}`, resourceId: 'c1', date, start: null, end: null, endDate, status: 'confirmed', created_at: '2026-11-10T10:00:00.000Z', ...extra });
const WED = '2026-11-11';   // a Wednesday

test('time and date helpers', () => {
  assert.equal(L.toMin('09:30'), 570);
  assert.equal(L.toHm(570), '09:30');
  assert.equal(L.toHm(L.toMin('00:05')), '00:05');
  assert.equal(L.ymdWeekday(WED), 3);
  assert.equal(L.ymdAdd('2026-12-31', 1), '2027-01-01');
  assert.equal(L.ymdAdd('2028-03-01', -1), '2028-02-29');
  assert.equal(L.rangeEnd({ date: WED, endDate: null }), WED);
  assert.equal(L.rangeEnd({ date: WED, endDate: '2026-11-14' }), '2026-11-14');
});

test('weekOf: seven days from the week start (Monday or Sunday), including a Sunday and a year end', () => {
  assert.deepEqual([...L.weekOf(WED, 1)], ['2026-11-09', '2026-11-10', WED, '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
  assert.equal(L.weekOf(WED, 0)[0], '2026-11-08');
  assert.equal(L.weekOf('2026-11-15', 1)[0], '2026-11-09', 'a Sunday ends the Monday week');
  assert.equal(L.weekOf('2026-11-15', 0)[0], '2026-11-15');
  assert.equal(L.weekOf('2027-01-01', 1)[0], '2026-12-28');
});

test('slotsFor: minutes, from, to and weekdays decide the slots', () => {
  assert.deepEqual(arr(L.slotsFor(room(), WED)).map(s => `${s.start}-${s.end}`), ['08:00-08:30', '08:30-09:00', '09:00-09:30', '09:30-10:00']);
  assert.equal(L.slotsFor(room({ minutes: 60 }), WED).length, 2);
  assert.deepEqual(arr(L.slotsFor(room({ minutes: 90, from: '08:00', to: '11:00' }), WED)).map(s => s.start), ['08:00', '09:30'], 'a half slot at the end is dropped');
  assert.equal(L.slotsFor(room({ minutes: 120 }), WED).length, 1);
  assert.equal(L.slotsFor(room({ minutes: 15, from: '09:00', to: '10:00' }), WED).length, 4);
  assert.deepEqual(arr(L.slotsFor(room({ from: '08:00', to: '08:20' }), WED)), [], 'less than one slot');
  assert.equal(L.slotsFor(room({ weekdays: [1] }), WED).length, 0, 'closed on Wednesday');
  assert.equal(L.slotsFor(room({ weekdays: [0, 6] }), '2026-11-14').length, 4, 'Saturday when chosen');
  assert.equal(L.slotsFor(room(), '2026-11-15').length, 0, 'Sunday is not in 1-5');
  assert.deepEqual(arr(L.slotsFor(car, WED)), [], 'a days resource has no slots');
  assert.deepEqual(arr(L.slotsFor(null, WED)), []);
  assert.ok(L.slotsFor(room({ minutes: 0 }), WED).length > 0, 'a bad length falls back instead of looping forever');
});

test('timeline: shared axis and a unit that divides every slot', () => {
  const a = room({ minutes: 30, from: '08:00', to: '18:00' }), b = room({ minutes: 60, from: '09:00', to: '17:00' });
  assert.deepEqual({ ...L.timeline([a, b]) }, { from: 480, to: 1080, unit: 30 });
  assert.equal(L.timeline([room({ minutes: 45, from: '08:00', to: '17:00' })]).unit, 15);
  assert.equal(L.timeline([car]), null);
  assert.equal(L.timeline([]), null);
});

test('overlaps: slots share time only when they really overlap; end == start is not a conflict', () => {
  const a = slotB('09:00', '10:00');
  assert.equal(L.overlaps(a, slotB('10:00', '11:00')), false, 'starts when the other ends');
  assert.equal(L.overlaps(a, slotB('08:00', '09:00')), false, 'ends when the other starts');
  assert.equal(L.overlaps(a, slotB('09:30', '10:30')), true);
  assert.equal(L.overlaps(a, slotB('08:30', '09:30')), true);
  assert.equal(L.overlaps(a, slotB('09:15', '09:45')), true, 'inside');
  assert.equal(L.overlaps(a, slotB('08:00', '12:00')), true, 'around');
  assert.equal(L.overlaps(a, slotB('09:00', '10:00')), true, 'the same');
  assert.equal(L.overlaps(a, slotB('09:00', '10:00', { date: '2026-11-12' })), false, 'another date');
  assert.equal(L.overlaps(slotB('09:00', '09:30'), slotB('09:30', '10:00')), false);
});

test('overlaps: day ranges are inclusive on both ends', () => {
  assert.equal(L.overlaps(dayB('2026-11-10', '2026-11-12'), dayB('2026-11-12', '2026-11-14')), true, 'share the 12th');
  assert.equal(L.overlaps(dayB('2026-11-10', '2026-11-12'), dayB('2026-11-13', '2026-11-14')), false, 'back to back');
  assert.equal(L.overlaps(dayB('2026-11-10', null), dayB('2026-11-10', null)), true, 'single days');
  assert.equal(L.overlaps(dayB('2026-11-10', null), dayB('2026-11-11', null)), false);
  assert.equal(L.overlaps(dayB('2026-11-09', '2026-11-20'), dayB('2026-11-12', '2026-11-12')), true, 'around');
  assert.equal(L.overlaps({ date: WED }, dayB('2026-11-09', '2026-11-13')), true, 'a plain date inside a range');
  assert.equal(L.overlaps({ date: '2026-11-14' }, dayB('2026-11-09', '2026-11-13')), false);
});

test('conflicts: same resource, confirmed only, never itself', () => {
  const mine = slotB('09:00', '10:00', { id: 'new' });
  const others = [slotB('09:30', '10:30', { id: 'x' }), slotB('09:30', '10:30', { id: 'y', status: 'cancelled' }), slotB('09:30', '10:30', { id: 'z', resourceId: 'r2' }), slotB('10:00', '11:00', { id: 'w' })];
  assert.deepEqual(arr(L.conflicts(mine, others)).map(b => b.id), ['x']);
  assert.deepEqual(arr(L.conflicts({ ...mine, id: 'x' }, [others[0]])), [], 'a booking does not conflict with itself (changing it)');
  assert.deepEqual(arr(L.conflicts({ ...mine, status: 'cancelled' }, others)), [], 'a cancelled candidate blocks nothing');
});

test('cancelled bookings are ignored: the slot becomes free again', () => {
  const r = room(), cancelled = slotB('08:00', '08:30', { status: 'cancelled' });
  assert.equal(L.freeSlots(r, WED, [cancelled]).length, 4);
  assert.equal(L.freeSlots(r, WED, [{ ...cancelled, status: 'confirmed' }]).length, 3);
  assert.equal(L.conflicts(slotB('08:00', '08:30', { id: 'n' }), [cancelled]).length, 0);
});

test('day bookings across several days block each of those days, and only those', () => {
  const trip = dayB('2026-11-10', '2026-11-12');
  for (const d of ['2026-11-10', '2026-11-11', '2026-11-12']) assert.equal(L.conflicts({ resourceId: 'c1', date: d }, [trip]).length, 1, d);
  for (const d of ['2026-11-09', '2026-11-13']) assert.equal(L.conflicts({ resourceId: 'c1', date: d }, [trip]).length, 0, d);
  assert.equal(L.conflicts(dayB('2026-11-12', '2026-11-15', { id: 'n' }), [trip]).length, 1);
  assert.equal(L.conflicts(dayB('2026-11-13', '2026-11-15', { id: 'n' }), [trip]).length, 0);
});

test('slotGrid and freeSlots mark booked cells and keep the booking', () => {
  const r = room(), b = slotB('08:30', '09:30');
  const grid = L.slotGrid(r, WED, [b]);
  assert.deepEqual(arr(grid).map(c => !!c.booking), [false, true, true, false]);
  assert.equal(grid[1].booking.id, b.id);
  assert.deepEqual(arr(L.freeSlots(r, WED, [b])).map(s => s.start), ['08:00', '09:30']);
  assert.equal(L.freeSlots(r, '2026-11-14', []).length, 0, 'closed on Saturday');
});

test('runFrom: how many slots in a row are free, up to the maximum', () => {
  const r = room({ from: '08:00', to: '12:00', minutes: 60 }), grid = L.slotGrid(r, WED, [slotB('10:00', '11:00')]);
  assert.equal(L.runFrom(grid, 0, 4), 2, 'stops at the booked slot');
  assert.equal(L.runFrom(grid, 1, 4), 1);
  assert.equal(L.runFrom(grid, 2, 4), 0, 'a booked slot has no run');
  assert.equal(L.runFrom(grid, 3, 4), 1);
  const open = L.slotGrid(room({ from: '08:00', to: '18:00', minutes: 60 }), WED, []);
  assert.equal(L.runFrom(open, 0, 4), 4, 'capped at the maximum');
  assert.equal(L.runFrom(open, 8, 4), 2, 'capped by the end of the day');
});

const LIM = { today: WED, now: '10:20', allowPast: false, horizonDays: 60 };
test('past and horizon: past slots and days are disabled unless allowed; the horizon is enforced', () => {
  assert.equal(L.dateProblem('2026-11-10', LIM), 'past');
  assert.equal(L.dateProblem(WED, LIM), null);
  assert.equal(L.dateProblem('2027-01-10', LIM), null, 'exactly 60 days ahead is allowed');
  assert.equal(L.dateProblem('2027-01-11', LIM), 'far');
  assert.equal(L.dateProblem('2026-11-10', { ...LIM, allowPast: true }), null);
  assert.equal(L.dateProblem('2027-06-01', { ...LIM, allowPast: true }), 'far', 'allowing the past does not lift the horizon');
  assert.equal(L.dateProblem('2020-01-01', {}), null, 'no limits given');
  assert.equal(L.dateProblem('2026-11-12', { ...LIM, horizonDays: 0 }), 'far');
  const r = room({ from: '09:00', to: '12:00', minutes: 60 });
  assert.deepEqual(arr(L.slotGrid(r, WED, [], LIM)).map(c => c.problem), ['past', 'past', null], 'slots that began before 10:20 are past, the 11:00 one is open');
  assert.deepEqual(arr(L.slotGrid(r, WED, [], { ...LIM, now: '09:00' })).map(c => c.problem), [null, null, null], 'a slot starting right now is still open');
  assert.deepEqual(arr(L.slotGrid(r, WED, [], { ...LIM, allowPast: true })).map(c => c.problem), [null, null, null]);
  assert.deepEqual(arr(L.slotGrid(r, '2026-11-12', [], LIM)).map(c => c.problem), [null, null, null], 'tomorrow is open all day');
  assert.deepEqual(arr(L.slotGrid(r, '2027-02-01', [], LIM)).map(c => c.problem), ['far', 'far', 'far']);
  assert.equal(L.freeSlots(r, WED, [], LIM).length, 1);
  assert.equal(L.slotGrid(r, WED, [slotB('09:00', '10:00')], LIM)[0].problem, null, 'a booked past slot shows the booking, not a problem');
});

test('checkBooking: order, hours, weekday, past and horizon, for slots and for days', () => {
  const r = room({ from: '08:00', to: '18:00', minutes: 30 }), at = (extra = {}) => ({ resourceId: 'r1', date: '2026-11-12', start: '09:00', end: '10:00', ...extra });
  assert.equal(L.checkBooking(r, at(), LIM), null);
  assert.equal(L.checkBooking(r, at({ end: '09:00' }), LIM), 'order');
  assert.equal(L.checkBooking(r, at({ start: '10:00', end: '09:00' }), LIM), 'order');
  assert.equal(L.checkBooking(r, at({ start: null }), LIM), 'order');
  assert.equal(L.checkBooking(r, at({ start: '07:30' }), LIM), 'hours');
  assert.equal(L.checkBooking(r, at({ end: '18:30' }), LIM), 'hours');
  assert.equal(L.checkBooking(r, at({ start: '17:00', end: '18:00' }), LIM), null, 'ends exactly at closing time');
  assert.equal(L.checkBooking(r, at({ date: '2026-11-14' }), LIM), 'closed');
  assert.equal(L.checkBooking(r, at({ date: '2026-11-10' }), LIM), 'past');
  assert.equal(L.checkBooking(r, at({ date: WED, start: '09:00', end: '10:00' }), LIM), 'past');
  assert.equal(L.checkBooking(r, at({ date: '2027-03-02' }), LIM), 'far');
  assert.equal(L.checkBooking(car, dayB('2026-11-12', '2026-11-14'), LIM), null);
  assert.equal(L.checkBooking(car, dayB('2026-11-14', '2026-11-12'), LIM), 'order');
  assert.equal(L.checkBooking(car, dayB('2026-11-09', '2026-11-12'), LIM), 'past');
  assert.equal(L.checkBooking(car, dayB('2027-01-09', '2027-01-12'), LIM), 'far', 'the last day is beyond the horizon');
  assert.equal(L.checkBooking(car, dayB('2026-11-10', '2026-11-12'), { ...LIM, allowPast: true }), null);
});

test('lostRace: after both inserted, the earlier created_at keeps the slot and the later one yields', () => {
  const early = slotB('09:00', '10:00', { id: 'a', created_at: '2026-11-11T10:00:00.100Z' });
  const late = slotB('09:30', '10:30', { id: 'b', created_at: '2026-11-11T10:00:00.250Z' });
  const both = [early, late];
  assert.equal(L.lostRace(late, both), true, 'the later one removes itself');
  assert.equal(L.lostRace(early, both), false, 'the earlier one stays');
  assert.equal(L.lostRace(late, [late]), false, 'nobody else: nothing to lose');
  const tie = { ...late, created_at: early.created_at };
  assert.equal([L.lostRace(early, [early, tie]), L.lostRace(tie, [early, tie])].filter(Boolean).length, 1, 'exactly one of two identical timestamps loses');
  assert.equal(L.lostRace(tie, [early, tie]), true, 'the larger id yields');
  const edge = slotB('10:00', '11:00', { id: 'c', created_at: '2026-11-11T09:00:00.000Z' });
  assert.equal(L.lostRace(late, [edge, late]), true, 'a conflicting earlier booking wins even if a third one is further away');
  assert.equal(L.lostRace(slotB('10:00', '11:00', { id: 'd', created_at: '2026-11-11T10:00:00.900Z' }), [early, late]), true, 'overlaps late (10:00 < 10:30), which is earlier than it');
  assert.equal(L.lostRace(slotB('09:30', '10:00', { id: 'e', created_at: '2026-11-11T10:00:00.050Z' }), [early, { ...late, status: 'cancelled' }]), false, 'a cancelled earlier booking does not count');
  const days = [dayB('2026-11-10', '2026-11-12', { id: 'x', created_at: '2026-11-11T10:00:00.000Z' }), dayB('2026-11-12', '2026-11-13', { id: 'y', created_at: '2026-11-11T10:00:00.001Z' })];
  assert.equal(L.lostRace(days[1], days), true);
  assert.equal(L.lostRace(days[0], days), false);
});
