// Apps, stage E: the builder. "Create with the agent" guesses a template, a
// name, a letter and a colour from one sentence (no model), makes the app
// from the template and writes the first message; shortcuts open in a pane
// or a tab; app versions are listed and restored from the header; the
// catalog cards say the route, when the app changed and whether it errs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { TEMPLATES, TEMPLATE_GROUPS, brokenAppPrompt, builderPrompt, guessName, guessTemplate, suggest, updatedAgo } from './builder.ts';
import { shortcutHost, shortcutOpening, shortcutPane, verdictFresh } from './shortcuts.ts';
import { authorLabel, filesTitle, restoreSummary, versionTitle } from './app-versions.ts';
import { appPaneKey, openAppKeys } from './rail.ts';

const here = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');
const t = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));

// ---------------------------------------------------------------- guessing from the sentence

test('the template follows the words of the sentence, in Portuguese and English', () => {
  assert.equal(guessTemplate('um quadro com meus negócios por etapa'), 'kanban');
  assert.equal(guessTemplate('A CRM for my leads'), 'kanban');
  assert.equal(guessTemplate('tabela de contatos com telefone'), 'table');
  assert.equal(guessTemplate('an inventory of the stock in the shop'), 'table');
  assert.equal(guessTemplate('agenda de reuniões da semana'), 'calendar');
  assert.equal(guessTemplate('a calendar of birthdays'), 'calendar');
  assert.equal(guessTemplate('painel de vendas com gráficos por mês'), 'dashboard');
  assert.equal(guessTemplate('a dashboard tracking revenue'), 'dashboard');
  assert.equal(guessTemplate('formulário de inscrição para o curso'), 'form');
  assert.equal(guessTemplate('a survey for customer feedback'), 'form');
  assert.equal(guessTemplate('editor de documentos para as atas'), 'knowledge');
  assert.equal(guessTemplate('a wiki for the team'), 'knowledge');
  assert.equal(guessTemplate('base de conhecimento com os procedimentos'), 'knowledge');
  assert.equal(guessTemplate('uma galeria com campos meus'), 'base');
  assert.equal(guessTemplate('something nobody can name'), 'blank');
  assert.equal(guessTemplate(''), 'blank');
  // A strong clue wins over many weak ones.
  assert.equal(guessTemplate('kanban para acompanhar os contatos e clientes da lista'), 'kanban');
});

test('the name is two or three telling words, title-cased, and the letter and colour follow', () => {
  assert.equal(guessName('um app para acompanhar os leads da loja', 'kanban'), 'Acompanhar Leads Loja');
  assert.equal(guessName('I want an app that tracks my gym workouts', 'table'), 'Tracks Gym Workouts');
  assert.equal(guessName('Agenda de reuniões', 'calendar'), 'Agenda Reuniões');
  assert.equal(guessName('', 'kanban'), 'Kanban', 'no words: the template');
  assert.equal(guessName('o meu', 'dashboard'), 'Dashboard', 'only small words: the template');
  assert.ok(guessName('um sistema de controle de estoque de peças automotivas importadas', 'table').length <= 30);
  const kanban = suggest('quadro de vendas por etapa');
  assert.equal(kanban.template, 'kanban');
  assert.equal(kanban.letter, 'Q', 'first letter of "Quadro Vendas Etapa"');
  assert.equal(kanban.color, 'violet', 'the template\'s colour');
  const blank = suggest('xyz');
  assert.equal(blank.template, 'blank');
  assert.equal(blank.name, 'Xyz');
  assert.ok(['amber', 'green', 'blue', 'violet', 'rose', 'slate', 'teal', 'orange'].includes(blank.color));
  assert.equal(suggest('agenda', 'form').template, 'form', 'the person\'s own choice is kept');
});

test('the templates match the server\'s, and the first message says what was made', () => {
  assert.deepEqual(TEMPLATES.map(template => template.id), ['base', 'blank', 'kanban', 'table', 'catalog', 'calendar', 'booking', 'dashboard', 'checklist', 'form', 'quiz', 'calculator', 'compare', 'knowledge', 'map']);
  assert.equal(guessTemplate('checklist de abertura da loja'), 'checklist');
  assert.equal(guessTemplate('simulador de comissão'), 'calculator');
  assert.equal(guessTemplate('comparar propostas de fornecedores'), 'compare');
  assert.equal(guessTemplate('catálogo de produtos'), 'catalog');
  assert.equal(guessTemplate('reserva das salas de reunião'), 'booking');
  assert.equal(guessTemplate('quiz de treinamento de atendimento'), 'quiz');
  assert.equal(guessTemplate('mapa das lojas e obras'), 'map');
  const prompt = builderPrompt({ app: { name: 'Vendas', slug: 'vendas' }, sentence: 'quadro de vendas por etapa', template: 'kanban' });
  assert.match(prompt, /I just created the app "Vendas" in `apps\/vendas\/` from the "Kanban \/ CRM" template/);
  assert.match(prompt, /quadro de vendas por etapa/);
  assert.match(prompt, /collection "cards"/);
  assert.match(prompt, /kit\.css \+ kit\.js/);
  assert.match(prompt, /\/diagnostics/);
  assert.match(prompt, /language I am writing in/);
  assert.match(prompt, /How Tendly apps work/, 'the convention goes along');
  assert.match(builderPrompt({ app: { name: 'X', slug: 'x' }, sentence: '  ', template: 'blank' }), /ask me what it should do/);
  const broken = brokenAppPrompt('old', 'app.json is not valid JSON');
  assert.match(broken, /apps\/old\/`: app\.json is not valid JSON/);
  assert.match(broken, /must be a JSON object/);
});

test('"Updated X ago" rounds to the nearest unit', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(updatedAgo('2026-11-07T11:59:40Z', t, now), 'Updated just now');
  assert.equal(updatedAgo('2026-11-07T11:45:00Z', t, now), 'Updated 15 min ago');
  assert.equal(updatedAgo('2026-11-07T10:58:00Z', t, now), 'Updated 1 hour ago');
  assert.equal(updatedAgo('2026-11-07T07:00:00Z', t, now), 'Updated 5 hours ago');
  assert.equal(updatedAgo('2026-11-06T11:00:00Z', t, now), 'Updated 1 day ago');
  assert.equal(updatedAgo('2026-10-01T11:00:00Z', t, now), 'Updated 1 month ago');
  assert.equal(updatedAgo('nope', t, now), '');
  assert.equal(updatedAgo(undefined, t, now), '');
});

// ---------------------------------------------------------------- shortcuts

test('a shortcut opens in a pane only when the site allows it, and the reason is said otherwise', () => {
  const allowed = { url: 'https://notion.so/x', embed: { allowed: true, reason: null, checked_at: '2026-11-07T10:00:00Z' } };
  assert.deepEqual(shortcutOpening(allowed, 'https:', t), { where: 'pane' });
  const denied = { url: 'https://bank.example', embed: { allowed: false, reason: 'x-frame-options-deny', checked_at: 'now' } };
  const tab = shortcutOpening(denied, 'http:', t);
  assert.equal(tab.where, 'tab');
  assert.match(tab.reason, /X-Frame-Options/);
  assert.match(shortcutOpening({ url: 'https://d', embed: { allowed: false, reason: 'frame-ancestors', checked_at: 'now' } }, 'http:', t).reason, /frame-ancestors/);
  assert.match(shortcutOpening({ url: 'https://d', embed: { allowed: null, reason: 'unreachable: x', checked_at: null } }, 'http:', t).reason, /could not reach/);
  // Mixed content: http inside https is blocked by the browser, except loopback.
  assert.match(shortcutOpening({ url: 'http://intranet.example', embed: allowed.embed }, 'https:', t).reason, /https/);
  assert.deepEqual(shortcutOpening({ url: 'http://localhost:3000', embed: allowed.embed }, 'https:', t), { where: 'pane' });
  assert.deepEqual(shortcutOpening({ url: 'http://127.0.0.1:8080/x', embed: allowed.embed }, 'https:', t), { where: 'pane' });
  assert.equal(shortcutOpening({ url: 'not a url', embed: allowed.embed }, 'https:', t).where, 'tab');
});

test('a verdict is fresh for a day, and the pane carries the shortcut', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.equal(verdictFresh({ allowed: true, reason: null, checked_at: '2026-11-07T00:00:00Z' }, 86400, now), true);
  assert.equal(verdictFresh({ allowed: true, reason: null, checked_at: '2026-11-05T00:00:00Z' }, 86400, now), false);
  assert.equal(verdictFresh({ allowed: null, reason: null, checked_at: '2026-11-07T11:00:00Z' }, 86400, now), false, 'unknown is never fresh');
  assert.equal(verdictFresh({ allowed: true, reason: null, checked_at: null }, 86400, now), false);
  const shortcut = { id: 'abc', name: 'Notion', url: 'https://notion.so', letter: 'No', color: 'teal', position: 1, embed: { allowed: true, reason: null, checked_at: null }, created_at: '', updated_at: '' };
  const pane = shortcutPane(shortcut, 'w1');
  assert.equal(pane.kind, 'app', 'rides on the app pane kind');
  assert.equal(pane.id, 'shortcut-abc');
  assert.deepEqual(pane.metadata, { workspace_id: 'w1', slug: 'shortcut-abc', shortcut: 'abc', name: 'Notion', letter: 'N', color: 'teal', url: 'https://notion.so' }, 'the tile shows one letter');
  assert.match(pane.metadata.slug, /^[a-zA-Z0-9._-]{1,80}$/, 'what the server\'s validator accepts');
  assert.equal(appPaneKey(pane), 'shortcut/abc', 'the rail knows it by its own key');
  assert.deepEqual(openAppKeys([pane, { kind: 'app', metadata: { workspace_id: 'w1', slug: 'crm' } }]), ['shortcut/abc', 'w1/crm']);
  assert.equal(shortcutHost('https://www.notion.so/team/x'), 'notion.so');
  assert.equal(shortcutHost('nope'), 'nope');
});

// ---------------------------------------------------------------- versions

test('a version is named by what the agent said, else by its files, and a restore is summed up', () => {
  assert.equal(versionTitle({ message: 'Adding the board', files: ['index.html'], count: 1 }, t), 'Adding the board');
  assert.equal(versionTitle({ message: null, files: ['index.html'], count: 1 }, t), 'index.html');
  assert.equal(versionTitle({ message: null, files: ['a.js', 'b.css'], count: 2 }, t), 'a.js, b.css');
  assert.equal(versionTitle({ message: null, files: ['a', 'b', 'c'], count: 3 }, t), '3 files');
  assert.equal(authorLabel({ author_kind: 'agent', session_title: 'Build the CRM' }, t), 'Agent · Build the CRM');
  assert.equal(authorLabel({ author_kind: 'agent', session_title: null }, t), 'Agent');
  assert.equal(authorLabel({ author_kind: 'you', session_title: null }, t), 'You');
  assert.equal(authorLabel({ author_kind: 'unknown', session_title: null }, t), 'Outside Tendly');
  assert.equal(filesTitle({ files: ['a', 'b'], count: 5 }), 'a\nb\n…');
  assert.equal(restoreSummary({ restored: ['a'], removed: ['b', 'c'], unchanged: [], skipped: [] }, t), 'App restored: 1 restored, 2 removed.');
  assert.equal(restoreSummary({ restored: [], removed: [], unchanged: ['a'], skipped: [] }, t), 'The app was already at that version.');
  assert.match(restoreSummary({ restored: ['a'], removed: [], unchanged: [], skipped: [{ path: 'x', reason: 'y' }] }, t), /1 left as they are/);
});

// ---------------------------------------------------------------- the components, rendered

let server;
/** Renders a component through Vite; `setup` gets the stores the component itself sees (Vite's instances, not this file's). */
async function render(name, props, setup = () => {}) {
  server ??= await createServer({ configFile: false, root: new URL('../../../', here).pathname, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false }, plugins: [vue()], appType: 'custom', optimizeDeps: { noDiscovery: true } });
  const [{ default: Component }, i18n, { apps }, { shortcuts }] = await Promise.all([`/src/features/hub/${name}`, '/src/i18n/index.ts', '/src/features/hub/apps.ts', '/src/features/hub/shortcuts.ts'].map(id => server.ssrLoadModule(id)));
  i18n.useI18n().setLocale('en');
  setup({ apps, shortcuts });
  return renderToString(createSSRApp(Component, props));
}
test.after(async () => { await server?.close(); });

const WORKSPACES = [{ id: 'w1', name: 'Site', root_path: '/tmp/site' }];
const APP = { workspace_id: 'w1', workspace_name: 'Site', slug: 'pipeline', name: 'Pipeline', letter: 'P', color: 'blue', description: 'Deals', entry: 'index.html', permissions: [], url: '/api/hub/apps/w1/pipeline/files/index.html', code_path: 'apps/pipeline/', updated_at: new Date(Date.now() - 5 * 60000).toISOString(), errors: 2, errors_at: new Date().toISOString() };

test('the create panel offers every template and never a model call; creating is the only submit', async () => {
  const html = await render('CreateAppPanel.vue', { projects: WORKSPACES, selectedWorkspaceId: 'w1' });
  assert.match(html, /<form class="create-app" aria-label="Create with the agent"/);
  assert.equal((html.match(/role="radio"/g) ?? []).length, TEMPLATES.length + 8, 'every template and eight colours');
  for (const template of TEMPLATES) assert.match(html, new RegExp(`<strong[^>]*>${template.label.replace(/[/+]/g, '\\$&')}</strong>`), template.label);
  assert.match(html, /aria-checked="true"[^>]*class="create-app-template chosen"[\s\S]*?<strong[^>]*>Blank<\/strong>/, 'blank is chosen with no sentence');
  assert.match(html, /What should the app do\? One sentence\./);
  assert.match(html, /Nothing is sent until you press send\./);
  const source = read('CreateAppPanel.vue');
  assert.doesNotMatch(source, /hub\/start/, 'no conversation is started from here');
  assert.match(source, /scaffoldApp\(workspaceId, \{ slug: freeSlug\(name, workspaceId\), name, description: [^}]*template: form\.template, locale: locale\.value \}\)/, 'the template comes in the person\'s language');
  assert.match(source, /emit\("created", app, prompt\)/);
  assert.match(source, /border: 1px solid var\(--line-input\)/, 'field borders');
  assert.match(source, /@media \(pointer: coarse\)/);
});

test('the template list is grouped: featured first, then the headings in order, still one radiogroup', async () => {
  const html = await render('CreateAppPanel.vue', { projects: WORKSPACES, selectedWorkspaceId: 'w1' });
  const names = { organize: 'Organize', schedule: 'Agenda', track: 'Track', collect: 'Collect', decide: 'Decide', content: 'Content' };
  const headings = [...html.matchAll(/<h3[^>]*class="create-app-group-title"[^>]*>([^<]*)<\/h3>/g)].map(match => match[1]);
  assert.deepEqual(headings, TEMPLATE_GROUPS.filter(group => TEMPLATES.some(template => template.group === group.id)).map(group => names[group.id]), 'headings in group order');
  assert.equal((html.match(/role="radiogroup"/g) ?? []).length, 2, 'one for the templates, one for the colours');
  const list = html.slice(html.indexOf('create-app-template-list'), html.indexOf('create-app-row'));
  assert.equal((list.match(/role="radio"/g) ?? []).length, TEMPLATES.length, 'one radio per template');
  const shown = [...list.matchAll(/data-template="(\w+)"/g)].map(match => match[1]);
  const expected = ['featured', ...TEMPLATE_GROUPS.map(group => group.id)].flatMap(group => TEMPLATES.filter(template => template.group === group).map(template => template.id));
  assert.deepEqual(shown, expected, 'visual order is featured first, then group by group, in TEMPLATES order');
  assert.deepEqual(shown.slice(0, 2), ['base', 'blank']);
  assert.equal((list.match(/tabindex="0"/g) ?? []).length, 1, 'the chosen card is the only tab stop');
  assert.doesNotMatch(html, /create-app-suggested/, 'nothing suggested without a sentence');
});

test('the catalog cards say the route, when the app changed, and errors with "Ask for a fix"; broken apps too', async () => {
  const html = await render('AppsPage.vue', { workspaces: WORKSPACES, profiles: [], selectedWorkspaceId: 'w1' }, ({ apps, shortcuts }) => {
    apps.list = [APP]; apps.errors = [{ workspace_id: 'w1', slug: 'old', message: 'app.json is not valid JSON' }]; apps.loaded = true;
    shortcuts.list = [{ id: 's1', name: 'Notion', url: 'https://www.notion.so/team', letter: 'N', color: 'teal', position: 1, embed: { allowed: false, reason: 'x-frame-options-deny', checked_at: 'now' }, created_at: '', updated_at: '' }]; shortcuts.loaded = true;
  });
  assert.match(html, /<code class="apps-app-route"[^>]*>\/apps\/w1\/pipeline<\/code>/);
  assert.match(html, /Updated 5 min ago/);
  assert.match(html, /<button type="button" class="apps-app-errors"[^>]*>[\s\S]*?2 errors<\/span> · Ask for a fix<\/button>/);
  assert.match(html, /aria-label="Broken app old"[\s\S]*?apps\/old\/[\s\S]*?Could not be read: app\.json is not valid JSON[\s\S]*?Ask for a fix/);
  assert.match(html, /<h2[^>]*>Shortcuts<\/h2>/);
  assert.match(html, /notion\.so<\/small>/);
  assert.match(html, /Opens in a new tab: the site does not allow framing/);
  assert.match(html, /Add shortcut/);
  const source = read('AppsPage.vue');
  assert.doesNotMatch(source, /window\.confirm/);
  assert.match(source, /apps-shortcut-confirm/, 'removal is confirmed in place');
  assert.doesNotMatch(source, /hub\/start/);
});

test('the shortcut form takes name, address, letter and colour, and a pane shows the site with its bar', async () => {
  const form = await render('ShortcutForm.vue', {});
  assert.match(form, /aria-label="Add shortcut"/);
  assert.match(form, /type="url"[^>]*placeholder="https:\/\/"/);
  assert.equal((form.match(/role="radio"/g) ?? []).length, 8);
  const edit = await render('ShortcutForm.vue', { shortcut: { id: 's1', name: 'Notion', url: 'https://notion.so', letter: 'No', color: 'teal', position: 1, embed: { allowed: true, reason: null, checked_at: null }, created_at: '', updated_at: '' } });
  assert.match(edit, /aria-label="Edit shortcut"/);
  assert.match(edit, /value="https:\/\/notion\.so"/);
  const view = await render('ShortcutView.vue', { id: 's1', fallback: { name: 'Notion', letter: 'N', color: 'teal', url: 'https://notion.so/x' } }, ({ shortcuts }) => { shortcuts.list = []; });
  assert.match(view, /<iframe[^>]*class="shortcut-view-frame"[^>]*src="https:\/\/notion\.so\/x"/);
  assert.doesNotMatch(view, /sandbox=/, 'a site keeps its own origin');
  assert.match(view, /aria-label="Open in new tab"/);
  const gone = await render('ShortcutView.vue', { id: 's1', fallback: {} }, ({ shortcuts }) => { shortcuts.list = []; });
  assert.match(gone, /This shortcut is not here anymore/);
  assert.match(read('AppPane.vue'), /<ShortcutView v-if="shortcut" :id="shortcut" :fallback="fallback" @remove="emit\('remove'\)" \/>/);
});

test('the header has Versions, and the panel lists them with the restore confirmed in place', async () => {
  const view = read('AppView.vue');
  assert.match(view, /aria-label="t\('Versions'\)"/);
  assert.match(view, /<AppVersionsPanel v-if="app && versionsOpen" :app="app" @close="closeVersions"/);
  assert.match(view, /reportDiagnostics\(current, place\.value, list\)/, 'what the window saw goes to the server');
  const panel = read('AppVersionsPanel.vue');
  assert.match(panel, /Restore the app to this version/);
  assert.match(panel, /confirming = version\.id/);
  assert.match(panel, /Every file goes back to how it was then/);
  assert.doesNotMatch(panel, /window\.confirm/);
  assert.match(panel, /restoreVersion\(props\.app, version\.id\)/);
  assert.match(panel, /@media \(pointer: coarse\)/);
});

test('the rail has "+" after the tiles and a shortcut tile with its mark; Home and the Design page join in', () => {
  const rail = read('IconRail.vue');
  assert.match(rail, /data-rail-id="nav:new"[^>]*:aria-label="t\('New app'\)"/);
  assert.match(rail, /data-rail-id="`link:\$\{shortcutKey\(item\)\}`"/);
  assert.match(rail, /emit\("openShortcut", shortcut\)/);
  assert.match(rail, /emit\("newApp"\)/);
  const home = read('HomePage.vue');
  assert.match(home, /homeShortcuts/);
  assert.match(home, /emit\('openShortcut', shortcut\)/);
  const design = read('DesignPage.vue');
  assert.match(design, /\/api\/hub\/apps\/kit-demo\.html\?theme=/);
  assert.match(design, /sandbox="allow-scripts allow-forms allow-modals"/);
  assert.match(design, /'360', '640', 'full'/);
  const shell = read('../../App.vue');
  assert.match(shell, /@created="openAppWithChat" @fix-app="fixApp" @fix-broken="fixBroken" @open-shortcut="openShortcut"/);
  assert.match(shell, /quickSession\(app\.workspace_id, provider === "terminal" \? DEFAULT_CLIENT : provider, false, appPane\(app\)\.id, true\)/, 'the chat opens beside the app pane');
  assert.match(shell, /fillComposer\(session\.id, \{ attach: appAttachment\(app\), text \}\)/, 'the first message is written, never sent');
  assert.match(shell, /window\.open\(current\.url, "_blank", "noopener,noreferrer"\);\n    showToast\(opening\.reason/, 'a tab says why');
});

test('every string of this stage has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  assert.ok(!raw.endsWith('\n') && raw.includes('\n "'), 'one-space indent, no trailing newline');
  const translations = JSON.parse(raw);
  const keys = new Set(['amber', 'green', 'blue', 'violet', 'rose', 'slate', 'teal', 'orange', 'Updated just now', 'Updated {n} min ago', 'Updated {n} hours ago', 'Updated {n} days ago']);
  for (const template of TEMPLATES) { keys.add(template.label); keys.add(template.hint); }
  for (const file of ['CreateAppPanel.vue', 'ShortcutForm.vue', 'ShortcutView.vue', 'AppVersionsPanel.vue', 'AppsPage.vue', 'IconRail.vue', 'builder.ts', 'shortcuts.ts', 'app-versions.ts']) {
    for (const match of read(file).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2].replace(/\\'/g, "'"));
  }
  for (const key of keys) {
    assert.equal(typeof translations[key], 'string', `missing: ${key}`);
    assert.deepEqual((translations[key].match(/\{\w+\}/g) ?? []).sort(), (key.match(/\{\w+\}/g) ?? []).sort(), key);
  }
  assert.equal(translations['Restore the app to this version'], 'Voltar o app para esta versão');
  assert.equal(translations['Add shortcut'], 'Adicionar atalho');
});

test('design rules: tokens only, no native confirm, touch targets', () => {
  for (const file of ['CreateAppPanel.vue', 'ShortcutForm.vue', 'ShortcutView.vue', 'AppVersionsPanel.vue', 'AppsPage.vue']) {
    const style = read(file).split('<style')[1] ?? '';
    assert.doesNotMatch(style, /#[0-9a-f]{3,8}\b/i, `${file}: no hex colours`);
    assert.doesNotMatch(style, /font-size:\s*\d+px/, `${file}: no px font sizes`);
    assert.doesNotMatch(read(file), /window\.confirm|confirm\(/, `${file}: confirmations in place`);
  }
});

test('with nothing telling in the sentence, the name is the template\'s own, in the person\'s language', async () => {
  const { guessName } = await import('./builder.ts');
  const pt = { Blank: 'Em branco', 'Dashboard with charts': 'Painel com gráficos', 'Form + list': 'Formulário + lista', 'Kanban / CRM': 'Kanban / CRM' };
  const label = text => pt[text] ?? text;
  assert.equal(guessName('', 'blank', label), 'Em branco');
  assert.equal(guessName('', 'dashboard', label), 'Painel');
  assert.equal(guessName('', 'form', label), 'Formulário');
  assert.equal(guessName('', 'kanban', label), 'Kanban');
  assert.equal(guessName('', 'dashboard'), 'Dashboard', 'English without a translator');
});
