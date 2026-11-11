// Quiz template: the scoring rules are plain functions between "// LOGIC START" and "// LOGIC END" in the page's script.
// They are cut out of the page and run in node:vm (no DOM, no SDK), for both languages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const server = new URL('../../../../../crates/server/src/hub/apps/templates/', import.meta.url);
const NAMES = ['isScored', 'pointsOf', 'gradeAnswer', 'scoreAttempt', 'isPassed', 'resultTextFor', 'shuffled', 'startOrder', 'questionsFor', 'optionsFor',
  'remainingSeconds', 'clockText', 'attemptStats', 'questionStats', 'hardest', 'parseOptions', 'optionsToText', 'nextOptionId', 'tfOptions', 'validateQuestion'];

const cut = file => { const h = readFileSync(new URL(file, server), 'utf8'); return h.slice(h.indexOf('// LOGIC START'), h.indexOf('// LOGIC END')); };
function loadLogic(file) {
  const block = cut(file);
  assert.ok(block.length > 100, `${file}: LOGIC markers`);
  assert.ok(!/document\.|window\.|tendly\.|tkit\./.test(block), `${file}: the block touches no DOM, SDK or kit`);
  return vm.runInNewContext(`${block}\n({ ${NAMES.join(', ')} })`, {});
}

const L = loadLogic('quiz.html');
test('the LOGIC block is identical in both languages and loads in pt-BR too', () => {
  assert.equal(cut('quiz.html'), cut('pt-BR/quiz.html'));
  assert.deepEqual(Object.keys(loadLogic('pt-BR/quiz.html')), NAMES);
});

const opt = (id, correct = false) => ({ id, label: id.toUpperCase(), correct });
const single = (id, extra = {}) => ({ id, kind: 'single', points: 2, options: [opt('a', true), opt('b'), opt('c')], order: 1, ...extra });
const multi = (id, extra = {}) => ({ id, kind: 'multi', points: 4, options: [opt('a', true), opt('b', true), opt('c'), opt('d')], order: 2, ...extra });
const tf = (id, extra = {}) => ({ id, kind: 'truefalse', points: 1, options: L.tfOptions('false', 'T', 'F'), order: 3, ...extra });
const scale = (id, extra = {}) => ({ id, kind: 'scale', order: 4, ...extra });
const open = (id, extra = {}) => ({ id, kind: 'open', order: 5, ...extra });
const plain = v => JSON.parse(JSON.stringify(v));

test('single and true/false: full points for the right option, nothing otherwise', () => {
  assert.deepEqual(plain(L.gradeAnswer(single('s'), { optionIds: ['a'] })), { correct: true, points: 2, fraction: 1 });
  assert.deepEqual(plain(L.gradeAnswer(single('s'), { optionIds: ['b'] })), { correct: false, points: 0, fraction: 0 });
  assert.equal(L.gradeAnswer(single('s'), {}).correct, false, 'no answer is wrong');
  assert.equal(L.gradeAnswer(single('s'), undefined).points, 0);
  assert.equal(L.gradeAnswer(tf('t'), { optionIds: ['false'] }).points, 1);
  assert.equal(L.gradeAnswer(tf('t'), { optionIds: ['true'] }).correct, false);
  assert.equal(L.gradeAnswer(single('s', { points: undefined }), { optionIds: ['a'] }).points, 1, 'default is 1 point');
});

test('multi: partial credit is (right - wrong) / total right, never below 0, rounded to 2 decimals', () => {
  const q = multi('m');
  assert.equal(L.gradeAnswer(q, { optionIds: ['a', 'b'] }).points, 4);
  assert.equal(L.gradeAnswer(q, { optionIds: ['a', 'b'] }).correct, true);
  assert.equal(L.gradeAnswer(q, { optionIds: ['a'] }).points, 2);
  assert.equal(L.gradeAnswer(q, { optionIds: ['a'] }).correct, false);
  assert.equal(L.gradeAnswer(q, { optionIds: ['a', 'c'] }).points, 0, '1 right - 1 wrong = 0');
  assert.equal(L.gradeAnswer(q, { optionIds: ['c', 'd'] }).points, 0, 'never negative');
  assert.equal(L.gradeAnswer(q, { optionIds: ['a', 'b', 'c'] }).points, 2, 'a wrong pick costs a right one');
  const three = { id: 'x', kind: 'multi', points: 1, options: [opt('a', true), opt('b', true), opt('c', true), opt('d')] };
  assert.equal(L.gradeAnswer(three, { optionIds: ['a'] }).points, 0.33);
  assert.equal(L.gradeAnswer(three, { optionIds: ['a', 'b'] }).points, 0.67);
  assert.equal(L.gradeAnswer(three, { optionIds: ['zzz'] }).points, 0, 'unknown ids are ignored');
});

test('scale and open give no points and never count towards the maximum', () => {
  assert.deepEqual(plain(L.gradeAnswer(scale('x'), { value: 5 })), { correct: null, points: 0, fraction: 1 });
  assert.equal(L.gradeAnswer(scale('x'), { value: 1 }).fraction, 0);
  assert.equal(L.gradeAnswer(scale('x'), { value: 3 }).fraction, 0.5);
  assert.equal(L.gradeAnswer(scale('x'), {}).fraction, null);
  assert.deepEqual(plain(L.gradeAnswer(open('o'), { text: 'hello' })), { correct: null, points: 0, fraction: null });
  const qs = [single('s'), scale('sc'), open('o')];
  const r = L.scoreAttempt(qs, [{ questionId: 's', optionIds: ['a'] }, { questionId: 'sc', value: 5 }, { questionId: 'o', text: 'x' }]);
  assert.equal(r.maxScore, 2);
  assert.equal(r.score, 2);
  assert.equal(r.percent, 100);
  assert.equal(r.answers.length, 3);
});

test('scoreAttempt: percent, unanswered questions, inactive questions, answers carry correct and points', () => {
  const qs = [single('s'), multi('m'), tf('t'), single('off', { active: false })];
  const r = L.scoreAttempt(qs, [{ questionId: 's', optionIds: ['a'] }, { questionId: 'm', optionIds: ['a'] }, { questionId: 'off', optionIds: ['a'] }]);
  assert.equal(r.maxScore, 7, 'inactive questions are left out');
  assert.equal(r.score, 4, '2 + 2 + 0 (tf not answered)');
  assert.equal(r.percent, 57.1);
  assert.deepEqual(plain(r.answers.map(a => [a.questionId, a.correct, a.points])), [['s', true, 2], ['m', false, 2], ['t', false, 0]]);
  assert.deepEqual(plain(L.scoreAttempt([], [])), { answers: [], score: 0, maxScore: 0, percent: 0, sectionScores: {} });
});

test('pass mark: at or above passes; diagnostic mode has no pass/fail', () => {
  assert.equal(L.isPassed(70, 70, 'test'), true);
  assert.equal(L.isPassed(69.9, 70, 'test'), false);
  assert.equal(L.isPassed(100, 70, 'diagnostic'), null);
});

test('section scores: scored questions by points, scale values as 0-100, questions without a section left out', () => {
  const qs = [single('a1', { section: 'Welcome', order: 1 }), single('a2', { section: 'Welcome', order: 2 }), tf('b1', { section: 'Solving', order: 3 }), single('c1', { order: 4 })];
  const r = L.scoreAttempt(qs, [{ questionId: 'a1', optionIds: ['a'] }, { questionId: 'a2', optionIds: ['b'] }, { questionId: 'b1', optionIds: ['false'] }, { questionId: 'c1', optionIds: ['a'] }]);
  assert.deepEqual(plain(r.sectionScores), { Welcome: 50, Solving: 100 });
  const survey = [scale('q1', { section: 'Team', order: 1 }), scale('q2', { section: 'Team', order: 2 }), scale('q3', { section: 'Tools', order: 3 })];
  const d = L.scoreAttempt(survey, [{ questionId: 'q1', value: 5 }, { questionId: 'q2', value: 3 }, { questionId: 'q3', value: 1 }]);
  assert.deepEqual(plain(d.sectionScores), { Team: 75, Tools: 0 });
  assert.equal(d.maxScore, 0);
  assert.equal(d.percent, 50, 'no scored question: the average of the scale answers is the percent');
  const skipped = L.scoreAttempt(survey, [{ questionId: 'q1', value: 5 }]);
  assert.deepEqual(plain(skipped.sectionScores), { Team: 100 }, 'an unanswered scale question is not a zero');
});

test('diagnostic result texts: the range that holds the percent, gaps and edges handled', () => {
  const texts = [{ min: 0, max: 49, text: 'low' }, { min: 50, max: 79, text: 'mid' }, { min: 80, max: 100, text: 'high' }];
  assert.equal(L.resultTextFor(0, texts), 'low');
  assert.equal(L.resultTextFor(49, texts), 'low');
  assert.equal(L.resultTextFor(49.6, texts), 'mid', 'whole percent: 49.6 is 50');
  assert.equal(L.resultTextFor(79, texts), 'mid');
  assert.equal(L.resultTextFor(80, texts), 'high');
  assert.equal(L.resultTextFor(100, texts), 'high');
  const gappy = [{ min: 0, max: 30, text: 'a' }, { min: 60, max: 100, text: 'b' }];
  assert.equal(L.resultTextFor(45, gappy), 'a', 'in a gap: the last range that starts below');
  assert.equal(L.resultTextFor(20, [{ min: 50, max: 100, text: 'only' }]), 'only', 'below every range: the first one');
  assert.equal(L.resultTextFor(10, []), '');
  assert.equal(L.resultTextFor(10, undefined), '');
});

test('shuffle: same seed, same order; a permutation; different seeds differ; true/false and scale keep their order', () => {
  const ids = Array.from({ length: 12 }, (_, i) => 'q' + i);
  const a = L.shuffled(ids, '2026-11-11T10:00:00.000Z');
  assert.deepEqual(plain(a), plain(L.shuffled(ids, '2026-11-11T10:00:00.000Z')));
  assert.deepEqual(plain([...a].sort()), plain([...ids].sort()));
  assert.notDeepEqual(plain(a), ids);
  assert.notDeepEqual(plain(a), plain(L.shuffled(ids, '2026-11-12T10:00:00.000Z')));
  assert.deepEqual(ids, Array.from({ length: 12 }, (_, i) => 'q' + i), 'the input is not changed');
  const qs = ids.map((id, i) => single(id, { order: i }));
  assert.deepEqual(plain(L.startOrder(qs, false, 'x')), ids);
  assert.deepEqual(plain(L.startOrder(qs, true, 'x')), plain(L.startOrder(qs, true, 'x')));
  assert.equal(L.startOrder([...qs, single('off', { active: false })], false, 'x').length, 12);
  const q = single('s', { options: [opt('a', true), opt('b'), opt('c'), opt('d'), opt('e'), opt('f')] });
  assert.deepEqual(plain(L.optionsFor(q, 'seed', false).map(o => o.id)), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(plain(L.optionsFor(q, 'seed', true).map(o => o.id)), plain(L.optionsFor(q, 'seed', true).map(o => o.id)));
  assert.deepEqual(plain(L.optionsFor(tf('t'), 'seed', true).map(o => o.id)), ['true', 'false']);
  assert.equal(L.optionsFor(scale('x'), 'seed', true).length, 0);
});

test('questionsFor follows the order stored in the attempt, drops removed questions and falls back to the quiz order', () => {
  const qs = [single('a', { order: 1 }), single('b', { order: 2 }), single('c', { order: 3, active: false })];
  assert.deepEqual(plain(L.questionsFor(qs, ['b', 'a', 'gone', 'c']).map(q => q.id)), ['b', 'a']);
  assert.deepEqual(plain(L.questionsFor(qs, undefined).map(q => q.id)), ['a', 'b']);
  assert.deepEqual(plain(L.questionsFor(qs, []).map(q => q.id)), ['a', 'b']);
});

test('time limit: seconds left count down to zero and stop there', () => {
  const start = '2026-11-11T10:00:00.000Z', t0 = Date.parse(start);
  assert.equal(L.remainingSeconds(start, t0, 10), 600);
  assert.equal(L.remainingSeconds(start, t0 + 540000, 10), 60);
  assert.equal(L.remainingSeconds(start, t0 + 599500, 10), 1);
  assert.equal(L.remainingSeconds(start, t0 + 600000, 10), 0);
  assert.equal(L.remainingSeconds(start, t0 + 9999999, 10), 0);
  assert.equal(L.remainingSeconds(start, t0, null), null);
  assert.equal(L.remainingSeconds(start, t0, 0), null);
  assert.equal(L.clockText(600), '10:00');
  assert.equal(L.clockText(59), '0:59');
  assert.equal(L.clockText(61), '1:01');
});

test('stats: attempts, average, pass rate (diagnostic attempts excluded), per-question rate and the hardest question', () => {
  const qs = [single('s'), tf('t'), scale('x'), open('o')];
  const done = (percent, passed, answers) => ({ finishedAt: 'x', percent, passed, answers });
  const attempts = [
    done(100, true, [{ questionId: 's', correct: true }, { questionId: 't', correct: true }]),
    done(50, false, [{ questionId: 's', correct: true }, { questionId: 't', correct: false }]),
    done(0, false, [{ questionId: 's', correct: false }, { questionId: 't', correct: false }]),
    { finishedAt: null, percent: 0, passed: null, answers: [{ questionId: 's', correct: false }] }
  ];
  assert.deepEqual(plain(L.attemptStats(attempts)), { count: 3, average: 50, passRate: 33.3 });
  assert.deepEqual(plain(L.attemptStats([])), { count: 0, average: null, passRate: null });
  assert.equal(L.attemptStats([done(80, null, [])]).passRate, null);
  const stats = L.questionStats(qs, attempts);
  assert.deepEqual(plain(stats), [{ id: 's', answered: 3, correct: 2, rate: 67 }, { id: 't', answered: 3, correct: 1, rate: 33 }]);
  assert.equal(L.hardest(stats).id, 't');
  assert.equal(L.hardest(L.questionStats(qs, [])), null);
});

test('options as CSV text: "A*|B|C" both ways, and new option ids never clash', () => {
  assert.deepEqual(plain(L.parseOptions('Red* | Green|Blue ')), [{ id: 'o1', label: 'Red', correct: true }, { id: 'o2', label: 'Green', correct: false }, { id: 'o3', label: 'Blue', correct: false }]);
  assert.deepEqual(plain(L.parseOptions('')), []);
  assert.equal(L.optionsToText(L.parseOptions('A*|B|C*')), 'A*|B|C*');
  assert.equal(L.nextOptionId([]), 'o1');
  assert.equal(L.nextOptionId([{ id: 'o1' }, { id: 'o7' }, { id: 'x' }]), 'o8');
  assert.deepEqual(plain(L.tfOptions('true', 'Yes', 'No')), [{ id: 'true', label: 'Yes', correct: true }, { id: 'false', label: 'No', correct: false }]);
});

test('question validation: single and true/false need exactly one correct, multi at least one, text and two options required', () => {
  const o = (...marks) => marks.map((m, i) => ({ id: 'o' + i, label: 'L' + i, correct: m }));
  assert.equal(L.validateQuestion({ text: ' ', kind: 'open' }), 'text');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'open' }), '');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'scale' }), '');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'single', options: o(true) }), 'options');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'single', options: [...o(true), { id: 'x', label: ' ', correct: false }] }), 'options', 'blank options do not count');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'single', options: o(true, false) }), '');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'single', options: o(false, false) }), 'one');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'single', options: o(true, true) }), 'one');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'multi', options: o(false, false, false) }), 'some');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'multi', options: o(true, true, false) }), '');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'truefalse', options: L.tfOptions('true', 'T', 'F') }), '');
  assert.equal(L.validateQuestion({ text: 'Q', kind: 'truefalse', options: L.tfOptions('', 'T', 'F') }), 'one');
});
