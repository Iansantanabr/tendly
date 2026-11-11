// Apps kit v2: the pure parts of the helpers templates build on (routing, context, settings, schema fields,
// formulas, CSV, examples, markdown). They run in Node with no DOM; the elements are checked in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const here = new URL('./', import.meta.url);
const KIT_JS = readFileSync(new URL('../../../../../crates/server/src/hub/apps/kit.js', here), 'utf8');

/** The kit in Node, in English or Portuguese, with extra globals (a fake `tendly`, say). */
function loadKit(lang = 'en', extra = {}) {
  const document = { documentElement: { lang }, readyState: 'complete', addEventListener() {} };
  const context = vm.createContext({ document, navigator: { language: lang }, Intl, Date, Math, JSON, Object, Array, String, Number, Promise, setTimeout, clearTimeout, console, ...extra });
  context.window = context;
  new vm.Script(KIT_JS, { filename: 'kit.js' }).runInContext(context);
  return context.tkit;
}
/** Values made inside the vm have its own Object/Array: compare them as plain JSON. */
const plain = value => JSON.parse(JSON.stringify(value));
const en = loadKit('en');
const pt = loadKit('pt-BR');

// ---------------------------------------------------------------- A. routing

test('route: parseRoute splits "#view/id" and decodes', () => {
  assert.deepEqual(plain(en.parseRoute('#board/a%20b')), { view: 'board', id: 'a b' });
  assert.deepEqual(plain(en.parseRoute('')), { view: '', id: null });
  assert.deepEqual(plain(en.parseRoute('#x/')), { view: 'x', id: null });
  assert.deepEqual(plain(en.parseRoute('#table')), { view: 'table', id: null });
  assert.deepEqual(plain(en.parseRoute('#article/p/q')), { view: 'article', id: 'p/q' }, 'only the first slash splits');
  assert.deepEqual(plain(en.parseRoute('#board/%E0%A4%A')), { view: 'board', id: '%E0%A4%A' }, 'a bad escape stays as it is');
  assert.deepEqual(plain(en.parseRoute(undefined)), { view: '', id: null });
});

test('route: without a page the helpers exist and do not throw', () => {
  assert.deepEqual(plain(en.route.get()), { view: '', id: null });
  assert.equal(typeof en.route.open, 'function');
  assert.equal(typeof en.route.on(() => {}), 'function', 'on returns a stop function');
});

// ---------------------------------------------------------------- B. context

test('context: mergeContext replaces, clears with null and leaves the rest', () => {
  const merged = en.mergeContext({ selection: 'a', summary: 'b' }, { selection: null });
  assert.deepEqual(plain(merged), { selection: null, summary: 'b' });
  assert.deepEqual(plain(en.mergeContext(null, { summary: 12 })), { selection: null, summary: '12' });
  assert.deepEqual(plain(en.mergeContext({ selection: 'x', summary: 'y' }, {})), { selection: 'x', summary: 'y' });
  assert.deepEqual(plain(en.mergeContext({ selection: 'x', summary: 'y' }, { selection: undefined, other: 1 })), { selection: 'x', summary: 'y' });
});

test('context: tkit.context sends the view, selection and summary to the host, and is silent outside a frame', () => {
  const sent = [];
  const kit = loadKit('en', { tendly: { host: { framed: true, setContext: payload => sent.push(plain(payload)) } } });
  kit.context({ summary: '12 cards' });
  kit.context({ selection: 'Card: A' });
  kit.context({ summary: null });
  assert.deepEqual(sent, [{ view: '', summary: '12 cards' }, { view: '', selection: 'Card: A', summary: '12 cards' }, { view: '', selection: 'Card: A' }]);
  const quiet = loadKit('en', { tendly: { host: { framed: false, setContext() { throw new Error('should not be called'); } } } });
  assert.doesNotThrow(() => quiet.context({ summary: 'x' }));
  assert.doesNotThrow(() => en.context({ summary: 'x' }), 'no SDK at all');
});

// ---------------------------------------------------------------- C. settings

test('settings: mergeSettings lays the stored value over the defaults, deeply', () => {
  const defaults = { v: 1, currency: 'BRL', columns: [{ id: 'a' }, { id: 'b' }], flags: { x: true, y: false }, goal: null };
  const stored = { v: 1, currency: 'USD', columns: [{ id: 'z' }], flags: { y: true }, extra: 5 };
  const merged = plain(en.mergeSettings(defaults, stored));
  assert.deepEqual(merged, { v: 1, currency: 'USD', columns: [{ id: 'z' }], flags: { x: true, y: true }, goal: null, extra: 5 });
  assert.deepEqual(plain(en.mergeSettings(defaults, null)), plain(defaults), 'nothing stored: the defaults');
  assert.equal(en.mergeSettings({ a: 1 }, {}).v, 1, 'always has v');
  assert.equal(en.mergeSettings({ v: 3 }, {}).v, 3);
  assert.equal(en.mergeSettings({ v: 3 }, { v: 2 }).v, 2);
  const out = en.mergeSettings(defaults, stored);
  out.columns.push({ id: 'q' });
  out.flags.x = false;
  assert.equal(defaults.columns.length, 2, 'the defaults are not touched');
  assert.equal(defaults.flags.x, true);
  assert.equal(plain(en.mergeSettings({ a: 1 }, JSON.parse('{"__proto__": {"hacked": 1}}'))).hacked, undefined, 'no prototype tricks');
  assert.equal(({}).hacked, undefined);
});

test('settings: tkit.settings loads, saves the whole value, tells listeners and takes a failed save back', async () => {
  const store = { settings: { v: 1, currency: 'USD', old: true } };
  const writes = [];
  let failNext = false;
  const kit = loadKit('en', { tendly: { data: {
    get: async (key, fallback) => (key in store ? store[key] : fallback),
    set: async (key, value) => { if (failNext) throw new Error('disk'); writes.push([key, plain(value)]); store[key] = value; }
  } } });
  const S = await kit.settings('settings', { v: 1, currency: 'BRL', titleField: 'name' });
  assert.deepEqual(plain(S.value), { v: 1, currency: 'USD', titleField: 'name', old: true });
  assert.equal(S.error, null);
  const seen = [];
  const stop = S.on(value => seen.push(plain(value).currency));
  await S.save({ currency: 'EUR' });
  assert.deepEqual(writes, [['settings', { v: 1, currency: 'EUR', titleField: 'name', old: true }]], 'the whole value is written');
  assert.deepEqual(seen, ['EUR']);
  failNext = true;
  await assert.rejects(S.save({ currency: 'GBP' }), /disk/);
  assert.equal(S.value.currency, 'EUR', 'a failed write is taken back');
  assert.deepEqual(seen, ['EUR', 'GBP', 'EUR']);
  stop();
  failNext = false;
  await S.save({ currency: 'BRL' });
  assert.deepEqual(seen, ['EUR', 'GBP', 'EUR'], 'stopped listeners hear nothing');
});

test('settings: when reading fails the defaults are used and S.error says why; with no SDK it still works', async () => {
  const kit = loadKit('en', { tendly: { data: { get: async () => { throw new Error('outside'); }, set: async () => {} } } });
  const S = await kit.settings('settings', { v: 1, a: 1 });
  assert.deepEqual(plain(S.value), { v: 1, a: 1 });
  assert.match(S.error.message, /outside/);
  const alone = await en.settings('settings', { v: 1, a: 1 });
  assert.equal(alone.error, null);
  assert.equal(alone.value.a, 1);
  await alone.save({ a: 2 });
  assert.equal(alone.value.a, 2, 'kept in memory');
});

// ---------------------------------------------------------------- D. schema fields

test('fields: slug folds accents, keeps [a-z0-9_] and is unique', () => {
  assert.equal(en.slug('Valor total'), 'valor_total');
  assert.equal(en.slug('  Preço (R$) '), 'preco_r');
  assert.equal(en.slug('Ação  de  Graças'), 'acao_de_gracas');
  assert.equal(en.slug('Nome', ['nome']), 'nome_2');
  assert.equal(en.slug('Nome', ['nome', 'nome_2']), 'nome_3');
  assert.equal(en.slug(''), 'field');
  assert.equal(en.slug('???'), 'field');
  assert.equal(en.slug('2024 total'), 'f_2024_total', 'an id is also a formula name: it cannot start with a digit');
  assert.equal(en.slug('and'), 'and_2', 'formula keywords are never ids');
  const long = en.slug('x'.repeat(80));
  assert.equal(long.length, 40);
  assert.ok(en.slug('x'.repeat(80), [long]).length <= 40);
  assert.match(en.slug('Qualquer coisa 123'), /^[a-z0-9_]+$/);
});

test('fields: parseNumber reads both separators by language', () => {
  assert.equal(pt.parseNumber('1.234,5'), 1234.5);
  assert.equal(en.parseNumber('1,234.5'), 1234.5);
  assert.equal(pt.parseNumber('1234.5'), 1234.5);
  assert.equal(en.parseNumber('1234.5'), 1234.5);
  assert.equal(pt.parseNumber('1.234'), 1234, 'in Portuguese a dot with three digits is a thousands mark');
  assert.equal(en.parseNumber('1.234'), 1.234);
  assert.equal(en.parseNumber('1,234'), 1234);
  assert.equal(pt.parseNumber('1,234'), 1.234);
  assert.equal(pt.parseNumber('1.234.567,89'), 1234567.89);
  assert.equal(pt.parseNumber('R$ 1.234,56'), 1234.56);
  assert.equal(en.parseNumber('$12.50'), 12.5);
  assert.equal(pt.parseNumber('-3,5'), -3.5);
  assert.equal(pt.parseNumber('0,125'), 0.125);
  assert.equal(pt.parseNumber('  42 '), 42);
  assert.equal(pt.parseNumber(7), 7);
  for (const bad of ['abc', '', '1.2.3', '12-3', '1,2,3', '--1', null]) assert.equal(pt.parseNumber(bad), null, String(bad));
});

test('fields: fieldValue normalizes what people type, in Portuguese and in English', () => {
  const number = { id: 'n', type: 'number' }, money = { id: 'm', type: 'money' };
  assert.equal(pt.fieldValue(number, '1.234,5'), 1234.5);
  assert.equal(en.fieldValue(number, '1,234.5'), 1234.5);
  assert.equal(pt.fieldValue(money, 'R$ 12,50'), 12.5);
  assert.equal(pt.fieldValue(number, 'abc'), 'abc', 'not a number: kept so validate can say so');
  assert.equal(pt.fieldValue(number, ''), null);
  assert.equal(pt.fieldValue(number, '   '), null);
  assert.equal(pt.fieldValue(number, undefined), null);
  assert.equal(pt.fieldValue(number, 0), 0, 'zero is a value');
  const dateField = { id: 'd', type: 'date' };
  assert.equal(pt.fieldValue(dateField, '2026-11-03'), '2026-11-03');
  assert.equal(pt.fieldValue(dateField, '03/11/2026'), '2026-11-03');
  assert.equal(en.fieldValue(dateField, '11/03/2026'), '2026-11-03');
  assert.equal(en.fieldValue(dateField, '25/12/2026'), '2026-12-25', 'a day over 12 can only be the day');
  assert.equal(pt.fieldValue(dateField, '2026-11-03T10:00:00-03:00'), '2026-11-03');
  assert.equal(pt.fieldValue(dateField, '31/02/2026'), '31/02/2026', 'not a real day: kept for validate');
  const stamp = { id: 't', type: 'datetime' };
  assert.equal(pt.fieldValue(stamp, '2026-11-03T10:00:00-03:00'), '2026-11-03T10:00:00-03:00', 'an offset is kept');
  assert.match(pt.fieldValue(stamp, '2026-11-03T14:30'), /^2026-11-03T14:30:00[+-]\d\d:\d\d$/, 'local time gets its offset');
  const check = { id: 'c', type: 'checkbox' };
  assert.equal(pt.fieldValue(check, true), true);
  assert.equal(pt.fieldValue(check, 'Sim'), true);
  assert.equal(pt.fieldValue(check, 'não'), false);
  assert.equal(pt.fieldValue(check, ''), false);
  const choice = { id: 'k', type: 'choice', options: [{ id: 'todo', label: 'A fazer' }, { id: 'done', label: 'Feito' }] };
  assert.equal(pt.fieldValue(choice, 'done'), 'done');
  assert.equal(pt.fieldValue(choice, 'a FAZER'), 'todo', 'a label from a CSV finds its option');
  assert.equal(pt.fieldValue(choice, 'gone'), 'gone', 'an option that was removed is kept');
  assert.equal(pt.fieldValue(choice, ''), null);
  const multi = { id: 'x', type: 'multi', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] };
  assert.deepEqual(plain(pt.fieldValue(multi, ['a', 'b', 'a'])), ['a', 'b']);
  assert.deepEqual(plain(pt.fieldValue(multi, 'Alpha; Beta')), ['a', 'b']);
  assert.deepEqual(plain(pt.fieldValue(multi, 'alpha, beta')), ['a', 'b']);
  assert.equal(pt.fieldValue(multi, []), null);
  assert.equal(pt.fieldValue({ id: 't', type: 'text' }, '  hello '), 'hello');
  assert.equal(pt.fieldValue({ id: 't', type: 'text' }, 5), '5');
  assert.deepEqual(plain(pt.fieldValue({ id: 'i', type: 'image' }, { path: 'files/a.png', name: 'a.png', type: 'image/png' })), { path: 'files/a.png', name: 'a.png', type: 'image/png' });
  assert.equal(pt.fieldValue({ id: 'f', type: 'formula' }, 5), null, 'formulas are never stored');
});

test('fields: fieldText shows values the way a page should', () => {
  const choice = { id: 'k', type: 'choice', options: [{ id: 'todo', label: 'A fazer' }] };
  assert.equal(pt.fieldText(choice, 'todo'), 'A fazer');
  assert.equal(pt.fieldText(choice, 'gone'), 'gone');
  assert.equal(pt.fieldText({ id: 'x', type: 'multi', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }] }, ['a', 'b']), 'Alpha, Beta');
  assert.equal(pt.fieldText({ type: 'money' }, 1234.5, { currency: 'BRL' }).replace(/\s/g, ' '), 'R$ 1.234,50');
  assert.equal(en.fieldText({ type: 'money', currency: 'EUR' }, 5, { currency: 'USD' }).replace(/\s/g, ' '), '€5.00', 'the field currency wins');
  assert.equal(en.fieldText({ type: 'number' }, 1234.5), '1,234.5');
  assert.equal(pt.fieldText({ type: 'date' }, '2026-11-03'), '3 de nov. de 2026');
  assert.equal(pt.fieldText({ type: 'checkbox' }, true), 'Sim');
  assert.equal(pt.fieldText({ type: 'checkbox' }, false), 'Não');
  assert.equal(en.fieldText({ type: 'checkbox' }, true), 'Yes');
  assert.equal(pt.fieldText({ type: 'checkbox' }, undefined), '');
  assert.equal(pt.fieldText({ type: 'image' }, { path: 'files/a.png', name: 'foto.png' }), 'foto.png');
  assert.equal(pt.fieldText({ type: 'file' }, { path: 'files/a.pdf' }), 'a.pdf');
  assert.equal(pt.fieldText({ type: 'text' }, null), '');
  assert.equal(pt.fieldText({ type: 'text' }, 0), '0');
  assert.equal(pt.fieldText({ type: 'formula' }, null), '—');
  assert.equal(pt.fieldText({ type: 'formula' }, 3.14159), '3,14');
  assert.equal(pt.fieldText({ type: 'formula' }, 'ok'), 'ok');
});

test('fields: validate checks required, numbers, e-mails, links and dates', () => {
  const fields = [
    { id: 'name', type: 'text', required: true }, { id: 'age', type: 'number' }, { id: 'mail', type: 'email' }, { id: 'site', type: 'url' },
    { id: 'when', type: 'date' }, { id: 'tags', type: 'multi', required: true, options: [] }, { id: 'ok', type: 'checkbox', required: true }, { id: 'total', type: 'formula', required: true }
  ];
  const good = { name: 'Ana', age: 3, mail: 'ana@exemplo.com.br', site: 'https://exemplo.com', when: '2026-11-03', tags: ['a'], ok: true };
  assert.deepEqual(plain(pt.validate(fields, good)), { ok: true, errors: {} });
  const bad = pt.validate(fields, { name: '', age: 'abc', mail: 'ana@', site: 'ftp://x', when: '31/02/2026', tags: [], ok: false });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(plain(bad.errors)).sort(), ['age', 'mail', 'name', 'ok', 'site', 'tags', 'when']);
  assert.equal(pt.validate([{ id: 'd', type: 'date' }], { d: '2026-02-31' }).errors.d, 'Data inválida', 'a date that does not exist');
  assert.equal(pt.validate([{ id: 'd', type: 'date' }], { d: '2026-02-28' }).ok, true);
  assert.equal(pt.validate(fields, { name: '   ' }).errors.name, 'Obrigatório');
  assert.equal(en.validate(fields, { name: '' }).errors.name, 'Required');
  assert.equal(pt.validate(fields, good).errors.total, undefined, 'formula fields are never checked');
  assert.equal(pt.validate([{ id: 'n', type: 'number', required: true }], { n: 0 }).ok, true, 'zero is a value');
  assert.equal(pt.validate([{ id: 'n', type: 'number' }], {}).ok, true, 'optional and absent');
  assert.equal(pt.validate([{ id: 'a', type: 'number' }], { a: 'abc' }).errors.a, 'Não é um número');
});

test('fields: compute fills formula fields, in any order, and lists what failed', () => {
  const fields = [
    { id: 'total', type: 'formula', formula: 'preco * qtd' },
    { id: 'preco', type: 'money' }, { id: 'qtd', type: 'number' },
    { id: 'com_imposto', type: 'formula', formula: 'round(total * 1.1, 2)' }
  ];
  const data = { preco: 10, qtd: 3, other: 'kept' };
  const result = en.compute(fields, data);
  assert.equal(result.total, 30);
  assert.equal(result.com_imposto, 33);
  assert.equal(result.other, 'kept');
  assert.equal(data.total, undefined, 'a copy');
  assert.deepEqual(plain(result._errors), {});
  assert.equal(JSON.stringify(result).includes('_errors'), false, '_errors is not stored by accident');
  assert.equal(en.compute(fields, { preco: 10 }).total, null, 'a missing input gives an empty result');
  // errors
  const broken = en.compute([{ id: 'a', type: 'formula', formula: 'b +' }, { id: 'b', type: 'number' }, { id: 'c', type: 'formula', formula: 'nope + 1' }], { b: 1 });
  assert.equal(broken.a, null);
  assert.equal(broken.c, null);
  assert.deepEqual(Object.keys(plain(broken._errors)).sort(), ['a', 'c']);
  assert.equal(broken._errors.c, 'Unknown field: nope');
  assert.equal(pt.compute([{ id: 'c', type: 'formula', formula: 'nope + 1' }], {})._errors.c, 'Campo desconhecido: nope');
  // cycles
  const cycle = pt.compute([{ id: 'a', type: 'formula', formula: 'b + 1' }, { id: 'b', type: 'formula', formula: 'a + 1' }, { id: 'c', type: 'formula', formula: '1 + 1' }, { id: 'self', type: 'formula', formula: 'self * 2' }], {});
  assert.equal(cycle.a, null);
  assert.equal(cycle.b, null);
  assert.equal(cycle.self, null);
  assert.equal(cycle.c, 2, 'formulas outside the cycle still work');
  assert.equal(cycle._errors.a, 'Fórmula circular');
  assert.equal(cycle._errors.b, 'Fórmula circular');
  assert.equal(cycle._errors.self, 'Fórmula circular');
  assert.equal(cycle._errors.c, undefined);
  // a chain longer than one
  const chain = en.compute([{ id: 'c', type: 'formula', formula: 'b * 2' }, { id: 'b', type: 'formula', formula: 'a + 1' }, { id: 'a', type: 'number' }], { a: 1 });
  assert.equal(chain.c, 4);
});

// ---------------------------------------------------------------- F. formulas

const run = (text, values = {}, options) => en.formula.evaluate(text, values, options);

test('formula: numbers, strings and precedence', () => {
  assert.equal(run('1 + 2 * 3'), 7);
  assert.equal(run('(1 + 2) * 3'), 9);
  assert.equal(run('10 - 4 - 3'), 3, 'left to right');
  assert.equal(run('100 / 5 / 2'), 10);
  assert.equal(run('7 % 4'), 3);
  assert.equal(run('1.5 + .5'), 2);
  assert.equal(run('"ab" & "cd"'), 'abcd');
  assert.equal(run('"say ""hi"""'), 'say "hi"');
  assert.equal(run('1 + 2 & 3'), '33', '& binds looser than +');
  assert.equal(run('2 + 3 > 4'), true);
  assert.equal(run('1 + 1 = 2 and 2 < 3'), true);
  assert.equal(run('true or false and false'), true, 'and binds tighter than or');
  assert.equal(run('not 1 = 2'), true, 'not covers the whole comparison');
  assert.equal(run('not true'), false);
  assert.equal(run('1 <> 2'), true);
  assert.equal(run('3 >= 3'), true);
  assert.equal(run('3 <= 2'), false);
  assert.equal(run('"a" = "a"'), true);
  assert.equal(run('"a" < "b"'), true);
  assert.equal(run('2 * 3 + 4 * 5'), 26);
  assert.equal(run('  1   +   1  '), 2);
  assert.equal(run('TRUE'), true, 'keywords and names are not case sensitive');
});

test('formula: unary minus and the power operator', () => {
  assert.equal(run('-3'), -3);
  assert.equal(run('--3'), 3);
  assert.equal(run('2 * -3'), -6);
  assert.equal(run('-2 ^ 2'), -4, '^ binds tighter than unary minus');
  assert.equal(run('(-2) ^ 2'), 4);
  assert.equal(run('2 ^ 3 ^ 2'), 512, '^ is right-associative');
  assert.equal(run('2 ^ -1'), 0.5);
  assert.equal(run('-x', { x: 4 }), -4);
  assert.equal(run('+5'), 5);
});

test('formula: every function', () => {
  assert.equal(run('if(1 > 2, "a", "b")'), 'b');
  assert.equal(run('if(true, 1)'), 1);
  assert.equal(run('if(false, 1)'), null);
  assert.equal(run('if(x, 1, 2)', { x: null }), 2, 'an empty condition is false');
  assert.equal(run('if(b = 0, 0, a / b)', { a: 4, b: 0 }), 0, 'only the branch taken is worked out');
  assert.equal(run('min(3, 1, 2)'), 1);
  assert.equal(run('max(3, 1, 2)'), 3);
  assert.equal(run('min(a, 5)', { a: null }), 5, 'min and max skip empty values');
  assert.equal(run('max(a)', { a: null }), null);
  assert.equal(run('sum(1, 2, 3)'), 6);
  assert.equal(run('sum(1, a, 3)', { a: null }), 4);
  assert.equal(run('avg(2, 4)'), 3);
  assert.equal(run('avg(a)', { a: null }), null);
  assert.equal(run('round(2.5)'), 3);
  assert.equal(run('round(-2.5)'), -3, 'half away from zero');
  assert.equal(run('round(1.005, 2)'), 1.01);
  assert.equal(run('round(3.14159, 2)'), 3.14);
  assert.equal(run('round(1234, 0)'), 1234);
  assert.equal(run('floor(2.7)'), 2);
  assert.equal(run('floor(-2.1)'), -3);
  assert.equal(run('ceil(2.1)'), 3);
  assert.equal(run('abs(-4)'), 4);
  assert.equal(run('sqrt(16)'), 4);
  assert.equal(run('sqrt(-1)'), null);
  assert.equal(run('days("2026-01-01", "2026-01-31")'), 30);
  assert.equal(run('days("2026-03-01", "2026-02-01")'), -28);
  assert.equal(run('days("2026-03-28", "2026-03-30")'), 2, 'daylight saving does not leak in');
  assert.equal(run('days(a, "2026-01-31")', { a: null }), null);
  assert.equal(run('days("nonsense", "2026-01-31")'), null);
  assert.equal(run('today()', {}, { today: '2026-11-11' }), '2026-11-11');
  assert.equal(run('today()'), en.today());
  assert.equal(run('days(today(), today())'), 0);
  assert.equal(run('year("2026-11-03")'), 2026);
  assert.equal(run('month("2026-11-03")'), 11);
  assert.equal(run('year(a)', { a: null }), null);
  assert.equal(run('len("abc")'), 3);
  assert.equal(run('len(a)', { a: null }), 0);
  assert.equal(run('upper("abc")'), 'ABC');
  assert.equal(run('lower("ABC")'), 'abc');
  assert.equal(run('concat("a", 1, b, "c")', { b: null }), 'a1c');
  assert.equal(run('pct(1, 4)'), 25);
  assert.equal(run('pct(1, 0)'), null);
  assert.equal(run('coalesce(a, b, 3)', { a: null, b: '' }), 3);
  assert.equal(run('coalesce(a, 7)', { a: 0 }), 0, 'zero is a value');
  assert.deepEqual(plain(en.formula.functions.slice().sort()), ['abs', 'avg', 'ceil', 'coalesce', 'concat', 'days', 'floor', 'if', 'len', 'lower', 'max', 'min', 'month', 'pct', 'round', 'sqrt', 'sum', 'today', 'upper', 'year']);
});

test('formula: an empty input empties the result, division by zero is empty too', () => {
  assert.equal(run('a + 1', { a: null }), null);
  assert.equal(run('a * b', { a: 2, b: null }), null);
  assert.equal(run('-a', { a: null }), null);
  assert.equal(run('a ^ 2', { a: null }), null);
  assert.equal(run('round(a, 2)', { a: null }), null);
  assert.equal(run('abs(a)', { a: null }), null);
  assert.equal(run('upper(a)', { a: null }), null);
  assert.equal(run('a + 1', {}), null, 'a value that is absent is empty');
  assert.equal(run('(a + 1) * 2', { a: null }), null);
  assert.equal(run('1 / 0'), null);
  assert.equal(run('a / b', { a: 5, b: 0 }), null);
  assert.equal(run('5 % 0'), null);
  assert.equal(run('0 ^ -1'), null);
  assert.equal(run('a / b + 1', { a: 5, b: 0 }), null, 'and the emptiness spreads');
  assert.equal(run('a = b', { a: null, b: null }), true);
  assert.equal(run('a = 1', { a: null }), false);
  assert.equal(run('a > 1', { a: null }), false);
  assert.equal(run('"5" + 1'), 6, 'numbers written as text count');
  assert.equal(run('"x" + 1'), null);
  assert.equal(run('a + 1', { a: true }), 2);
  assert.equal(run('a + 1', { a: ['x'] }), null, 'a list is text for a formula');
  assert.equal(run('a + 1', { a: { path: 'f' } }), null, 'a file has no value');
});

test('formula: compile reports unknown fields, unbalanced parentheses and the rest, with a position', () => {
  const ids = ['preco', 'qtd'];
  const ok = en.formula.compile('preco * qtd + preco', ids);
  assert.equal(ok.ok, true);
  assert.deepEqual(plain(ok.deps), ['preco', 'qtd'], 'each field once');
  assert.equal(ok.run({ preco: 2, qtd: 3 }), 8);
  assert.equal(en.formula.compile('2 + 2').ok, true, 'any name is allowed without a list of ids');
  const unknown = en.formula.compile('preco * nope', ids);
  assert.deepEqual(plain(unknown), { ok: false, error: 'Unknown field: nope', at: 8 });
  assert.equal(pt.formula.compile('x', ids).error, 'Campo desconhecido: x');
  const open = en.formula.compile('(1 + 2', ids);
  assert.equal(open.ok, false);
  assert.match(open.error, /parenthesis/);
  assert.equal(en.formula.compile('1 + 2)', ids).error, 'Unexpected )');
  assert.equal(en.formula.compile('1 +', ids).ok, false);
  assert.equal(en.formula.compile('', ids).ok, false);
  assert.equal(en.formula.compile('   ', ids).ok, false);
  assert.equal(en.formula.compile('nope(1)', ids).error, 'Unknown function: nope');
  assert.equal(en.formula.compile('round()', ids).error, 'Wrong number of values for round');
  assert.equal(en.formula.compile('round(1, 2, 3)', ids).ok, false);
  assert.equal(en.formula.compile('today(1)', ids).ok, false);
  assert.equal(en.formula.compile('1,5 + 1', ids).ok, false, 'a decimal comma is not accepted');
  assert.equal(en.formula.compile('"open', ids).error, 'A text is missing its closing quote');
  assert.equal(en.formula.compile('1 $ 2', ids).error, 'Unexpected character: $');
  assert.equal(en.formula.compile('1 2', ids).ok, false);
  assert.equal(en.formula.compile('preco preco', ids).ok, false);
  assert.equal(en.formula.compile('* 2', ids).ok, false);
  assert.equal(en.formula.compile('if(1, 2', ids).ok, false);
  assert.equal(en.formula.compile('constructor', ['preco']).ok, false, 'names from the prototype chain are not fields');
  assert.equal(en.formula.compile('constructor(1)', ['preco']).error, 'Unknown function: constructor');
  assert.equal(en.formula.compile('toString(1)').ok, false);
});

test('formula: long and deep expressions', () => {
  const long = Array.from({ length: 66 }, (_, i) => String(i % 10)).join(' + ');
  assert.ok(long.length >= 200);
  assert.equal(run(long), Array.from({ length: 66 }, (_, i) => i % 10).reduce((a, b) => a + b, 0));
  const nested = '('.repeat(50) + '1' + ')'.repeat(50);
  assert.equal(run(nested), 1);
  const tooDeep = '('.repeat(150) + '1' + ')'.repeat(150);
  assert.equal(en.formula.compile(tooDeep).ok, false);
  assert.equal(en.formula.compile(tooDeep).error, 'The formula is too complex');
  assert.equal(en.formula.compile('1+'.repeat(600) + '1').ok, false, 'past 1000 characters');
  assert.equal(en.formula.compile('1+'.repeat(600) + '1').error, 'The formula is too long');
});

test('formula: there is no way out into JavaScript', () => {
  assert.equal(run('this'), null, 'not a name');
  assert.equal(en.formula.compile('this.constructor').ok, false);
  assert.equal(en.formula.compile('x.y', ['x']).ok, false);
  assert.equal(en.formula.compile('[1]').ok, false);
  assert.equal(en.formula.compile('x["a"]', ['x']).ok, false);
  assert.equal(en.formula.compile('alert(1)').ok, false);
  assert.equal(en.formula.compile('`a`').ok, false);
  assert.ok(!/\beval\s*\(|new Function|Function\(/.test(KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'the kit never calls eval or Function');
});

// ---------------------------------------------------------------- G. CSV

test('csv: stringify quotes, ends lines with CRLF and starts with a BOM', () => {
  const columns = [{ key: 'name', label: 'Nome' }, { key: 'note', label: 'Nota' }, { key: 'value', label: 'Valor', format: v => (v === null ? '' : v.toFixed(2)) }];
  const rows = [{ name: 'Ana', note: 'diz "oi", depois\nsai', value: 12.5 }, { name: 'João; Silva', note: '', value: null }];
  const csv = en.csv.stringify(rows, columns);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.slice(1), 'Nome,Nota,Valor\r\nAna,"diz ""oi"", depois\nsai",12.50\r\nJoão; Silva,,\r\n');
  const semi = en.csv.stringify(rows, columns, { delimiter: ';' }).slice(1);
  assert.equal(semi.split('\r\n')[0], 'Nome;Nota;Valor');
  assert.ok(semi.includes('"João; Silva"'), 'a cell with the delimiter is quoted');
  assert.equal(pt.csv.delimiter(), ';');
  assert.equal(en.csv.delimiter(), ',');
  assert.equal(en.csv.stringify([], columns).slice(1), 'Nome,Nota,Valor\r\n', 'just the header');
});

test('csv: stringify formats values for a spreadsheet and defuses formulas', () => {
  const columns = [{ key: 'a', label: 'a' }];
  const cell = value => en.csv.stringify([{ a: value }], columns).slice(1).split('\r\n')[1];
  assert.equal(cell(1234.5), '1234.5');
  assert.equal(cell(-3), '-3');
  assert.equal(cell(true), 'Yes');
  assert.equal(pt.csv.stringify([{ a: false }], columns).split('\r\n')[1], 'Não');
  assert.equal(cell(['a', 'b']), 'a; b');
  assert.equal(cell({ path: 'files/x.png', name: 'x.png' }), 'x.png');
  assert.equal(cell('=HYPERLINK("http://evil")'), '"\'=HYPERLINK(""http://evil"")"');
  assert.equal(cell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(cell('-cmd|calc'), "'-cmd|calc");
  assert.equal(cell('+55 11 99999-0000'), '+55 11 99999-0000', 'a phone number is left alone');
  assert.equal(cell(' padded'), '" padded"');
  assert.equal(cell(undefined), '');
});

test('csv: parse reads quotes, doubled quotes, newlines inside quotes and the BOM', () => {
  const text = '\uFEFFNome,Nota\r\nAna,"diz ""oi"", depois\nsai"\r\n\r\nBruno,\r\nCarla,x';
  const parsed = plain(en.csv.parse(text));
  assert.deepEqual(parsed.header, ['Nome', 'Nota']);
  assert.deepEqual(parsed.rows, [['Ana', 'diz "oi", depois\nsai'], ['Bruno', ''], ['Carla', 'x']]);
  assert.equal(parsed.delimiter, ',');
  assert.deepEqual(plain(en.csv.parse('a,b\n1,2\n')).rows, [['1', '2']], 'LF and a trailing newline');
  assert.deepEqual(plain(en.csv.parse('a,b\r1,2\r')).rows, [['1', '2']], 'CR alone');
  assert.deepEqual(plain(en.csv.parse('a,b\n1')).rows, [['1', '']], 'short rows are padded');
  assert.deepEqual(plain(en.csv.parse('')), { header: [], rows: [], delimiter: ',' });
  assert.deepEqual(plain(en.csv.parse('a,b,c')).rows, [], 'a header and nothing else');
  assert.deepEqual(plain(en.csv.parse('a\n"x,y"\n"say ""hi"""')).rows, [['x,y'], ['say "hi"']]);
  assert.deepEqual(plain(en.csv.parse('a,b\n"",x')).rows, [['', 'x']]);
  assert.deepEqual(plain(en.csv.parse(' a , b \n1,2')).header, ['a', 'b'], 'header names are trimmed');
});

test('csv: the delimiter is found in the header line (Brazilian Excel uses ;)', () => {
  const semi = plain(en.csv.parse('Nome;Valor;Obs\nAna;1.234,50;"a;b"\nBruno;2;'));
  assert.equal(semi.delimiter, ';');
  assert.deepEqual(semi.header, ['Nome', 'Valor', 'Obs']);
  assert.deepEqual(semi.rows, [['Ana', '1.234,50', 'a;b'], ['Bruno', '2', '']]);
  const tab = plain(en.csv.parse('a\tb\n1\t2'));
  assert.equal(tab.delimiter, '\t');
  assert.deepEqual(tab.rows, [['1', '2']]);
  assert.equal(plain(en.csv.parse('"a;b",c\n1,2')).delimiter, ',', 'a delimiter inside quotes does not count');
  assert.equal(plain(en.csv.parse('single\n1')).delimiter, ',');
});

test('csv: stringify then parse round-trips, with , and with ;', () => {
  const columns = [{ key: 'name', label: 'Nome' }, { key: 'note', label: 'Nota "x"' }, { key: 'n', label: 'N' }];
  const rows = [{ name: 'Ana', note: 'a,b;c\r\nd', n: 1.5 }, { name: 'Zé "Z"', note: '', n: 0 }, { name: 'Çedilha ñ ü 日本', note: '  espaço  ', n: -2 }];
  for (const delimiter of [',', ';']) {
    const parsed = plain(en.csv.parse(en.csv.stringify(rows, columns, { delimiter })));
    assert.deepEqual(parsed.header, ['Nome', 'Nota "x"', 'N']);
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.rows, [['Ana', 'a,b;c\r\nd', '1.5'], ['Zé "Z"', '', '0'], ['Çedilha ñ ü 日本', '  espaço  ', '-2']]);
  }
});

// ---------------------------------------------------------------- H. examples

test('samples: count, daysFromToday, load and clear', async () => {
  assert.equal(en.samples.count([{ data: { _sample: true } }, { data: {} }, { data: { _sample: false } }, { data: { _sample: true } }]), 2);
  assert.equal(en.samples.count([]), 0);
  assert.equal(en.samples.count(undefined), 0);
  const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value);
  assert.ok(day(en.daysFromToday(0)) && day(en.daysFromToday(-40)) && day(en.daysFromToday(400)));
  assert.equal(en.daysFromToday(0), en.today());
  assert.equal(en.formula.evaluate('days(a, b)', { a: en.today(), b: en.daysFromToday(10) }), 10);
  assert.equal(en.formula.evaluate('days(a, b)', { a: en.daysFromToday(-40), b: en.today() }), 40);
  // against a fake collection
  const records = [];
  const collection = {
    insert: async doc => { records.push({ id: 'r' + records.length, data: doc }); },
    list: async options => records.filter(r => !options.where || r.data._sample === options.where._sample),
    remove: async id => { records.splice(records.findIndex(r => r.id === id), 1); return true; }
  };
  records.push({ id: 'mine', data: { name: 'real' } });
  assert.equal(await en.samples.load(collection, [{ name: 'a' }, { name: 'b' }, { name: 'c' }]), 3);
  assert.equal(records.length, 4);
  assert.equal(records.filter(r => r.data._sample === true).length, 3, 'each carries _sample');
  assert.equal(await en.samples.clear(collection), 3);
  assert.deepEqual(records.map(r => r.id), ['mine'], 'only the examples go');
  assert.equal(await en.samples.clear(collection), 0);
});

// ---------------------------------------------------------------- J. markdown

test('markdown: blocks', () => {
  const tree = plain(en.parseMarkdown('# Title\n\nFirst *line*\nsecond line\n\n## Sub ##\n\n- a\n- b\n  - b1\n  - b2\n- c\n\n1. one\n2. two\n\n> quoted\n> more\n\n---\n\n```js\nvar x = 1;\n\nvar y = "**no**";\n```\n\n### Third'));
  assert.deepEqual(tree.map(b => b.type), ['heading', 'paragraph', 'heading', 'list', 'list', 'quote', 'rule', 'code', 'heading']);
  assert.deepEqual([tree[0].level, tree[2].level, tree[8].level], [1, 2, 3]);
  assert.equal(tree[0].children[0].text, 'Title');
  assert.equal(tree[2].children[0].text, 'Sub', 'closing hashes are dropped');
  assert.deepEqual(tree[1].children.map(n => n.type), ['text', 'em', 'br', 'text']);
  assert.equal(tree[3].ordered, false);
  assert.equal(tree[3].items.length, 3);
  assert.equal(tree[3].items[1].sub.items.length, 2, 'one level of nesting');
  assert.equal(tree[3].items[1].sub.items[0].children[0].text, 'b1');
  assert.equal(tree[4].ordered, true);
  assert.equal(tree[4].items[1].children[0].text, 'two');
  assert.equal(tree[5].children[0].type, 'paragraph');
  assert.equal(tree[7].lang, 'js');
  assert.equal(tree[7].text, 'var x = 1;\n\nvar y = "**no**";', 'a fenced block is literal, blank line and all');
  assert.deepEqual(plain(en.parseMarkdown('')), []);
  assert.deepEqual(plain(en.parseMarkdown('\n\n  \n')), []);
  assert.equal(plain(en.parseMarkdown('#### four'))[0].type, 'paragraph', 'only three heading levels');
  assert.equal(plain(en.parseMarkdown('#nospace'))[0].type, 'paragraph');
  assert.equal(plain(en.parseMarkdown('```\nunclosed'))[0].text, 'unclosed');
  assert.equal(plain(en.parseMarkdown('3. a\n4. b'))[0].start, 3);
  assert.equal(plain(en.parseMarkdown('Text\n- item'))[1].type, 'list', 'a list can start right after a paragraph');
  assert.equal(plain(en.parseMarkdown('Written in 2026. It was a year'))[0].type, 'paragraph');
  assert.deepEqual(plain(en.parseMarkdown('- a\n\n- b')).length, 1, 'a blank line between items keeps one list');
  assert.deepEqual(plain(en.parseMarkdown('- a\n1. b')).map(b => b.type), ['list', 'list'], 'a different kind starts a new list');
  assert.equal(plain(en.parseMarkdown('> - in\n> - quote'))[0].children[0].type, 'list');
});

test('markdown: inline', () => {
  const inline = source => plain(en.parseMarkdown(source))[0].children;
  assert.deepEqual(inline('a **b** *c* `d` e').map(n => n.type), ['text', 'strong', 'text', 'em', 'text', 'code', 'text']);
  assert.equal(inline('**bold *and italic***')[0].children.map(n => n.type).join(), 'text,em');
  assert.deepEqual(inline('2 * 3 * 4'), [{ type: 'text', text: '2 * 3 * 4' }], 'a star with a space is a star');
  assert.deepEqual(inline('`**not bold**`'), [{ type: 'code', text: '**not bold**' }]);
  assert.deepEqual(inline('\\*literal\\*'), [{ type: 'text', text: '*literal*' }]);
  assert.deepEqual(inline('unclosed **bold'), [{ type: 'text', text: 'unclosed **bold' }]);
  assert.deepEqual(inline('a_b_c'), [{ type: 'text', text: 'a_b_c' }], 'underscores are plain');
  const link = inline('see [the docs](https://example.com/a?b=1) now')[1];
  assert.equal(link.type, 'link');
  assert.equal(link.href, 'https://example.com/a?b=1');
  assert.equal(link.children[0].text, 'the docs');
  assert.equal(inline('[mail](mailto:a@b.co)')[0].href, 'mailto:a@b.co');
  assert.deepEqual(inline('[[Refund policy]] and [[ Other ]]').filter(n => n.type === 'wikilink').map(n => n.title), ['Refund policy', 'Other']);
  assert.deepEqual(inline('[[]]'), [{ type: 'text', text: '[[]]' }]);
  assert.deepEqual(inline('[**bold** link](https://x.co)')[0].children.map(n => n.type), ['strong', 'text']);
  assert.ok(inline('[a [[b]] c](https://x.co)').some(n => n.type === 'wikilink'), 'a wiki link inside brackets still reads as one');
});

test('markdown: nothing unsafe survives, and HTML is only ever text', () => {
  const allowed = new Set(['text', 'strong', 'em', 'code', 'br', 'link', 'wikilink']);
  function walk(nodes, seen) {
    for (const node of nodes) {
      seen.push(node);
      if (node.children) walk(node.children, seen);
      if (node.items) for (const item of node.items) { walk(item.children, seen); if (item.sub) walk([item.sub], seen); }
    }
    return seen;
  }
  const evil = '<script>alert(1)</script>\n\n[x](javascript:alert(1)) [y](data:text/html;base64,AAAA) [z](vbscript:x) [w](//evil.example) [v](JaVaScRiPt:alert(1))\n\n<img src=x onerror=alert(1)> **<b>bold</b>**\n\n# <h1>head</h1>\n\n> <iframe src=x></iframe>\n\n- <a href="javascript:1">li</a>';
  const tree = plain(en.parseMarkdown(evil));
  const all = walk(tree, []);
  for (const node of all) {
    if (node.type === 'link') assert.match(node.href, /^(https?:|mailto:)/i, node.href);
  }
  assert.equal(all.filter(n => n.type === 'link').length, 0, 'every unsafe link stayed text');
  assert.deepEqual(tree[0].children, [{ type: 'text', text: '<script>alert(1)</script>' }], 'a script tag is just text');
  const text = all.filter(n => n.type === 'text').map(n => n.text).join('');
  assert.ok(text.includes('<script>alert(1)</script>'));
  assert.ok(text.includes('<img src=x onerror=alert(1)>'));
  assert.ok(text.includes('[x](javascript:alert(1))'), 'the link text stays visible as written');
  assert.ok(all.every(n => !n.type || allowed.has(n.type) || ['heading', 'paragraph', 'list', 'quote', 'rule', 'code'].includes(n.type)));
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|outerHTML/.test(KIT_JS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'the kit never writes HTML from strings');
});

test('markdown: markdownOutline lists headings with unique anchors', () => {
  const outline = plain(en.markdownOutline('# Intro\n\ntext\n\n## Steps\n\n## Steps\n\n### Ação & reação'));
  assert.deepEqual(outline, [
    { level: 1, text: 'Intro', anchor: 'intro' },
    { level: 2, text: 'Steps', anchor: 'steps' },
    { level: 2, text: 'Steps', anchor: 'steps_2' },
    { level: 3, text: 'Ação & reação', anchor: 'acao_reacao' }
  ]);
  assert.equal(plain(en.parseMarkdown('# A\n\n## B'))[1].anchor, 'b');
});

// ---------------------------------------------------------------- K. small things

test('kit v2: the public surface', () => {
  assert.equal(en.version, 2);
  assert.equal(en.minor, 1, 'kit 2.1');
  for (const name of ['fold', 'download', 'daysFromToday', 'parseNumber', 'parseRoute', 'context', 'mergeContext', 'settings', 'mergeSettings', 'slug', 'fieldValue', 'fieldText', 'validate', 'compute', 'parseMarkdown', 'markdown', 'markdownOutline']) {
    assert.equal(typeof en[name], 'function', name);
  }
  for (const group of [['route', ['get', 'open', 'close', 'on']], ['formula', ['compile', 'evaluate']], ['csv', ['stringify', 'parse', 'download', 'delimiter']], ['samples', ['load', 'clear', 'count']]]) {
    for (const name of group[1]) assert.equal(typeof en[group[0]][name], 'function', `${group[0]}.${name}`);
  }
  assert.equal(en.fold('Ação ÉLAN'), 'acao elan');
  assert.deepEqual(plain(en.fieldTypes), ['text', 'longtext', 'number', 'money', 'date', 'datetime', 'time', 'choice', 'multi', 'checkbox', 'image', 'file', 'url', 'email', 'phone', 'formula']);
  for (const icon of ['image', 'grid', 'check-square', 'calculator', 'scale', 'book', 'map-pin', 'map', 'help', 'repeat', 'play', 'clipboard', 'filter', 'external', 'copy', 'drag', 'arrow-left', 'arrow-right', 'chevron-down', 'file', 'bell']) {
    assert.ok(en.icons.includes(icon), icon);
  }
  for (const icon of ['board', 'table', 'calendar', 'chart', 'settings', 'chevronLeft', 'arrowUp']) assert.ok(en.icons.includes(icon), `${icon} is kept`);
});

test('kit v2: every string exists in English and in Portuguese', () => {
  const source = KIT_JS;
  const table = lang => {
    const start = source.indexOf(`    ${lang}: {`);
    const end = source.indexOf('\n    }', start) > 0 && lang === 'en' ? source.indexOf('    pt: {') : source.indexOf('\n  };', start);
    return new Set([...source.slice(start, end).matchAll(/(?:^|[\s,{])'?([A-Za-z_]+)'?: '/g)].map(m => m[1]));
  };
  const english = table('en'), portuguese = table('pt');
  assert.deepEqual([...english].filter(k => !portuguese.has(k)), [], 'in English only');
  assert.deepEqual([...portuguese].filter(k => !english.has(k)), [], 'in Portuguese only');
  // and every key the code asks for exists
  const code = source.replace(/STRINGS = \{[\s\S]*?\n  \};/, '');
  const used = new Set();
  for (const m of code.matchAll(/\bt\('([A-Za-z_]+)'\)|\btf\('([A-Za-z_]+)'|formulaError\('([A-Za-z_]+)'/g)) used.add(m[1] || m[2] || m[3]);
  for (const m of code.matchAll(/'(\w+(?:One|Many))',\s*'(\w+(?:One|Many))'/g)) { used.add(m[1]); used.add(m[2]); }
  for (const type of en.fieldTypes) used.add(`type_${type}`);
  for (const tone of ['none', 'accent', 'ok', 'warn', 'danger', 'info', 'violet']) used.add(`tone_${tone}`);
  for (const extra of ['chooseImage', 'choosePdf']) used.add(extra);
  assert.deepEqual([...used].filter(k => !english.has(k)), [], 'used but not defined');
  assert.equal(pt.t('required'), 'Obrigatório');
  assert.equal(pt.t('type_money'), 'Dinheiro');
  assert.equal(en.t('type_money'), 'Money');
});

// ================================================================ kit v2.1

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A very small DOM: enough for tkit.h, tkit.copy and tkit.search.highlight to run in Node. */
class FakeNode {}
function fakeDom(extra = {}, lang = 'en') {
  function element(tag) {
    const el = new FakeNode();
    Object.assign(el, {
      tagName: tag, attrs: {}, children: [], style: {}, dataset: {}, className: '', textContent: '', listeners: {},
      setAttribute(name, value) { this.attrs[name] = String(value); },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); return child; },
      select() {}, focus() {}
    });
    return el;
  }
  const document = {
    documentElement: { lang }, readyState: 'complete', addEventListener() {}, title: 'My app', activeElement: null,
    createElement: element, createDocumentFragment: () => element('#fragment'),
    createTextNode: value => Object.assign(new FakeNode(), { text: String(value) }),
    body: element('body'), execCommand: () => false, ...extra
  };
  // Long timers (toasts) must not keep the test process alive.
  const timers = (fn, ms, ...rest) => (ms > 1000 ? 0 : setTimeout(fn, ms, ...rest));
  return { document, Node: FakeNode, setTimeout: timers };
}

test('time: fieldValue reads how people write a time', () => {
  const field = { id: 'at', type: 'time' };
  for (const [typed, stored] of [['9h30', '09:30'], ['9:30', '09:30'], ['0930', '09:30'], ['930', '09:30'], ['09:30', '09:30'], ['9h', '09:00'], ['9', '09:00'], ['18', '18:00'], ['23:59', '23:59'], ['00:00', '00:00'], ['09:30:15', '09:30'], ['9:30pm', '21:30'], ['12am', '00:00'], ['12:15 PM', '12:15'], ['7.05', '07:05'], [' 7h05 ', '07:05']]) {
    assert.equal(pt.fieldValue(field, typed), stored, typed);
  }
  assert.equal(pt.fieldValue(field, ''), null);
  assert.equal(pt.fieldValue(field, undefined), null);
  for (const bad of ['25:00', '9:60', '24:00', 'noon', '13pm', '0am', '99']) assert.equal(pt.fieldValue(field, bad), bad, `${bad} is kept so validate can say so`);
});

test('time: fieldText follows the language and validate checks 00:00 to 23:59', () => {
  const field = { id: 'at', type: 'time' };
  assert.equal(pt.fieldText(field, '09:30'), '09:30');
  assert.equal(pt.fieldText(field, '21:05'), '21:05');
  assert.equal(pt.fieldText(field, '9h5'), '9h5', 'what is not a time shows as it is');
  assert.equal(en.fieldText(field, '09:30').replace(/\s/g, ' '), '9:30 AM');
  assert.equal(en.fieldText(field, '21:05').replace(/\s/g, ' '), '9:05 PM');
  assert.equal(en.fieldText(field, null), '');
  assert.equal(en.fieldText(field, 'later'), 'later', 'what is not a time shows as it is');
  assert.ok(pt.validate([field], { at: '00:00' }).ok && pt.validate([field], { at: '23:59' }).ok);
  assert.equal(pt.validate([field], { at: '24:00' }).errors.at, 'Hora inválida');
  assert.equal(en.validate([field], { at: '12:60' }).errors.at, 'Not a valid time');
  assert.equal(pt.validate([field], { at: '9:30' }).ok, false, 'stored values are HH:MM');
  assert.equal(pt.validate([field], {}).ok, true);
  assert.equal(pt.validate([{ ...field, required: true }], {}).errors.at, 'Obrigatório');
  assert.ok(en.fieldTypes.includes('time'));
  assert.equal(pt.t('type_time'), 'Hora');
  // a time can be used in a formula as text
  assert.equal(en.formula.evaluate('a & "!"', { a: '09:30' }), '09:30!');
});

test('search: match finds every word, folded, and maps back to the original text', () => {
  assert.deepEqual(plain(en.search.match('Café com Leite', 'cafe leite')), [[0, 4], [9, 14]]);
  assert.deepEqual(plain(en.search.match('Café com Leite', 'CAFÉ')), [[0, 4]]);
  assert.equal(en.search.match('Café com Leite', 'cafe pao'), null, 'every word must be there');
  assert.equal(en.search.match('abc', ''), null);
  assert.equal(en.search.match('abc', '   '), null);
  assert.equal(en.search.match('', 'a'), null);
  assert.equal(en.search.match(undefined, 'a'), null);
  assert.deepEqual(plain(en.search.match('abc abc', 'ab')), [[0, 2], [4, 6]], 'all occurrences');
  assert.deepEqual(plain(en.search.match('abcd', 'ab bc cd')), [[0, 4]], 'overlaps merge');
  assert.deepEqual(plain(en.search.match('한글 abc', 'abc')), [[3, 6]], 'folding can change the length: ranges still index the original');
  assert.deepEqual(plain(en.search.match('Ação e reação', 'acao reacao')), [[0, 4], [7, 13]]);
});

test('search: snippet cuts around the first match', () => {
  const long = 'word '.repeat(60) + 'the needle is here ' + 'word '.repeat(60);
  const ranges = en.search.match(long, 'needle');
  const snippet = en.search.snippet(long, ranges);
  assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), snippet);
  assert.ok(snippet.includes('needle'));
  assert.ok(snippet.length <= 164, String(snippet.length));
  assert.ok(en.search.snippet(long, ranges, 40).length <= 44);
  assert.equal(en.search.snippet('short text', en.search.match('short text', 'text')), 'short text', 'nothing cut: no dots');
  assert.equal(en.search.snippet('abc', null), '');
  assert.equal(en.search.snippet('abc', []), '');
  const early = en.search.snippet('needle at the very start ' + 'x '.repeat(200), en.search.match('needle at the very start ' + 'x '.repeat(200), 'needle'));
  assert.ok(early.startsWith('needle') && early.endsWith('…'));
});

test('search: highlight wraps the ranges in <mark> using nodes only', () => {
  const dom = fakeDom();
  const kit = loadKit('en', dom);
  const fragment = kit.search.highlight('Café com Leite', kit.search.match('Café com Leite', 'leite cafe'));
  const parts = fragment.children.map(node => (node.tagName === 'mark' ? ['mark', node.textContent] : ['text', node.text]));
  assert.deepEqual(parts, [['mark', 'Café'], ['text', ' com '], ['mark', 'Leite']]);
  const plainOnly = kit.search.highlight('nothing', null);
  assert.deepEqual(plainOnly.children.map(node => node.text), ['nothing']);
  const evil = kit.search.highlight('<b>x</b>', kit.search.match('<b>x</b>', 'x'));
  assert.equal(evil.children.map(node => node.text || node.textContent).join(''), '<b>x</b>', 'markup stays text');
});

test('csv: columnsFor turns a schema into columns, with numbers, dates and choices ready for a spreadsheet', () => {
  const fields = [
    { id: 'name', label: 'Nome', type: 'text' }, { id: 'stage', label: 'Etapa', type: 'choice', options: [{ id: 'won', label: 'Ganho' }] },
    { id: 'tags', label: 'Tags', type: 'multi', options: [{ id: 'a', label: 'Alfa' }, { id: 'b', label: 'Beta' }] },
    { id: 'price', label: 'Preço', type: 'money' }, { id: 'qty', label: 'Qtd', type: 'number' }, { id: 'due', label: 'Prazo', type: 'date' },
    { id: 'at', label: 'Hora', type: 'time' }, { id: 'paid', label: 'Pago', type: 'checkbox' }, { id: 'photo', label: 'Foto', type: 'image' },
    { id: 'total', label: 'Total', type: 'formula', formula: 'price * qty' }, { id: 'note', label: 'Nota', type: 'longtext' }
  ];
  const columns = pt.csv.columnsFor(fields, { currency: 'BRL' });
  assert.deepEqual(plain(columns.map(c => [c.key, c.label])), fields.map(f => [f.id, f.label]));
  const row = pt.compute(fields, { name: 'Ana', stage: 'won', tags: ['a', 'b'], price: 0.1, qty: 3, due: '2026-11-03', at: '09:30', paid: true, photo: { path: 'files/a.png', name: 'foto.png' }, note: 'a\nb' });
  const text = pt.csv.stringify([row], columns, { delimiter: pt.csv.delimiter() });
  const parsed = pt.csv.parse(text);
  assert.deepEqual(plain(parsed.header), fields.map(f => f.label));
  assert.deepEqual(plain(parsed.rows[0]), ['Ana', 'Ganho', 'Alfa; Beta', '0.1', '3', '2026-11-03', '09:30', 'Sim', 'foto.png', '0.3', 'a\nb'], '"." decimals, ISO dates, labels, file names, no float noise');
  const empty = pt.csv.stringify([{}], columns);
  assert.equal(pt.csv.parse(empty).rows[0].every(cell => cell === ''), true, 'missing values are empty cells');
  const unchecked = pt.csv.parse(pt.csv.stringify([{ paid: false }], columns)).rows[0][7];
  assert.equal(unchecked, 'Não');
  assert.deepEqual(plain(pt.csv.columnsFor(undefined)), []);
  assert.equal(pt.csv.stringify([{ name: '=HYPERLINK("x")' }], columns.slice(0, 1)).includes("'=HYPERLINK"), true, 'formula-looking text is still defused');
});

test('csv: filename is "<app> - <name> - date.csv" without characters a file cannot have', () => {
  assert.equal(pt.csv.filename('Meu app', 'Cartões', '2026-11-11'), 'Meu app - Cartões - 2026-11-11.csv');
  assert.equal(pt.csv.filename('A/B: C', 'x?*', '2026-11-11'), 'A B C - x - 2026-11-11.csv');
  assert.equal(pt.csv.filename('', 'Cartões', '2026-11-11'), 'Cartões - 2026-11-11.csv');
  assert.equal(pt.csv.filename('App', undefined, '2026-11-11'), 'App - 2026-11-11.csv');
  assert.equal(pt.csv.filename('App', 'Lista', undefined), `App - Lista - ${pt.today()}.csv`);
});

test('table footer: sum, avg, count, text and functions over the rows given', () => {
  const columns = [{ key: 'name', label: 'Name' }, { key: 'amount', label: 'Amount', type: 'money', currency: 'USD' }, { key: 'qty', label: 'Qty', type: 'number' }, { key: 'date', label: 'Date', type: 'date' }, { key: 'note' }];
  const rows = [{ name: 'a', amount: 1000, qty: 1, date: '2026-11-01' }, { name: 'b', amount: '2500.5', qty: 2, date: '' }, { name: 'c', amount: null, qty: '3', date: '2026-11-03' }, { name: 'd', amount: 'n/a', qty: true }];
  const cells = plain(en.tableFooter(columns, { name: 'Total', amount: 'sum', qty: 'avg', date: 'count', note: rows2 => `${rows2.length} rows` }, rows));
  assert.deepEqual(cells.map(c => c.key), ['name', 'amount', 'qty', 'date', 'note']);
  assert.equal(cells[0].value, 'Total');
  assert.equal(cells[1].value, '$3,500.50', 'money with its column currency; text numbers count, "n/a" and null do not');
  assert.equal(cells[2].value, '2', 'avg of 1, 2 and "3"; true is not a number');
  assert.equal(cells[3].value, '2', 'count: rows with a value');
  assert.equal(cells[4].value, '4 rows');
  assert.deepEqual(cells.map(c => c.num), [false, true, true, false, false]);
  const none = plain(en.tableFooter(columns, { amount: 'sum', qty: 'avg' }, [{ amount: null }]));
  assert.equal(none[1].value, '', 'no numbers: nothing to show');
  assert.equal(none[0].value, '', 'a column with no spec is empty');
  assert.equal(pt.tableFooter([{ key: 'v', type: 'number' }], { v: 'sum' }, [{ v: 1234.5 }, { v: 1 }])[0].value, '1.235,5', 'numbers follow the language');
  assert.equal(plain(en.tableFooter([{ key: 'v' }], { v: 'sum' }, []))[0].value, '');
  assert.deepEqual(plain(en.tableFooter(undefined, {}, [])), []);
});

test('calendar: weekdayGrid drops Saturday and Sunday and hands their dates to a Friday', () => {
  for (const weekStart of [0, 1, 6]) {
    const cells = plain(en.weekdayGrid(2026, 11, weekStart));
    assert.equal(cells.length, 30, `six weeks of five days (week starts on ${weekStart})`);
    assert.ok(cells.every(c => c.weekday >= 1 && c.weekday <= 5));
    const owners = cells.filter(c => c.weekend.length);
    assert.ok(owners.every(c => c.weekday === 5), 'only Fridays hold weekend dates');
    const handed = owners.flatMap(c => c.weekend).sort();
    assert.equal(handed.length, 12, 'six Saturdays and six Sundays, none lost');
    assert.equal(new Set(handed).size, 12);
  }
  const monday = plain(en.weekdayGrid(2026, 11, 1));
  assert.equal(monday[0].date, '2026-10-26');
  const friday = monday.find(c => c.date === '2026-11-06');
  assert.deepEqual(friday.weekend, ['2026-11-07', '2026-11-08'], 'Saturday and Sunday belong to the Friday before them');
  assert.equal(monday.filter(c => c.today).length, en.today().startsWith('2026-11') || en.today() >= '2026-10-26' && en.today() <= '2026-12-04' ? 1 : 0);
  const sunday = plain(en.weekdayGrid(2026, 11, 0));
  assert.equal(sunday[0].date, '2026-11-02', 'the grid starts on a Sunday, which is dropped');
  assert.deepEqual(sunday.find(c => c.date === '2026-11-06').weekend, ['2026-11-01', '2026-11-07', '2026-11-08'], 'a Sunday with no Friday before it in the grid uses the one after');
  assert.equal(plain(en.monthGrid(2026, 11, 1)).length, 42, 'monthGrid is untouched');
});

test('textarea: wrapEdit and prefixEdit say what to write', () => {
  const wrap = en.textarea.wrapEdit;
  assert.deepEqual(plain(wrap('hello world', 6, 11, '**', '**')), { from: 6, to: 11, insert: '**world**', selFrom: 8, selTo: 13 });
  assert.deepEqual(plain(wrap('hello ', 6, 6, '**', '**', 'text')), { from: 6, to: 6, insert: '**text**', selFrom: 8, selTo: 12 }, 'nothing selected: the placeholder, selected');
  assert.deepEqual(plain(wrap('', 0, 0, '[[', ']]')), { from: 0, to: 0, insert: '[[]]', selFrom: 2, selTo: 2 }, 'no placeholder: the caret goes between');
  const prefix = en.textarea.prefixEdit;
  assert.deepEqual(plain(prefix('one\ntwo\nthree', 5, 5, '- ')), { from: 4, to: 7, insert: '- two', selFrom: 4, selTo: 9 }, 'the line with the caret');
  assert.equal(prefix('one\ntwo\nthree', 0, 13, '- ').insert, '- one\n- two\n- three');
  assert.equal(prefix('- one\n- two', 0, 11, '- ').insert, 'one\ntwo', 'all have it: take it off');
  assert.equal(prefix('- one\ntwo', 0, 9, '- ').insert, '- one\n- two', 'mixed: add to the ones without');
  assert.equal(prefix('a\n\nb', 0, 4, '> ').insert, '> a\n\n> b', 'blank lines in a block are left alone');
  assert.equal(prefix('one\ntwo\n', 0, 8, '# ').insert, '# one\n# two', 'a selection ending after a newline does not take the next line');
  assert.deepEqual(plain(prefix('', 0, 0, '- ')), { from: 0, to: 0, insert: '- ', selFrom: 0, selTo: 2 });
  assert.equal(typeof en.textarea.wrap, 'function');
  assert.equal(typeof en.textarea.prefixLines, 'function');
});

test('autosave: debounces, saves one at a time, holds reloads while dirty and reports its status', async () => {
  const holds = [];
  const kit = loadKit('en', { tendly: { host: { holdReload: on => holds.push(on) } } });
  let calls = 0, running = 0, overlap = false;
  const statuses = [];
  const saver = kit.autosave(async () => { calls++; running++; if (running > 1) overlap = true; await sleep(25); running--; }, { delay: 30, onStatus: status => statuses.push(status) });
  assert.equal(saver.status, 'idle');
  saver.touch(); saver.touch(); saver.touch();
  assert.equal(saver.status, 'typing');
  assert.deepEqual(holds, [true, true, true]);
  await sleep(15);
  assert.equal(calls, 0, 'not before the delay');
  await sleep(120);
  assert.equal(calls, 1, 'three touches, one save');
  assert.equal(saver.status, 'saved');
  assert.equal(holds.at(-1), false, 'reloads are free again');
  assert.deepEqual(statuses.filter((s, i) => s !== statuses[i - 1]), ['typing', 'saving', 'saved']);
  // typing during a save: a second save follows, never two at once
  saver.touch();
  await sleep(45); // the save started at 30 and takes 25
  assert.equal(saver.status, 'saving');
  saver.touch();
  await saver.flush();
  assert.equal(calls, 3);
  assert.equal(overlap, false);
  assert.equal(saver.status, 'saved');
  assert.equal(holds.at(-1), false);
  await saver.flush(); // nothing pending: resolves at once
  assert.equal(calls, 3);
});

test('autosave: a failed save stays dirty and is tried again', async () => {
  const holds = [];
  const kit = loadKit('en', { tendly: { host: { holdReload: on => holds.push(on) } } });
  let calls = 0;
  const seen = [];
  const saver = kit.autosave(() => { calls++; if (calls === 1) throw new Error('offline'); if (calls === 2) return Promise.reject(new Error('still offline')); }, { delay: 5, onStatus: (status, error) => seen.push([status, error && error.message]) });
  saver.touch();
  await saver.flush();
  assert.equal(saver.status, 'error');
  assert.equal(saver.error.message, 'offline');
  assert.deepEqual(seen.at(-1), ['error', 'offline']);
  assert.equal(holds.at(-1), true, 'the text is not saved: reloads stay held');
  await saver.flush();
  assert.equal(saver.status, 'error', 'a rejected promise is an error too');
  await saver.flush();
  assert.equal(saver.status, 'saved');
  assert.equal(calls, 3);
  assert.equal(holds.at(-1), false);
  // without the SDK or options it still works
  const bare = en.autosave(() => {});
  bare.touch();
  await bare.flush();
  assert.equal(bare.status, 'saved');
});

test('copy: the Clipboard API first, a hidden textarea when it fails, and a toast on success', async () => {
  const written = [];
  const dom = fakeDom();
  const withApi = loadKit('en', { ...dom, navigator: { language: 'en', clipboard: { writeText: async value => { written.push(value); } } } });
  assert.equal(await withApi.copy('hello'), true);
  assert.deepEqual(written, ['hello']);
  const toasts = dom.document.body.children.flatMap(region => region.children).map(node => node.textContent);
  assert.deepEqual(toasts, ['Copied']);

  const dom2 = fakeDom({}, 'pt-BR');
  dom2.document.execCommand = command => command === 'copy';
  let created;
  const original = dom2.document.createElement;
  dom2.document.createElement = tag => { const el = original(tag); if (tag === 'textarea') created = el; return el; };
  const fallback = loadKit('pt-BR', { ...dom2, navigator: { language: 'pt-BR', clipboard: { writeText: async () => { throw new Error('blocked'); } } } });
  assert.equal(await fallback.copy(42), true);
  assert.equal(created.value, '42', 'the text went through the textarea');
  assert.equal(dom2.document.body.children.at(-1).children.at(-1).textContent, 'Copiado');

  const dom3 = fakeDom();
  const failing = loadKit('en', { ...dom3, navigator: { language: 'en' } });
  assert.equal(await failing.copy('x'), false, 'no API and execCommand refuses');
  const noDom = loadKit('en', { navigator: undefined });
  assert.equal(await noDom.copy('x'), false, 'no document at all: false, no throw');
});

test('h: for t-* tags every prop is an attribute; other tags keep text as textContent', () => {
  const kit = loadKit('en', fakeDom());
  const state = kit.h('t-state', { kind: 'empty', title: 'Nothing here', text: 'Add the first one.', hidden: true, class: 'a b', dataset: { x: '1' }, 'aria-label': 'L', onClick() {}, tabindex: 0 });
  assert.equal(state.tagName, 't-state');
  assert.deepEqual(plain(state.attrs), { kind: 'empty', title: 'Nothing here', text: 'Add the first one.', hidden: '', 'aria-label': 'L', tabindex: '0' });
  assert.equal(state.textContent, '', 'text did not become text content');
  assert.equal(state.className, 'a b');
  assert.equal(state.dataset.x, '1');
  assert.equal(typeof state.listeners.click, 'function');
  const span = kit.h('span', { text: 'hello', class: 'x', title: 'tip' });
  assert.equal(span.textContent, 'hello', 'a plain tag keeps text -> textContent');
  assert.equal(span.attrs.text, undefined);
  assert.equal(span.attrs.title, 'tip');
  const skipped = kit.h('t-state', { kind: undefined, text: null, title: false });
  assert.deepEqual(plain(skipped.attrs), {}, 'undefined, null and false are left out');
  const withChildren = kit.h('t-state', { kind: 'empty' }, 'child', kit.h('button'));
  assert.equal(withChildren.children.length, 2);
  const list = kit.h('t-list-editor', { tones: true });
  assert.equal(list.attrs.tones, '');
  const style = kit.h('t-card', { style: { color: 'red' } });
  assert.equal(style.style.color, 'red', 'a style object is still a style');
  const prop = kit.h('t-calendar', { events: [{ id: 1 }] });
  assert.equal(Array.isArray(prop.events) || prop.attrs.events === '[object Object]', true, 'objects are never turned into attributes on purpose');
  assert.equal(kit.h('t-progress', { value: 3, max: 10 }).attrs.value, '3');
});

test('kit 2.1: the public surface, the elements and the strings', () => {
  assert.equal(en.minor, 1);
  assert.equal(en.version, 2, 'the version number stays');
  for (const name of ['copy', 'autosave', 'tableFooter', 'weekdayGrid']) assert.equal(typeof en[name], 'function', name);
  for (const group of [['search', ['match', 'highlight', 'snippet']], ['textarea', ['wrap', 'prefixLines', 'wrapEdit', 'prefixEdit']], ['csv', ['columnsFor', 'filename']]]) {
    for (const name of group[1]) assert.equal(typeof en[group[0]][name], 'function', `${group[0]}.${name}`);
  }
  for (const tag of ['t-data-tools', 't-empty-start']) assert.ok(KIT_JS.includes(`define('${tag}'`), tag);
  for (const word of ['hide-weekends', 'columnMeta', 'creatable', 't-option-added', 'beforeInsert', 'beforeExamples', 'exportRows', 'extra']) assert.ok(KIT_JS.includes(word), word);
  assert.match(KIT_JS, /KIT v2\.1/);
  const header = KIT_JS.slice(0, KIT_JS.indexOf('(function () {'));
  for (const documented of ['t-data-tools', 't-empty-start', 'tkit.copy', 'tkit.csv.columnsFor', 'tkit.search.match', 'tkit.autosave', 'tkit.textarea.wrap', 'footer', 'columnMeta', 'hide-weekends', 'extra', 'creatable', 'tkit.h(\'t-state\'']) {
    assert.ok(header.includes(documented), `the header comment documents ${documented}`);
  }
  for (const key of ['badTime', 'newOption', 'newOptionName', 'copied', 'weekendMore', 'exportCsv', 'importCsv', 'seeExamples', 'dangerTitle', 'deleteAll']) {
    assert.notEqual(en.t(key), key, `en ${key}`);
    assert.notEqual(pt.t(key), key, `pt ${key}`);
    assert.notEqual(en.t(key), pt.t(key), `${key} is translated`);
  }
  assert.equal(pt.t('seeExamples'), 'Ver com exemplos');
  assert.equal(pt.t('weekendMore'), '+ fim de semana');
  assert.equal(pt.t('newOption'), 'Nova opção…');
  assert.equal(pt.t('copied'), 'Copiado');
});
