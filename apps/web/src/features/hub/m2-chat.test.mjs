import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  addConversationChip, conversationChips, conversationLink, insertAt, parseConversationLink, pastedConversation,
  removeConversationChip, restoreConversationChips, takeConversationChips, withConversations,
} from './conversation-link.ts';
import { DICTATION_ERRORS, NOTICE_KEY, browserRecognizer, createDictation, speechLang } from './dictation.ts';

const ORIGIN = 'http://127.0.0.1:7500';
const ID = '3f2b8c1e-9a4d-4e2f-8b7a-1c2d3e4f5a6b';

test('a conversation link is a same-origin /session/<id>, a ?chat=<id>, or a bare id', () => {
  assert.deepEqual(parseConversationLink(`${ORIGIN}/session/${ID}`, ORIGIN), { id: ID, bare: false });
  assert.deepEqual(parseConversationLink(`  ${ORIGIN}/session/${ID.toUpperCase()}?x=1#end `, ORIGIN), { id: ID, bare: false });
  assert.deepEqual(parseConversationLink(`${ORIGIN}/mesa?chat=${ID}`, ORIGIN), { id: ID, bare: false });
  assert.deepEqual(parseConversationLink(ID, ORIGIN), { id: ID, bare: true });
  assert.equal(conversationLink(ID, ORIGIN), `${ORIGIN}/session/${ID}`);
  assert.deepEqual(parseConversationLink(conversationLink(ID, ORIGIN), ORIGIN), { id: ID, bare: false });
});

test('other origins, other paths and prose are pasted as they are', () => {
  assert.equal(parseConversationLink(`https://evil.example/session/${ID}`, ORIGIN), undefined);
  assert.equal(parseConversationLink(`http://127.0.0.1:9999/session/${ID}`, ORIGIN), undefined);
  assert.equal(parseConversationLink(`${ORIGIN}/files/${ID}`, ORIGIN), undefined);
  assert.equal(parseConversationLink(`${ORIGIN}/session/not-an-id`, ORIGIN), undefined);
  assert.equal(parseConversationLink(`see ${ORIGIN}/session/${ID}`, ORIGIN), undefined);
  assert.equal(parseConversationLink(`${ID} and more`, ORIGIN), undefined);
  assert.equal(parseConversationLink('', ORIGIN), undefined);
  assert.equal(parseConversationLink('javascript:alert(1)', ORIGIN), undefined);
});

test('a pasted link becomes a chip once, never the conversation itself, and unknown ids paste as text', async () => {
  const key = 'test-paste', titles = { [ID]: 'Pricing talk' };
  const lookup = async id => titles[id];
  const first = await pastedConversation(`${ORIGIN}/session/${ID}`, { origin: ORIGIN, key, lookup });
  assert.deepEqual(first, { kind: 'added', ref: { id: ID, title: 'Pricing talk' } });
  assert.equal((await pastedConversation(ID, { origin: ORIGIN, key, lookup })).kind, 'present');
  assert.deepEqual(conversationChips(key), [{ id: ID, title: 'Pricing talk' }]);
  assert.deepEqual(await pastedConversation(`${ORIGIN}/session/${ID}`, { origin: ORIGIN, key: 'own', self: ID, lookup }), { kind: 'self' });
  assert.deepEqual(conversationChips('own'), []);
  assert.equal(addConversationChip('own', { id: ID, title: 'x' }, ID), 'self');
  const other = '11111111-2222-4333-8444-555555555555';
  assert.deepEqual(await pastedConversation(other, { origin: ORIGIN, key, lookup }), { kind: 'unknown', text: other });
  assert.deepEqual(await pastedConversation(other, { origin: ORIGIN, key, lookup: async () => { throw new Error('offline'); } }), { kind: 'unknown', text: other });
  assert.deepEqual(await pastedConversation('hello', { origin: ORIGIN, key, lookup }), { kind: 'none' });
  removeConversationChip(key, ID);
  assert.deepEqual(conversationChips(key), []);
});

test('on send the message asks the agent to read each conversation, without its transcript', () => {
  const key = 'test-send';
  addConversationChip(key, { id: ID, title: 'Pricing\n talk' });
  const refs = takeConversationChips(key);
  assert.deepEqual(conversationChips(key), []);
  const message = withConversations('  Summarize it ', refs);
  assert.equal(message, `Summarize it\n\nContext: read the Tendly conversation “Pricing talk” (session id ${ID}) with the tendly_read_conversation tool before answering.`);
  assert.equal(withConversations('plain', []), 'plain');
  assert.ok(withConversations('', refs).startsWith('Context: '));
  restoreConversationChips(key, refs);
  assert.equal(conversationChips(key).length, 1);
  takeConversationChips(key);
});

test('inserted text goes at the caret, spaced from the word before it', () => {
  assert.deepEqual(insertAt('hello', 5, 5, 'world'), { value: 'hello world', caret: 11 });
  assert.deepEqual(insertAt('', 0, 0, 'hi'), { value: 'hi', caret: 2 });
  assert.deepEqual(insertAt('a  b', 2, 2, 'x'), { value: 'a x b', caret: 3 });
  assert.deepEqual(insertAt('pick ONE here', 5, 8, 'two'), { value: 'pick two here', caret: 8 });
});

/** A stand-in for SpeechRecognition that the test drives by hand. */
function fakeRecognizers() {
  const made = [];
  const create = () => {
    const recognizer = {
      lang: '', continuous: false, interimResults: false, onresult: null, onerror: null, onend: null,
      started: 0, stopped: 0, aborted: 0,
      start() { this.started++; }, stop() { this.stopped++; }, abort() { this.aborted++; },
      say(results, resultIndex = 0) { this.onresult?.({ resultIndex, results: results.map(([text, isFinal]) => ({ isFinal, 0: { transcript: text } })) }); },
      fail(error) { this.onerror?.({ error }); },
      end() { this.onend?.(); },
    };
    made.push(recognizer);
    return recognizer;
  };
  return { create, made };
}
const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map }; };

test('first use shows the notice; Got it remembers it and starts listening', () => {
  const { create, made } = fakeRecognizers(), storage = memory(), finals = [];
  const dictation = createDictation({ lang: () => 'pt-BR', onFinal: text => finals.push(text), create, storage });
  assert.equal(dictation.supported, true);
  dictation.toggle();
  assert.equal(dictation.notice.value, true);
  assert.equal(made.length, 0, 'nothing listens before the notice is acknowledged');
  dictation.acknowledge();
  assert.equal(storage.map.get(NOTICE_KEY), '1');
  assert.equal(dictation.notice.value, false);
  assert.equal(dictation.listening.value, true);
  const [r] = made;
  assert.equal(r.lang, 'pt-BR'); assert.equal(r.continuous, true); assert.equal(r.interimResults, true);
  // Next time, no notice.
  dictation.stop(); r.end();
  dictation.toggle();
  assert.equal(dictation.notice.value, false);
  assert.equal(made.length, 2);
});

test('interim words show while speaking and final phrases are handed over; stop settles on end', () => {
  const { create, made } = fakeRecognizers(), finals = [];
  const dictation = createDictation({ lang: () => 'en-US', onFinal: text => finals.push(text), create, storage: memory({ [NOTICE_KEY]: '1' }) });
  dictation.toggle();
  const [r] = made;
  r.say([['olá mun', false]]);
  assert.equal(dictation.interim.value, 'olá mun');
  r.say([[' olá mundo ', true], ['tudo', false]]);
  assert.deepEqual(finals, ['olá mundo']);
  assert.equal(dictation.interim.value, 'tudo');
  r.say([[' olá mundo ', true], ['tudo bem', true]], 1);
  assert.deepEqual(finals, ['olá mundo', 'tudo bem']);
  assert.equal(dictation.interim.value, '');
  // The browser ends a session on silence: it is started again while wanted.
  r.end();
  assert.equal(r.started, 2);
  assert.equal(dictation.listening.value, true);
  dictation.toggle();
  assert.equal(r.stopped, 1);
  assert.equal(dictation.listening.value, true, 'stop() still delivers what was heard, until the end event');
  r.end();
  assert.equal(dictation.listening.value, false);
  assert.equal(r.started, 2);
});

test('a denied permission or missing microphone stops with an explanation; silence does not', () => {
  const { create, made } = fakeRecognizers();
  const dictation = createDictation({ lang: () => 'pt-BR', onFinal() {}, create, storage: memory({ [NOTICE_KEY]: '1' }) });
  dictation.start();
  made[0].fail('no-speech');
  assert.equal(dictation.error.value, '');
  made[0].fail('not-allowed'); made[0].end();
  assert.equal(dictation.error.value, 'denied');
  assert.equal(dictation.listening.value, false);
  assert.equal(made[0].started, 1, 'not restarted after an error');
  assert.match(DICTATION_ERRORS.denied, /Allow it/);
  dictation.start();
  assert.equal(dictation.error.value, '', 'trying again clears the error');
  made[1].fail('audio-capture'); made[1].end();
  assert.equal(dictation.error.value, 'no-microphone');
  dictation.dismissError();
  assert.equal(dictation.error.value, '');
});

test('dispose aborts and ignores whatever the recognizer says afterwards', () => {
  const { create, made } = fakeRecognizers(), finals = [];
  const dictation = createDictation({ lang: () => 'pt-BR', onFinal: text => finals.push(text), create, storage: memory({ [NOTICE_KEY]: '1' }) });
  dictation.start();
  const [r] = made, { onresult } = r;
  dictation.dispose();
  assert.equal(r.aborted, 1);
  assert.equal(dictation.listening.value, false);
  onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'late' } }] });
  assert.deepEqual(finals, []);
});

test('without speech recognition the button is not offered; the language follows the interface', () => {
  assert.equal(createDictation({ lang: () => 'pt-BR', onFinal() {}, create: undefined, storage: memory() }).supported, false);
  assert.equal(browserRecognizer({}), undefined);
  function Webkit() {}
  assert.ok(browserRecognizer({ webkitSpeechRecognition: Webkit })() instanceof Webkit);
  assert.equal(speechLang(undefined), 'pt-BR');
  assert.equal(speechLang('pt-BR'), 'pt-BR');
  assert.equal(speechLang('en'), 'en-US');
  assert.equal(speechLang('zh-CN'), 'zh-CN');
});

test('every new string has a Brazilian Portuguese translation with the same placeholders', () => {
  const dir = new URL('.', import.meta.url);
  const translations = {
    ...JSON.parse(readFileSync(new URL('../../i18n/pt-BR.json', dir), 'utf8')),
    ...JSON.parse(readFileSync(new URL('m2-chat.pt-BR.json', dir), 'utf8')),
  };
  const sources = ['DictationButton.vue', 'DictationStatus.vue', 'ConversationChips.vue'].map(name => readFileSync(new URL(name, dir), 'utf8')).join('\n');
  const keys = new Set(Object.values(DICTATION_ERRORS));
  for (const match of sources.matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  for (const match of sources.matchAll(/\bt\([^()]*?\?\s*'([^']+)'\s*:\s*'([^']+)'/g)) { keys.add(match[1]); keys.add(match[2]); }
  const pane = readFileSync(new URL('../ChatSessionPane.vue', dir), 'utf8');
  for (const key of ['Copy link', 'That is the link to this conversation, so it was not added as context.', 'Link copied. Paste it into another conversation to give it this one as context.']) {
    assert.ok(pane.includes(key), key);
    keys.add(key);
  }
  assert.ok(keys.has('Stop dictation') && keys.has('Dictate'));
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
});
