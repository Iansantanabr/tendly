// M5: the "could" items that need no outside account.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { envKeyCount, splitByUse, splitEnvNames, vaultState } from './catalog.ts';
import { JOB_SOURCE_LABEL, groupJobs } from './automations.ts';
import { isPinned, pinHasMore, pinPreview, pins } from './pins.ts';
import { REPORT_SLUG, existingReportApp, openReportApp } from './report.ts';
import { ApiError } from '../api.ts';

const here = new URL('.', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');

/** The components and modules M5 added, whose strings and styles are checked below. */
const COMPONENTS = ['EnvKeysSection.vue', 'IntegrationRow.vue', 'IntegrationsPage.vue', 'VaultSection.vue', 'ServerJobs.vue', 'PinnedMessageBar.vue', 'PinMessageButton.vue', 'ReportProblem.vue', 'report.ts'];
const MODULES = ['catalog.ts'];

// ---------------------------------------------------------------- keys found in .env files

const FOUND = [
  { workspace_id: 'w1', workspace_name: 'Site', truncated: false, files: [
    { path: '.env', names: [{ name: 'STRIPE_SECRET_KEY', secret: true }, { name: 'PORT', secret: false }, { name: 'GITHUB_TOKEN', secret: true }] },
    { path: 'api/.env.local', names: [{ name: 'DATABASE_URL', secret: false }] },
  ] },
  { workspace_id: 'w2', workspace_name: 'Bot', truncated: true, files: [
    { path: '.env', names: [{ name: 'OPENAI_API_KEY', secret: true }] },
  ] },
];

test('env names are counted and split into keys and other variables', () => {
  assert.equal(envKeyCount(FOUND), 3);
  assert.equal(envKeyCount([]), 0);
  assert.deepEqual(splitEnvNames(FOUND[0].files[0]), { keys: ['STRIPE_SECRET_KEY', 'GITHUB_TOKEN'], others: ['PORT'] });
  assert.deepEqual(splitEnvNames(FOUND[0].files[1]), { keys: [], others: ['DATABASE_URL'] });
});

test('the keys section shows names only and says so', () => {
  const section = read('EnvKeysSection.vue');
  const page = read('IntegrationsPage.vue');
  assert.match(page, /<EnvKeysSection :workspaces="workspaces" \/>/);
  assert.match(section, /Tendly reads only their names, never their values/);
  // Nothing in the type or the template has a place for a value.
  const types = read('catalog.ts');
  const envName = /export interface EnvName \{([^}]*)\}/.exec(types)[1];
  assert.doesNotMatch(envName, /value/);
  assert.doesNotMatch(section, /\.value\b(?!\s*(=|\?\?|\)|;|\.))/, 'no field named value is drawn');
  // It never starts a conversation: this section only shows what was found.
  assert.doesNotMatch(section, /startConversation|\/hub\/start/);
  // Keys and other variables are told apart by a label, not only by weight or colour.
  assert.match(section, /t\('Keys'\)/);
  assert.match(section, /t\('Other variables'\)/);
});

// ---------------------------------------------------------------- integrations not in use

test('servers that are off or never set up are listed apart, closed until asked for', () => {
  const servers = [
    { name: 'notion', status: 'connected' },
    { name: 'figma', status: 'unknown', detail: 'Not configured', unused: true },
    { name: 'canva', status: 'needs_auth' },
    { name: 'mail', status: 'unknown', detail: 'Turned off', unused: true },
    { name: 'repl', status: 'unknown' },
    { name: 'broken', status: 'failed', unused: false },
  ];
  const { inUse, unused } = splitByUse(servers);
  // Not checked, waiting for sign-in and failing are all still in use.
  assert.deepEqual(inUse.map(s => s.name), ['notion', 'canva', 'repl', 'broken']);
  assert.deepEqual(unused.map(s => s.name), ['figma', 'mail']);
  assert.deepEqual(splitByUse([]), { inUse: [], unused: [] });

  const page = read('IntegrationsPage.vue');
  // A native <details> with no `open`: collapsed, and the keyboard works without code.
  const details = /<details v-if="byUse\.unused\.length" class="catalog-unused">[\s\S]*?<\/details>/.exec(page)[0];
  assert.doesNotMatch(details.split('>')[0], /\bopen\b/);
  assert.match(details, /<summary>[\s\S]*t\('Not in use'\)[\s\S]*byUse\.unused\.length[\s\S]*<\/summary>/);
  assert.match(details, /<IntegrationRow v-for="server in group\.items"/);
  // The count in the title is what agents can reach.
  assert.match(page, /t\('\{count\} integrations', \{ count: byUse\.inUse\.length \}\)/);
  assert.match(page, /@media \(pointer: coarse\) \{ \.catalog-unused summary \{ min-height: 44px; \} \}/);
  // The row says the state in words; the same row draws both lists.
  const row = read('IntegrationRow.vue');
  assert.match(row, /return t\(server\.detail \|\| "Not checked"\)/);
});

// ---------------------------------------------------------------- 1Password vault

test('the vault section has three faces and no place for a token', () => {
  assert.equal(vaultState({ installed: false, signed_in: false }), 'missing');
  assert.equal(vaultState({ installed: true, signed_in: false }), 'signed_out');
  assert.equal(vaultState({ installed: true, signed_in: true }), 'signed_in');

  const section = read('VaultSection.vue');
  assert.match(read('IntegrationsPage.vue'), /<VaultSection \/>/);
  // Read only: nothing to type into, so no token can be given to Tendly here.
  assert.doesNotMatch(section, /<input|<textarea|v-model/);
  assert.match(section, /Tendly never stores the token and reads only the names of the vaults/);
  // Opening the page never asks 1Password for approval; only the button does.
  assert.match(section, /onMounted\(\(\) => \{ void load\(\); \}\)/);
  assert.equal(section.match(/load\(true\)/g).length, 1);
  assert.match(section, /@click="load\(true\)">\{\{ loading \? t\('Waiting for 1Password…'\) : t\('List vaults'\) \}\}/);
  // Missing CLI: how to install it, with the link opening apart.
  assert.match(section, /brew install 1password-cli/);
  assert.match(section, /:href="ONE_PASSWORD_CLI_URL" target="_blank" rel="noopener"/);
  // The API asks for approval only with ?unlock=1.
  const api = read('catalog.ts');
  assert.match(api, /`\/hub\/catalog\/vault\$\{unlock \? "\?unlock=1" : ""\}`/);
  const info = /export interface VaultInfo \{([\s\S]*?)\n\}/.exec(api)[1];
  assert.doesNotMatch(info, /token|email|item|secret/i);
});

// ---------------------------------------------------------------- server jobs

test('server jobs are grouped by scheduler and only read', () => {
  const jobs = [
    { source: 'launchd', name: 'com.example.sync', schedule: 'StartInterval 3600', command: '/usr/local/bin/sync --password ***' },
    { source: 'crontab', name: 'report.sh', schedule: '30 6 * * 1-5', command: './report.sh' },
    { source: 'systemd', name: 'tendly-backup.timer', schedule: '', next: 'Sat 2026-11-07 06:30:00 UTC', command: 'tendly-backup.service' },
    { source: 'crontab', name: 'backup', schedule: '@daily', command: 'backup /data' },
  ];
  const groups = groupJobs(jobs);
  assert.deepEqual(groups.map(g => [g.source, g.jobs.map(j => j.name)]), [
    ['crontab', ['report.sh', 'backup']],
    ['systemd', ['tendly-backup.timer']],
    ['launchd', ['com.example.sync']],
  ]);
  assert.deepEqual(groupJobs([]), []);
  assert.equal(JOB_SOURCE_LABEL.launchd, 'LaunchAgents');

  const section = read('ServerJobs.vue');
  assert.match(read('AutomationsPage.vue'), /<ServerJobs \/>/);
  // Collapsed, and nothing is run on the machine until the section is opened.
  assert.match(section, /<details class="jobs" @toggle="opened">/);
  assert.doesNotMatch(section, /onMounted/);
  // Read only: the one request is a GET, and no job can be run, changed or removed from here.
  assert.doesNotMatch(section, /method:|json\(|runAutomation|deleteAutomation|updateAutomation/);
  assert.match(read('automations.ts'), /loadServerJobs = \(\) => request<ServerJobList>\("\/hub\/automations\/server-jobs"\)/);
  assert.match(section, /Keys and passwords in commands are hidden/);
  assert.match(section, /@media \(pointer: coarse\) \{ \.jobs summary, \.jobs \.small-button \{ min-height: 44px; \} \}/);
});

// ---------------------------------------------------------------- pinned message

test('one message is pinned per conversation and the bar shows it on one line', () => {
  assert.equal(pinPreview('  Always answer\n in   Portuguese.  '), 'Always answer in Portuguese.');
  const long = pinPreview('é'.repeat(300));
  assert.equal(Array.from(long).length, 160);
  assert.ok(long.endsWith('…'));
  assert.equal(pinHasMore('short'), false);
  assert.equal(pinHasMore('two\nlines'), true);
  assert.equal(pinHasMore('x'.repeat(300)), true);

  assert.equal(isPinned('s1', 'm1'), false);
  pins.s1 = { message_id: 'm1', text: 'Keep it short', pinned_at: '2026-11-06T12:00:00.000Z' };
  assert.equal(isPinned('s1', 'm1'), true);
  assert.equal(isPinned('s1', 'm2'), false);
  assert.equal(isPinned('s2', 'm1'), false);
  pins.s1 = null;
  assert.equal(isPinned('s1', 'm1'), false);
  delete pins.s1;
});

test('the chat pane gains the bar and the button, and nothing else changes in it', () => {
  const pane = readFileSync(new URL('../ChatSessionPane.vue', here), 'utf8');
  // The bar sits above the timeline; the button only under the person's own messages; neither in a preview.
  assert.match(pane, /<PinnedMessageBar v-if="!isPreview" :session-id="session\.id" \/>\n    <div ref="viewport"/);
  assert.match(pane, /<PinMessageButton v-if="item\.role==='user'&&!isPreview" :session-id="session\.id" :message-id="item\.id" \/><\/div>/);
  assert.equal(pane.match(/PinnedMessageBar|PinMessageButton/g).length, 6, 'two imports (name and file) and two uses');

  const bar = read('PinnedMessageBar.vue');
  // Drawing the pane asks the server nothing; the pin is read once it is on screen.
  assert.match(bar, /onMounted\(\(\) => \{\s*watch\(\(\) => props\.sessionId/);
  assert.match(bar, /<aside v-if="pin" class="pinned-bar"/);
  assert.match(bar, /t\('Unpin'\)/);
  assert.match(bar, /@media \(pointer: coarse\) \{[^}]*\{[^}]*\} \.pinned-unpin, button\.pinned-text \{ min-height: 44px; \}/);
  const button = read('PinMessageButton.vue');
  assert.match(button, /:aria-pressed="pinned"/);
  // The server reads the text from the conversation: the browser sends only which message.
  assert.match(read('pins.ts'), /json\("PUT", \{ message_id: messageId \}\)/);
  assert.match(readFileSync(new URL('../Icon.vue', here), 'utf8'), /\n  pin: "/);
});

// ---------------------------------------------------------------- report a problem

const tr = (source, values = {}) => source.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? `{${key}}`));
const reportApp = workspace_id => ({ workspace_id, slug: REPORT_SLUG, name: 'Problem reports' });

test('the reports app is made once, in the first project, and only opened after that', async () => {
  // Nothing there yet: one scaffold, in the first project, with the issues page.
  let calls = [];
  let list = [{ workspace_id: 'p1', slug: 'crm' }];
  const deps = {
    refresh: async () => { calls.push('refresh'); },
    list: () => list,
    scaffold: async (workspaceId, body) => { calls.push(['scaffold', workspaceId, body]); const app = reportApp(workspaceId); list = [...list, app]; return app; },
  };
  const made = await openReportApp(['p1', 'p2'], tr, deps);
  assert.equal(made.workspace_id, 'p1');
  assert.deepEqual(calls, ['refresh', ['scaffold', 'p1', {
    slug: 'reportes', name: 'Problem reports', description: 'Problems and ideas noted while using Tendly.', color: 'rose', template: 'issues',
  }]]);

  // Asked again: looked for, found, opened. Nothing is created.
  calls = [];
  assert.equal((await openReportApp(['p1', 'p2'], tr, deps)).workspace_id, 'p1');
  assert.deepEqual(calls, ['refresh']);

  // It already lives in another project (the list was reordered): that one is opened.
  calls = [];
  list = [reportApp('p2')];
  assert.equal((await openReportApp(['p1', 'p2'], tr, deps)).workspace_id, 'p2');
  assert.deepEqual(calls, ['refresh']);
  assert.equal(existingReportApp([reportApp('p2'), reportApp('p1')], ['p1', 'p2']).workspace_id, 'p1');
  // An app of that name in the hidden conversations folder is not a project's.
  assert.equal(existingReportApp([reportApp('hidden')], ['p1']), undefined);

  // Made by another window between the look and the request: the conflict is not an error.
  calls = [];
  list = [];
  const raced = { ...deps, scaffold: async () => { list = [reportApp('p1')]; throw new ApiError('apps/reportes already exists', 409); } };
  assert.equal((await openReportApp(['p1'], tr, raced)).workspace_id, 'p1');
  assert.deepEqual(calls, ['refresh', 'refresh']);
  // Any other failure is shown, and so is a conflict that leaves no app behind.
  list = [];
  await assert.rejects(openReportApp(['p1'], tr, { ...deps, scaffold: async () => { throw new ApiError('disk full', 500); } }), /disk full/);
  await assert.rejects(openReportApp(['p1'], tr, { ...deps, scaffold: async () => { throw new ApiError('apps/reportes already exists', 409); } }), /already exists/);

  // No project: nothing is asked of the server at all.
  calls = [];
  await assert.rejects(openReportApp([], tr, deps), /Add a project first/);
  assert.deepEqual(calls, []);
});

test('the sidebar footer creates the app on a click and never by itself', () => {
  const footer = read('ReportProblem.vue');
  const sidebar = readFileSync(new URL('../WorkspaceSidebar.vue', here), 'utf8');
  // Still the sidebar's last child; with the icon rail (Apps A) the rail has its own button instead.
  assert.match(sidebar, /<ReportProblem v-if="!compact" :workspaces="projectWorkspaces" @open-app="emit\('openApp', \$event\)" \/>\n  <\/div>\n<\/template>/);
  // The only way in is the button's click: no mount hook, no watcher, no timer.
  assert.doesNotMatch(footer, /onMounted|watch\(|watchEffect|setTimeout|setInterval/);
  assert.equal(footer.match(/openReportApp\(/g).length, 1);
  assert.match(footer, /@click="report"/);
  assert.match(footer, /<footer class="report-foot">/);
  assert.match(footer, /role="alert"/);
  // It goes through the scaffold endpoint that already exists, and starts no conversation.
  const logic = read('report.ts');
  assert.match(logic, /deps\.scaffold\(projectIds\[0\], \{/);
  assert.doesNotMatch(logic + footer, /startConversation|\/hub\/start/);
  assert.match(read('apps.ts'), /`\/hub\/apps\/\$\{encodeURIComponent\(workspaceId\)\}\/scaffold`/);
});

// ---------------------------------------------------------------- translations and design rules

test('every M5 string has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  const translations = JSON.parse(raw);
  // Strings chosen by a value the server sends, which the scan below can not see.
  const keys = new Set([
    'Not configured', 'Turned off', 'Not checked', 'Not reported by Claude Code',
    '1Password answered in a form Tendly does not understand.', '1Password could not list the vaults.',
    '1Password did not sign in. Approve the request in the 1Password app, or sign in with a service account.',
    '1Password took too long to answer.',
  ]);
  for (const file of COMPONENTS) {
    for (const match of read(file).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size >= 7, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Keys found without a registration'], 'Chaves encontradas sem registro');
  // The file keeps its shape: one space of indentation, no trailing newline.
  assert.equal(raw, JSON.stringify(translations, null, 1));
});

test('M5 components follow the design rules: tokens, no native confirm, the focus ring stays', () => {
  for (const file of COMPONENTS) {
    const source = read(file);
    const style = source.slice(source.indexOf('<style'));
    assert.doesNotMatch(style, /#[0-9a-fA-F]{3,8}\b/, `${file}: no hex colours`);
    assert.doesNotMatch(style, /font-size:\s*\d+px/, `${file}: no px font sizes`);
    assert.doesNotMatch(style, /border-radius:\s*\d+px/, `${file}: radii come from tokens`);
    assert.doesNotMatch(style, /outline:\s*(none|0)/, `${file}: the global focus ring stays`);
    assert.doesNotMatch(source, /confirm\(/, `${file}: confirmations are inline`);
    // A sentence to read is never the faint colour.
    assert.doesNotMatch(style, /-(hint|label|note)\s*\{[^}]*var\(--faint\)/, `${file}: hints use --muted`);
  }
  for (const file of MODULES) assert.doesNotMatch(read(file), /window\.confirm/);
});
