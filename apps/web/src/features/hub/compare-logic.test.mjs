// The Comparador's scoring lives in a `// LOGIC START ... // LOGIC END` block of the page (no DOM, no SDK).
// This test pulls that block out of both language files and runs it in node:vm.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const server = new URL('../../../../../crates/server/src/hub/apps/templates/', import.meta.url);
const pages = { en: readFileSync(new URL('compare.html', server), 'utf8'), pt: readFileSync(new URL('pt-BR/compare.html', server), 'utf8') };

function block(html) {
  const m = html.match(/\/\/ LOGIC START([\s\S]*?)\/\/ LOGIC END/);
  assert.ok(m, 'the page has a LOGIC block');
  return m[1];
}
const logic = vm.runInNewContext(block(pages.en) + '\n;({ hasValue, scoreOptions, rankOptions, reasonsFor })', {});
const { scoreOptions, rankOptions, reasonsFor } = logic;
const plain = value => JSON.parse(JSON.stringify(value));
const scores = (options, criteria) => plain(scoreOptions(options, criteria)).map(s => s.score);

const price = { id: 'price', label: 'Price', kind: 'money', weight: 1, better: 'lower' };
const speed = { id: 'speed', label: 'Speed', kind: 'number', weight: 1, better: 'higher' };
const quality = { id: 'quality', label: 'Quality', kind: 'score', weight: 1, better: 'higher' };
const support = { id: 'support', label: 'Support', kind: 'yesno', weight: 1, better: 'higher' };
const opt = (id, values, archived) => ({ id, values, archived: !!archived });

test('the LOGIC block is the same in English and Portuguese', () => {
  assert.equal(block(pages.en), block(pages.pt));
  assert.doesNotMatch(block(pages.en), /document\.|tendly\.|tkit\.|window\./, 'no DOM, SDK or kit calls inside LOGIC');
});

test('lower is better inverts, higher is better does not', () => {
  const options = [opt('a', { price: 100, speed: 10 }), opt('b', { price: 200, speed: 20 }), opt('c', { price: 150, speed: 15 })];
  assert.deepEqual(scores(options, [price]), [100, 0, 50]);
  assert.deepEqual(scores(options, [speed]), [0, 100, 50]);
});

test('weighted total is sum(weight x norm) / sum(weight) x 100, rounded to one decimal', () => {
  const options = [opt('a', { price: 100, speed: 10 }), opt('b', { price: 200, speed: 20 })];
  assert.deepEqual(scores(options, [{ ...price, weight: 3 }, { ...speed, weight: 1 }]), [75, 25]);
  const thirds = [opt('a', { price: 100 }), opt('b', { price: 200 }), opt('c', { price: 150 })];
  const mixed = [{ ...price, weight: 1 }, { ...quality, weight: 2 }];
  const withQuality = thirds.map((o, i) => ({ ...o, values: { ...o.values, quality: [2, 4, 5][i] } }));
  assert.deepEqual(scores(withQuality, mixed), [Math.round((1 * 1 + 2 * 0.25) / 3 * 1000) / 10, Math.round((0 + 2 * 0.75) / 3 * 1000) / 10, Math.round((0.5 + 2 * 1) / 3 * 1000) / 10]);
});

test('missing values count 0 and are flagged', () => {
  const options = [opt('a', { price: 100 }), opt('b', {}), opt('c', { price: null })];
  const [a, b, c] = plain(scoreOptions(options, [price]));
  assert.equal(a.cells.price.missing, false);
  assert.equal(a.score, 100);
  assert.deepEqual([b.cells.price.missing, b.cells.price.norm, b.score], [true, 0, 0]);
  assert.equal(c.cells.price.missing, true);
  assert.equal(c.cells.price.best, false);
  assert.equal(a.cells.price.best, true, 'the only option with a value is the best at it');
});

test('a single option, or every value equal, scores 1 on that criterion', () => {
  assert.deepEqual(scores([opt('a', { price: 100 })], [price, speed]), [50], 'speed is missing (0), price is 1');
  assert.deepEqual(scores([opt('a', { price: 100 })], [price]), [100]);
  const equal = [opt('a', { price: 80 }), opt('b', { price: 80 })];
  assert.deepEqual(scores(equal, [price]), [100, 100]);
  assert.deepEqual(scores(equal, [{ ...price, better: 'higher' }]), [100, 100]);
  const cells = plain(scoreOptions(equal, [price])).map(s => s.cells.price.best);
  assert.deepEqual(cells, [false, false], 'nobody is "best" when everything is equal');
});

test('yes/no is 1 or 0, and a "lower is better" yes/no flips', () => {
  const options = [opt('a', { support: true }), opt('b', { support: false }), opt('c', {})];
  assert.deepEqual(scores(options, [support]), [100, 0, 0]);
  assert.deepEqual(scores(options, [{ ...support, better: 'lower' }]), [0, 100, 0]);
  assert.equal(plain(scoreOptions(options, [support]))[1].cells.support.missing, false, 'false is a value, not a gap');
});

test('a 1 to 5 score maps to (v - 1) / 4', () => {
  const options = [1, 2, 3, 4, 5].map(v => opt('o' + v, { quality: v }));
  assert.deepEqual(scores(options, [quality]), [0, 25, 50, 75, 100]);
  assert.deepEqual(scores(options, [{ ...quality, better: 'lower' }]), [100, 75, 50, 25, 0]);
  assert.deepEqual(scores([opt('x', { quality: 9 }), opt('y', { quality: 0 })], [quality]), [100, 0], 'out of range values are clamped');
});

test('weights that sum to zero give every option 0, and a weight of 0 ignores its criterion', () => {
  const options = [opt('a', { price: 100, speed: 10 }), opt('b', { price: 200, speed: 20 })];
  assert.deepEqual(scores(options, [{ ...price, weight: 0 }, { ...speed, weight: 0 }]), [0, 0]);
  assert.deepEqual(scores(options, [{ ...price, weight: 0 }, speed]), [0, 100]);
  assert.deepEqual(scores(options, [{ ...price, weight: 'x' }, { ...speed, weight: -3 }]), [0, 0], 'junk and negative weights count as 0');
  assert.deepEqual(scores(options, []), [0, 0], 'no criteria at all');
});

test('archived options are left out of the scoring and of the min-max range', () => {
  const options = [opt('a', { price: 100 }), opt('gone', { price: 1 }, true), opt('b', { price: 200 })];
  const result = plain(scoreOptions(options, [price]));
  assert.deepEqual(result.map(s => s.id), ['a', 'b']);
  assert.deepEqual(result.map(s => s.score), [100, 0], 'the archived price of 1 does not stretch the range');
});

test('ranking sorts by score and ties keep the original order', () => {
  const options = [opt('a', { quality: 3 }), opt('b', { quality: 5 }), opt('c', { quality: 3 }), opt('d', { quality: 5 })];
  const ranked = plain(rankOptions(scoreOptions(options, [quality])));
  assert.deepEqual(ranked.map(r => r.id), ['b', 'd', 'a', 'c']);
  assert.deepEqual(ranked.map(r => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(plain(rankOptions([])), []);
});

test('changing a weight re-ranks', () => {
  const options = [opt('cheap', { price: 100, quality: 2 }), opt('good', { price: 200, quality: 5 })];
  const top = weights => plain(rankOptions(scoreOptions(options, [{ ...price, weight: weights[0] }, { ...quality, weight: weights[1] }])))[0].id;
  assert.equal(top([9, 1]), 'cheap');
  assert.equal(top([1, 9]), 'good');
});

test('reasons are the criteria an option wins, heaviest first, capped, ignoring weight 0', () => {
  const criteria = [{ ...price, weight: 2 }, { ...quality, weight: 9 }, { ...speed, weight: 5 }, { ...support, weight: 0 }];
  const options = [opt('a', { price: 100, quality: 5, speed: 20, support: true }), opt('b', { price: 200, quality: 1, speed: 10, support: false })];
  const ranked = plain(rankOptions(scoreOptions(options, criteria)));
  assert.deepEqual(reasonsFor(ranked[0], criteria, 3), ['Quality', 'Speed', 'Price']);
  assert.deepEqual(reasonsFor(ranked[0], criteria, 2), ['Quality', 'Speed']);
  assert.deepEqual(reasonsFor(ranked[1], criteria, 3), []);
});
