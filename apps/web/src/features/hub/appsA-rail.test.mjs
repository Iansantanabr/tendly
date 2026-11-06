// Apps, stage A: the icon rail of the Mesa, the apps list of the expanded
// sidebar, the order of the apps and the "Sidebar on the Mesa" preference.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import {
  EMPTY_ORDER, appKey, appOrderError, arrangeApps, canMoveApp, changeAppOrder, hiddenApps, isHiddenApp, isPinnedApp, moveApp, setAppHidden, setAppPinned, tidyOrder,
} from './app-order.ts';
import { RAIL_MORE, RAIL_NAV, appPaneKey, badgeText, flyoutPlace, mesaSidebar, openAppKeys, opensOptions, rovingIndex, setMesaSidebar, sidebarLayout } from './rail.ts';
import { hubSettings, resetHubSettings } from './settings.ts';
import { appPane } from '../pane-context.ts';

const here = new URL('./', import.meta.url);
const read = name => readFileSync(new URL(name, here), 'utf8');

/** The components and modules this stage added or gave new strings to. */
const COMPONENTS = ['IconRail.vue', 'AppOrderMenu.vue', 'SidebarApps.vue', 'ReportProblem.vue', 'AddressesPanel.vue', 'AppsPage.vue', 'HomePage.vue'];
const NEW_COMPONENTS = ['IconRail.vue', 'AppOrderMenu.vue', 'SidebarApps.vue'];

const app = (slug, updated_at, workspace_id = 'w1') => ({ workspace_id, workspace_name: 'Site', slug, name: slug[0].toUpperCase() + slug.slice(1), letter: slug[0].toUpperCase(), color: 'blue', description: '', entry: 'index.html', url: `/api/hub/apps/${workspace_id}/${slug}/files/index.html`, code_path: `apps/${slug}/`, updated_at });
const LIST = [app('pipeline', '2026-11-01T10:00:00Z'), app('reportes', '2026-11-04T10:00:00Z'), app('vendas', '2026-11-02T10:00:00Z'), app('agenda', '2026-11-03T10:00:00Z', 'w2')];
const slugs = list => list.map(item => item.slug);
const order = (changes = {}) => ({ ...EMPTY_ORDER, ...changes });

// ---------------------------------------------------------------- the order of the apps

test('with nothing arranged, apps come latest changed first, as the sidebar always showed them', () => {
  assert.deepEqual(slugs(arrangeApps(LIST, EMPTY_ORDER)), ['reportes', 'agenda', 'vendas', 'pipeline']);
  assert.deepEqual(arrangeApps([], EMPTY_ORDER), []);
  // Two apps changed at the same moment keep a stable order.
  const twins = [app('b', '2026-11-01T10:00:00Z'), app('a', '2026-11-01T10:00:00Z')];
  assert.deepEqual(slugs(arrangeApps(twins, EMPTY_ORDER)), ['a', 'b']);
  assert.deepEqual(slugs(arrangeApps([...twins].reverse(), EMPTY_ORDER)), ['a', 'b']);
});

test('pinned apps come first, then the arranged ones, then the rest; hidden ones are left out', () => {
  const prefs = order({ pinned: ['w1/vendas', 'w1/pipeline'], order: ['w2/agenda'], hidden: [] });
  assert.deepEqual(slugs(arrangeApps(LIST, prefs)), ['vendas', 'pipeline', 'agenda', 'reportes']);
  const hiding = order({ pinned: ['w1/vendas'], hidden: ['w1/reportes'] });
  assert.deepEqual(slugs(arrangeApps(LIST, hiding)), ['vendas', 'agenda', 'pipeline']);
  assert.deepEqual(slugs(hiddenApps(LIST, hiding)), ['reportes']);
  // The same slug in two projects is two apps.
  const both = [app('crm', '2026-11-01T10:00:00Z', 'w1'), app('crm', '2026-11-02T10:00:00Z', 'w2')];
  assert.deepEqual(arrangeApps(both, order({ hidden: ['w2/crm'] })).map(appKey), ['w1/crm']);
  // Entries for apps that are not there (a project offline) change nothing.
  assert.deepEqual(slugs(arrangeApps(LIST, order({ pinned: ['w9/gone'], order: ['w9/other', 'w1/pipeline'] }))), ['pipeline', 'reportes', 'agenda', 'vendas']);
});

test('moving an app trades places with its neighbour and writes the whole order down', () => {
  // Shown: reportes, agenda, vendas, pipeline.
  assert.equal(canMoveApp(LIST, EMPTY_ORDER, 'w1/reportes', -1), false);
  assert.equal(canMoveApp(LIST, EMPTY_ORDER, 'w1/reportes', 1), true);
  assert.equal(canMoveApp(LIST, EMPTY_ORDER, 'w1/pipeline', 1), false);
  assert.equal(canMoveApp(LIST, EMPTY_ORDER, 'w9/gone', 1), false);
  const moved = moveApp(LIST, EMPTY_ORDER, 'w1/vendas', -1);
  assert.deepEqual(moved.order, ['w1/reportes', 'w1/vendas', 'w2/agenda', 'w1/pipeline']);
  assert.deepEqual(slugs(arrangeApps(LIST, moved)), ['reportes', 'vendas', 'agenda', 'pipeline']);
  // An app the agent changes later does not jump: the order is the person's now.
  const touched = LIST.map(item => item.slug === 'pipeline' ? { ...item, updated_at: '2026-12-01T00:00:00Z' } : item);
  assert.deepEqual(slugs(arrangeApps(touched, moved)), ['reportes', 'vendas', 'agenda', 'pipeline']);
  // A new app comes after what was arranged.
  assert.deepEqual(slugs(arrangeApps([...LIST, app('novo', '2026-12-02T00:00:00Z')], moved)), ['reportes', 'vendas', 'agenda', 'pipeline', 'novo']);
  // At an end nothing changes, and the same object comes back.
  assert.equal(moveApp(LIST, moved, 'w1/reportes', -1), moved);
  assert.equal(moveApp(LIST, moved, 'w1/pipeline', 1), moved);
});

test('pinned apps move among themselves, and entries for absent apps are kept', () => {
  const prefs = order({ pinned: ['w1/vendas', 'w9/offline', 'w1/pipeline'], order: ['w9/other'] });
  assert.equal(canMoveApp(LIST, prefs, 'w1/vendas', -1), false);
  assert.equal(canMoveApp(LIST, prefs, 'w1/vendas', 1), true);
  const down = moveApp(LIST, prefs, 'w1/vendas', 1);
  assert.deepEqual(down.pinned, ['w1/pipeline', 'w1/vendas', 'w9/offline']);
  assert.deepEqual(down.order, ['w9/other'], 'the rest is untouched');
  // The last pinned app cannot move into the rest: unpin it for that.
  assert.equal(canMoveApp(LIST, down, 'w1/vendas', 1), false);
  const rest = moveApp(LIST, prefs, 'w2/agenda', -1);
  assert.deepEqual(rest.order, ['w2/agenda', 'w1/reportes', 'w9/other']);
  assert.deepEqual(rest.pinned, prefs.pinned);
});

test('pinning shows a hidden app again, and hiding unpins', () => {
  let prefs = setAppPinned(EMPTY_ORDER, 'w1/vendas', true);
  prefs = setAppPinned(prefs, 'w1/pipeline', true);
  assert.deepEqual(prefs.pinned, ['w1/vendas', 'w1/pipeline'], 'a newly pinned app goes after the ones already pinned');
  assert.equal(isPinnedApp(prefs, 'w1/vendas'), true);
  prefs = setAppHidden(prefs, 'w1/vendas', true);
  assert.deepEqual([prefs.pinned, prefs.hidden], [['w1/pipeline'], ['w1/vendas']]);
  assert.equal(isHiddenApp(prefs, 'w1/vendas'), true);
  assert.equal(isPinnedApp(prefs, 'w1/vendas'), false);
  prefs = setAppPinned(prefs, 'w1/vendas', true);
  assert.deepEqual([prefs.pinned, prefs.hidden], [['w1/pipeline', 'w1/vendas'], []]);
  prefs = setAppPinned(prefs, 'w1/pipeline', false);
  assert.deepEqual(prefs.pinned, ['w1/vendas']);
  assert.deepEqual(setAppHidden(setAppHidden(prefs, 'w2/agenda', true), 'w2/agenda', false).hidden, []);
  // None of these change what they were given.
  assert.deepEqual(EMPTY_ORDER, { pinned: [], order: [], hidden: [] });
});

test('an arrangement read from anywhere is made safe before it is used', () => {
  assert.deepEqual(tidyOrder(undefined), { pinned: [], order: [], hidden: [] });
  assert.deepEqual(tidyOrder('pinned'), { pinned: [], order: [], hidden: [] });
  assert.deepEqual(tidyOrder([1, 2]), { pinned: [], order: [], hidden: [] });
  assert.deepEqual(tidyOrder({ pinned: ['w1/a', 'w1/a', 7, 'no-slash', 'w1/b'], order: null, hidden: ['w1/b'], extra: true }), { pinned: ['w1/a'], order: [], hidden: ['w1/b'] });
});

test('a change shows at once, and comes back if it could not be saved', async () => {
  resetHubSettings();
  hubSettings.value = { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser', mesa_sidebar: 'icons', app_order: { pinned: [], order: [], hidden: [] } };
  const next = order({ pinned: ['w1/vendas'] });
  let during;
  assert.equal(await changeAppOrder(next, async sent => { during = hubSettings.value.app_order; assert.deepEqual(sent, next); }), true);
  assert.deepEqual(during, next, 'on screen before the server answers');
  assert.equal(appOrderError.value, '');

  const failed = await changeAppOrder(order({ hidden: ['w1/vendas'] }), async () => { throw new Error('offline'); });
  assert.equal(failed, false);
  assert.deepEqual(hubSettings.value.app_order, next, 'what was there is back');
  assert.match(appOrderError.value, /offline/);
  // The next change clears the message.
  await changeAppOrder(next, async () => {});
  assert.equal(appOrderError.value, '');
  // With the settings never read (a server without them) nothing is invented.
  resetHubSettings();
  assert.equal(await changeAppOrder(next, async () => {}), true);
  assert.equal(hubSettings.value, undefined);
});

// ---------------------------------------------------------------- what the rail decides

test('the rail is for the Mesa on a desktop-width window with the preference on icons', () => {
  const on = { page: undefined, wide: true, mobile: false, preference: 'icons' };
  assert.equal(sidebarLayout(on), 'rail');
  assert.equal(sidebarLayout({ ...on, preference: 'expanded' }), 'expanded');
  for (const page of ['home', 'apps', 'settings', 'inbox', 'skills', 'automations', 'integrations', 'sessions']) assert.equal(sidebarLayout({ ...on, page }), 'expanded', page);
  // Stage B: an app in full screen keeps the rail alone, whatever the Mesa preference is.
  assert.equal(sidebarLayout({ ...on, page: 'app' }), 'app');
  assert.equal(sidebarLayout({ ...on, page: 'app', preference: 'expanded' }), 'app');
  assert.equal(sidebarLayout({ ...on, page: 'app', wide: false, mobile: true }), 'expanded');
  // Below the column width the sidebar is a drawer, exactly as before.
  assert.equal(sidebarLayout({ ...on, wide: false, mobile: true }), 'expanded');
  assert.equal(sidebarLayout({ ...on, wide: false }), 'expanded');
  assert.equal(sidebarLayout({ ...on, mobile: true }), 'expanded');
});

test('the rail lists the pages in the order of the plan, and keeps the others behind More', () => {
  assert.deepEqual(RAIL_NAV.map(item => item.id), ['home', 'canvas', 'skills', 'integrations', 'automations']);
  assert.deepEqual(RAIL_MORE.map(item => item.id), ['sessions', 'usage', 'system']);
  const icons = /const paths[^=]*=\s*\{([\s\S]*?)\n\};/.exec(read('../Icon.vue'))?.[1] ?? read('../Icon.vue');
  for (const item of [...RAIL_NAV, ...RAIL_MORE]) {
    assert.ok(item.label && item.icon, item.id);
    assert.match(icons, new RegExp(`\\b${item.icon}:`), `Icon.vue draws ${item.icon}`);
  }
});

test('arrows walk the rail and wrap at the ends; other keys are left alone', () => {
  assert.equal(rovingIndex('ArrowDown', 0, 5), 1);
  assert.equal(rovingIndex('ArrowDown', 4, 5), 0);
  assert.equal(rovingIndex('ArrowUp', 0, 5), 4);
  assert.equal(rovingIndex('ArrowUp', 3, 5), 2);
  assert.equal(rovingIndex('Home', 3, 5), 0);
  assert.equal(rovingIndex('End', 1, 5), 4);
  // Focus that is not on an item yet starts at an end.
  assert.equal(rovingIndex('ArrowDown', -1, 5), 0);
  assert.equal(rovingIndex('ArrowUp', -1, 5), 4);
  for (const key of ['Enter', ' ', 'Tab', 'ArrowLeft', 'ArrowRight', 'a', 'Escape']) assert.equal(rovingIndex(key, 2, 5), undefined, key);
  assert.equal(rovingIndex('ArrowDown', 0, 0), undefined);
  // The options of an app: the menu key, Shift+F10, or the arrow towards where the menu opens.
  assert.equal(opensOptions({ key: 'ContextMenu' }), true);
  assert.equal(opensOptions({ key: 'ArrowRight' }), true);
  assert.equal(opensOptions({ key: 'F10', shiftKey: true }), true);
  assert.equal(opensOptions({ key: 'F10' }), false);
  assert.equal(opensOptions({ key: 'Enter' }), false);
});

test('the rail knows which apps are open from the panes of the Mesa', () => {
  const pane = appPane(LIST[0]);
  assert.equal(appPaneKey(pane), 'w1/pipeline');
  assert.equal(appPaneKey({ kind: 'agent_chat', metadata: { workspace_id: 'w1', session_id: 's1' } }), undefined);
  assert.equal(appPaneKey({ kind: 'app', metadata: { workspace_id: 'w1' } }), undefined);
  assert.equal(appPaneKey(undefined), undefined);
  assert.deepEqual(openAppKeys([pane, { kind: 'editor', metadata: { workspace_id: 'w1', path: 'a.md' } }, appPane(LIST[3]), pane]), ['w1/pipeline', 'w2/agenda']);
  // The key is the one the order uses.
  assert.equal(appPaneKey(pane), appKey(LIST[0]));
});

test('what flies out of the rail stays inside the window; the bell caps its number', () => {
  assert.deepEqual(flyoutPlace({ top: 200, right: 56, height: 40 }, 800, 150), { left: 64, top: 200 });
  assert.deepEqual(flyoutPlace({ top: 760, right: 56, height: 40 }, 800, 150), { left: 64, top: 642 }, 'pulled up from the bottom edge');
  assert.deepEqual(flyoutPlace({ top: -30, right: 56, height: 40 }, 800, 150), { left: 64, top: 8 });
  assert.deepEqual(flyoutPlace({ top: 100, right: 56, height: 40 }, 120, 400), { left: 64, top: 8 }, 'taller than the window: start at the top');
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(undefined), '');
  assert.equal(badgeText(3), '3');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(250), '99+');
});

test('the sidebar choice follows the server, and a failed save changes nothing', async () => {
  resetHubSettings();
  assert.equal(mesaSidebar.value, 'icons', 'icons until told otherwise');
  hubSettings.value = { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser', mesa_sidebar: 'expanded', app_order: { pinned: [], order: [], hidden: [] } };
  assert.equal(mesaSidebar.value, 'expanded');
  // Something that is neither choice (an older server, a typo) is icons.
  hubSettings.value = { ...hubSettings.value, mesa_sidebar: 'floating' };
  assert.notEqual(mesaSidebar.value, 'floating');

  hubSettings.value = { ...hubSettings.value, mesa_sidebar: 'icons' };
  assert.equal(await setMesaSidebar('expanded', async () => { throw new Error('offline'); }), 'offline');
  assert.equal(mesaSidebar.value, 'icons', 'nothing flips until it is saved');
  assert.equal(await setMesaSidebar('expanded', async choice => { assert.equal(choice, 'expanded'); }), '');
  assert.equal(mesaSidebar.value, 'expanded');
  resetHubSettings();
});

// ---------------------------------------------------------------- what the components draw

let server, Rail, SideApps, Menu, Panel, i18n, store, settings;
before(async () => {
  server = await createServer({ configFile: false, root: fileURLToPath(new URL('../../../', import.meta.url)), plugins: [vue()], server: { middlewareMode: true, hmr: false, ws: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  Rail = (await server.ssrLoadModule('/src/features/hub/IconRail.vue')).default;
  SideApps = (await server.ssrLoadModule('/src/features/hub/SidebarApps.vue')).default;
  Menu = (await server.ssrLoadModule('/src/features/hub/AppOrderMenu.vue')).default;
  Panel = (await server.ssrLoadModule('/src/features/hub/AddressesPanel.vue')).default;
  i18n = await server.ssrLoadModule('/src/i18n/index.ts');
  store = await server.ssrLoadModule('/src/features/hub/apps.ts');
  settings = await server.ssrLoadModule('/src/features/hub/settings.ts');
});
after(async () => { await server?.close(); });

const render = (component, props) => renderToString(createSSRApp(component, props));
const tags = (html, pattern) => html.match(pattern) ?? [];
const SETTINGS = { timezone: 'America/Sao_Paulo', public_base_url: '', dictation: 'browser', mesa_sidebar: 'icons', app_order: { pinned: [], order: [], hidden: [] } };
function stage(list, appOrder = {}, locale = 'en') {
  i18n.useI18n().setLocale(locale);
  store.apps.list = list; store.apps.loaded = true; store.apps.errors = []; store.apps.error = '';
  settings.resetHubSettings();
  settings.hubSettings.value = { ...SETTINGS, app_order: { ...SETTINGS.app_order, ...appOrder } };
  settings.hubSettingsKnown.value = true;
}
const RAIL_PROPS = { currentPage: 'canvas', inboxUnread: 0, panelOpen: true, workspaces: [] };

test('every icon of the rail has a name, and the rail is one Tab stop', async () => {
  stage(LIST);
  const html = await render(Rail, RAIL_PROPS);
  const items = tags(html, /<button[^>]*data-rail-id="[^"]*"[^>]*>/g);
  assert.equal(items.length, 5 + 1 + LIST.length + 4, 'pages, the catalog, every app, and the foot');
  for (const item of items) {
    assert.match(item, /aria-label="[^"]+"/, item);
    assert.match(item, /type="button"/, item);
    assert.match(item, /data-tip="[^"]+"/, `the name shows beside it: ${item}`);
  }
  const labels = items.map(item => /aria-label="([^"]*)"/.exec(item)[1]);
  assert.deepEqual(labels, ['Home', 'Workspace canvas', 'Skills', 'Integrations', 'Automations', 'Apps', 'Reportes', 'Agenda', 'Vendas', 'Pipeline', 'Notifications', 'Report a problem', 'More', 'Settings']);
  assert.equal(items.filter(item => /tabindex="0"/.test(item)).length, 1, 'one Tab stop');
  assert.equal(items.filter(item => /tabindex="-1"/.test(item)).length, items.length - 1);
  assert.match(items[1], /aria-current="page"/, 'the Mesa is where the rail is');
  assert.match(items[1], /tabindex="0"/, 'Tab lands on the current page');
  assert.match(html, /<nav[^>]*aria-label="Main navigation"/);
  assert.match(html, /role="toolbar"[^>]*aria-orientation="vertical"/);
  assert.match(html, /id="rail-app-hint"[^>]*>Press the right arrow for options\./);
  // Nothing is open, so no dot; no unread, so no badge.
  assert.doesNotMatch(html, /rail-open-dot|rail-badge/);
  // The menus and the tip are drawn only when asked for.
  assert.doesNotMatch(html, /rail-flyout|rail-tip|role="menu"/);
});

test('app tiles follow the order, can be dragged, and show which app is open', async () => {
  stage(LIST, { pinned: ['w1/vendas'], hidden: ['w1/reportes'] });
  const html = await render(Rail, { ...RAIL_PROPS, currentApp: 'w2/agenda', openApps: ['w2/agenda', 'w1/pipeline'] });
  const tiles = tags(html, /<button[^>]*data-rail-app="[^"]*"[^>]*>/g);
  assert.deepEqual(tiles.map(tile => /data-rail-app="([^"]*)"/.exec(tile)[1]), ['w1/vendas', 'w2/agenda', 'w1/pipeline'], 'pinned first, the hidden one left out');
  for (const tile of tiles) {
    assert.match(tile, /draggable="true"/);
    assert.match(tile, /aria-describedby="rail-app-hint"/);
  }
  assert.match(tiles[1], /aria-current="true"/);
  assert.match(tiles[1], /class="[^"]*\bcurrent\b[^"]*\bopen\b/);
  assert.doesNotMatch(tiles[0], /aria-current/);
  assert.match(tiles[2], /class="[^"]*\bopen\b/);
  assert.equal(tags(html, /rail-open-dot/g).length, 2);
  // The letter tile itself is decoration: the button carries the name.
  assert.match(html, /<span class="app-tile"[^>]*aria-hidden="true"[^>]*>V<\/span>/);
});

test('the bell shows how many are unread, in the badge and in its name', async () => {
  stage([]);
  let html = await render(Rail, { ...RAIL_PROPS, inboxUnread: 3 });
  assert.match(html, /aria-label="Notifications, 3 unread"/);
  assert.match(html, /<small class="rail-badge"[^>]*aria-hidden="true"[^>]*>3<\/small>/);
  html = await render(Rail, { ...RAIL_PROPS, inboxUnread: 240 });
  assert.match(html, /aria-label="Notifications, 240 unread"/);
  assert.match(html, /<small class="rail-badge"[^>]*>99\+<\/small>/);
  // With no apps the rail still has the catalog icon to make the first one.
  assert.equal(tags(html, /data-rail-app=/g).length, 0);
  assert.match(html, /data-rail-id="nav:apps"/);
});

test('the panel handle says what it does, open and folded, and the rail speaks Portuguese', async () => {
  stage(LIST.slice(0, 1));
  let html = await render(Rail, RAIL_PROPS);
  let handle = tags(html, /<button[^>]*class="[^"]*rail-panel-toggle[^"]*"[^>]*>/g)[0];
  assert.match(handle, /aria-expanded="true"/);
  assert.match(handle, /aria-label="Hide the workspaces and conversations panel"/);
  html = await render(Rail, { ...RAIL_PROPS, panelOpen: false });
  handle = tags(html, /<button[^>]*class="[^"]*rail-panel-toggle[^"]*"[^>]*>/g)[0];
  assert.match(handle, /aria-expanded="false"/);
  assert.match(handle, /class="[^"]*\bfolded\b/);
  assert.match(handle, /aria-label="Show the workspaces and conversations panel"/);

  stage(LIST.slice(0, 1), {}, 'pt-BR');
  html = await render(Rail, { ...RAIL_PROPS, inboxUnread: 2 });
  for (const label of ['Início', 'Mesa', 'Habilidades', 'Integrações', 'Automações', 'Apps', 'Notificações, 2 não lidas', 'Reportar um problema', 'Mais', 'Configurações', 'Esconder o painel de workspaces e conversas']) {
    assert.ok(html.includes(`aria-label="${label}"`), label);
  }
  i18n.useI18n().setLocale('en');
});

test('the expanded sidebar lists up to eight apps, with the catalog link, "+" and "See all"', async () => {
  const many = Array.from({ length: 11 }, (_, n) => app(`app-${String(n).padStart(2, '0')}`, `2026-11-${String(n + 1).padStart(2, '0')}T10:00:00Z`));
  stage(many, { hidden: ['w1/app-10'] });
  let html = await render(SideApps);
  assert.match(html, /<section[^>]*aria-label="Apps"/);
  assert.match(html, /<button[^>]*class="side-apps-title"[^>]*>(?:<!--[^>]*-->)*<span[^>]*>Apps<\/span>/);
  assert.match(html, /<button[^>]*aria-label="New app"/);
  const rows = tags(html, /<button[^>]*class="side-app"[^>]*>/g);
  assert.equal(rows.length, 8);
  for (const row of rows) assert.match(row, /draggable="true"/);
  const names = [...html.matchAll(/class="side-app"[^>]*>.*?<span[^>]*>([^<]*)<\/span><\/button>/g)].map(match => match[1]);
  assert.deepEqual(names.slice(0, 3), ['App-09', 'App-08', 'App-07'], 'latest first, the hidden one left out');
  assert.equal(tags(html, /aria-label="Options for [^"]+"/g).length, 8, 'each row has its options');
  assert.match(html, /See all \(11\)/, 'the count is of every app, hidden ones too');
  assert.doesNotMatch(html, /role="menu"/, 'no menu until asked for');
  // The old wrapped chips are gone.
  assert.doesNotMatch(html, /sidebar-app\b/);

  stage(LIST);
  html = await render(SideApps);
  assert.equal(tags(html, /class="side-app"/g).length, 4);
  assert.match(html, />See all<\/button>/);
  assert.doesNotMatch(html, /See all \(/);

  // No apps yet: the header stays, so the first one can be made from here.
  stage([]);
  html = await render(SideApps);
  assert.match(html, /aria-label="New app"/);
  assert.doesNotMatch(html, /side-apps-list|side-apps-all/);
});

test('the options of an app say what they will do, and which moves are possible', async () => {
  stage(LIST);
  let html = await render(Menu, { app: LIST[1] });
  assert.match(html, /role="menu"[^>]*aria-label="Options for Reportes"/);
  const item = (source, action) => tags(source, new RegExp(`<button[^>]*data-action="${action}"[^>]*>.*?</button>`, 'g'))[0] ?? '';
  assert.match(item(html, 'pin'), /Pin to the top/);
  assert.match(item(html, 'up'), /disabled/, 'reportes is first: it cannot go up');
  assert.doesNotMatch(item(html, 'down'), /disabled/);
  assert.match(item(html, 'hide'), />Hide</);
  assert.equal(tags(html, /role="menuitem"/g).length, 4);

  stage(LIST, { pinned: ['w1/reportes'], hidden: ['w1/vendas'] });
  html = await render(Menu, { app: LIST[1] });
  assert.match(item(html, 'pin'), /Unpin/);
  assert.match(item(html, 'down'), /disabled/, 'the only pinned app has no neighbour');
  html = await render(Menu, { app: LIST[2] });
  assert.match(item(html, 'hide'), /Show again/);
  assert.match(item(html, 'up'), /disabled/);
  assert.match(item(html, 'down'), /disabled/);
  assert.match(html, /Hidden: it is only on the Apps page\./);
});

test('Settings offers "Sidebar on the Mesa" with the saved choice selected', async () => {
  stage([]);
  settings.zoneList.value = { zones: ['America/Sao_Paulo'], server: 'America/Sao_Paulo' };
  let html = await render(Panel);
  assert.match(html, /role="radiogroup"[^>]*aria-labelledby="addr-sidebar-title"/);
  assert.match(html, /<h2[^>]*id="addr-sidebar-title"[^>]*>Sidebar on the Mesa<\/h2>/);
  const radios = source => tags(source, /<input[^>]*type="radio"[^>]*>/g);
  assert.equal(radios(html).length, 2);
  assert.match(radios(html)[0], /value="icons"/);
  assert.match(radios(html)[0], /checked/);
  assert.doesNotMatch(radios(html)[1], /checked/);
  assert.match(html, /<strong[^>]*>Icons<\/strong>/);
  assert.match(html, /<strong[^>]*>Expanded<\/strong>/);
  assert.match(html, /On a phone it stays a drawer\./);

  settings.hubSettings.value = { ...SETTINGS, mesa_sidebar: 'expanded' };
  html = await render(Panel);
  assert.doesNotMatch(radios(html)[0], /checked/);
  assert.match(radios(html)[1], /checked/);
  settings.resetHubSettings();
});

// ---------------------------------------------------------------- how it is wired

test('the shell shows the rail on the Mesa and strips the sidebar to its lists', () => {
  const shell = read('../../App.vue');
  assert.match(shell, /const sidebarMode = computed\(\(\) => sidebarLayout\(\{ page: page\.value, wide: sidebarRail\.value, mobile: mobile\.value, preference: mesaSidebar\.value \}\)\)/);
  assert.match(shell, /const railMode = computed\(\(\) => sidebarMode\.value !== "expanded"\)/);
  assert.match(shell, /'hub-rail-on': railMode/);
  // Since stage B a tile opens the app in full screen; "Report a problem" still opens its app on the Mesa.
  assert.match(shell, /<IconRail v-if="railMode"[^>]*:current-app="appFocus \? routeApp : appPaneKey\(focusedPane\)"[^>]*:open-apps="openAppKeys\(openPanes\)"[^>]*@open-app="openAppPage"[^>]*@open-on-mesa="openApp"[^>]*@toggle-panel="toggleSidebar"\/>/);
  assert.match(shell, /<WorkspaceSidebar ref="workspaceSidebar" :compact="railMode"/);
  // The rail comes before the panel, so Tab reaches it first.
  assert.ok(shell.indexOf('<IconRail') < shell.indexOf('<aside :class="[\'sidebar\''));
  // The settings are read once the browser is let in.
  assert.match(shell, /void loadHubSettings\(\);/);

  const css = read('../../styles.css');
  assert.match(css, /\.hub-rail-on \.app-body \{ --hub-rail: 56px; grid-template-columns: var\(--hub-rail\) var\(--rail-left\) minmax\(0, 1fr\) var\(--rail-right\); \}/);
  for (const [selector, column] of [['.hub-rail', 1], ['.sidebar', 2], ['.main-workspace', 3], ['.explorer-panel', 4]]) {
    assert.ok(css.includes(`.hub-rail-on ${selector} { grid-column: ${column}; }`), selector);
  }
  // A collapsed panel still gives its column back, with the rail in place.
  assert.match(css, /\.sidebar-collapsed \.app-body \{ --rail-left: 0px; \}/);
});

test('the sidebar keeps its lists whole, and the menu only where the rail is not', () => {
  const sidebar = read('../WorkspaceSidebar.vue');
  assert.match(sidebar, /<nav v-if="!compact" class="workspace-global-nav"/);
  assert.match(sidebar, /<SidebarApps v-if="!compact" @catalog="emit\('apps'\)" @open-app="emit\('openAppPage', \$event\)" \/>/);
  assert.match(sidebar, /<ReportProblem v-if="!compact" :workspaces="projectWorkspaces" :on-mesa="currentPage === 'canvas'"/);
  assert.doesNotMatch(sidebar, /sidebar-app\b|sidebarApps/, 'the wrapped chips are gone');
  // The Workspaces/Conversations switch and the lists are in both layouts.
  const template = /<template>([\s\S]*)<\/template>/.exec(sidebar)[1];
  assert.doesNotMatch(/<div class="sidebar-view-switch"[^>]*>/.exec(template)[0], /compact/);
  assert.doesNotMatch(/<ConversationsBar[^>]*>/.exec(template)[0], /compact/);
  // The fixes of the short window stay: the switch never shrinks, the lists keep 180px, the sidebar scrolls.
  assert.match(sidebar, /\.sidebar-view-switch \{ container-type: inline-size; display: flex; flex-shrink: 0;/);
  assert.match(sidebar, /\.workspace-sidebar \{ overflow-y: auto; \}/);
  assert.match(sidebar, /\.workspace-sidebar > \.workspace-groups \{ flex: 1 0 180px; \}/);
  // The way back to the rail is in the sidebar's foot, and not in a phone's drawer.
  const foot = read('ReportProblem.vue');
  assert.match(foot, /<button v-if="onMesa"[^>]*class="nav-item report-button only-icons"/);
  assert.match(foot, /setMesaSidebar\("icons"\)/);
  assert.match(foot, /@media \(max-width: 760px\) \{ \.only-icons \{ display: none; \} \}/);
});

test('an app is dragged to the Mesa as the pane a click would open', () => {
  for (const file of ['IconRail.vue', 'SidebarApps.vue']) {
    const source = read(file);
    assert.match(source, /setData\("application\/tendly-pane", JSON\.stringify\(appPane\(app\)\)\)/, file);
    assert.match(source, /draggable="true"[^>]*@dragstart="drag\(\$event, app\)"/, file);
  }
  // The Mesa takes that payload as it takes a conversation dragged from the list.
  assert.match(read('../../components/LayoutNode.vue'), /getData\("application\/tendly-pane"\)/);
  const pane = appPane(LIST[0]);
  assert.equal(pane.kind, 'app');
  assert.deepEqual([pane.metadata.workspace_id, pane.metadata.slug], ['w1', 'pipeline']);
  assert.ok(JSON.stringify(pane).length < 32768, 'within what a drop accepts');
});

test('Home and the Apps page follow the same order', () => {
  const home = read('HomePage.vue');
  assert.match(home, /const homeApps = computed\(\(\) => arrangedApps\.value\.slice\(0, 8\)\)/);
  const page = read('AppsPage.vue');
  assert.match(page, /const sorted = computed\(\(\) => \[\.\.\.arrangedApps\.value, \.\.\.hiddenAppList\.value\]\)/);
  assert.match(page, /<AppOrderMenu v-if="menuKey === appKey\(app\)"/);
  assert.match(page, /t\('Hidden'\)/);
  // "+" beside Apps puts the cursor in the form of the Apps page.
  assert.match(read('SidebarApps.vue'), /apps\.wantCreate = true; emit\("catalog"\)/);
  assert.match(page, /watch\(\(\) => apps\.wantCreate/);
});

// ---------------------------------------------------------------- translations and design rules

test('every string of this stage has a Brazilian Portuguese translation with the same placeholders', () => {
  const raw = readFileSync(new URL('../../i18n/pt-BR.json', here), 'utf8');
  const translations = JSON.parse(raw);
  // Strings chosen by a value, which the scan below can not see.
  const keys = new Set([
    ...RAIL_NAV.map(item => item.label), ...RAIL_MORE.map(item => item.label),
    'Icons', 'Expanded', 'The full sidebar with names, as on Home and the other pages.',
    'A narrow rail with the pages, your apps and the bell. Workspaces and conversations get a panel of their own beside it.',
    'Unpin', 'Pin to the top', 'Show again', 'Hide', 'See all', 'See all ({count})', 'Saving…', 'Show only icons here', 'Opening…', 'Report a problem',
    'Hide the workspaces and conversations panel', 'Show the workspaces and conversations panel',
  ]);
  for (const file of COMPONENTS) {
    for (const match of read(file).matchAll(/\bt\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)) keys.add(match[2]);
  }
  assert.ok(keys.size >= 40, `found ${keys.size} strings`);
  const placeholders = text => (text.match(/\{\w+\}/g) ?? []).sort();
  for (const key of keys) {
    assert.ok(!key.includes('\\'), `write ${JSON.stringify(key)} without an escape`);
    assert.ok(key in translations, `missing pt-BR for ${JSON.stringify(key)}`);
    assert.deepEqual(placeholders(translations[key]), placeholders(key), key);
  }
  assert.equal(translations['Sidebar on the Mesa'], 'Barra lateral na Mesa');
  assert.equal(translations['Pin to the top'], 'Fixar no topo');
  // The file keeps its shape: one space of indentation, no trailing newline.
  assert.equal(raw, JSON.stringify(translations, null, 1));
});

test('the new pieces keep the design rules: tokens, focus ring, touch targets, no native confirm', () => {
  for (const file of NEW_COMPONENTS) {
    const source = read(file);
    const css = [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
    assert.ok(css.length > 100, file);
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, `${file}: colours come from tokens`);
    assert.doesNotMatch(css, /font-size\s*:\s*[0-9.]+px/, `${file}: sizes come from --text-*`);
    assert.doesNotMatch(css, /border-radius\s*:\s*[0-9.]+px/, `${file}: radii come from --radius-*`);
    assert.doesNotMatch(css, /outline\s*:\s*(none|0)\b/, `${file}: the focus ring stays`);
    assert.match(css, /@media \(pointer: coarse\)[^{]*\{[^@]*44px/, `${file}: 44px targets on touch`);
    assert.doesNotMatch(source, /window\.confirm|\bconfirm\(|\balert\(/, file);
    // Nothing here starts a conversation or runs an agent.
    assert.doesNotMatch(source, /\/hub\/start|startConversation/, file);
  }
  const rail = read('IconRail.vue');
  // The rail clips what spills over its edge, so the ring is drawn inside the item.
  assert.match(rail, /\.rail-item:focus-visible, \.rail-panel-toggle:focus-visible \{ outline-offset: -2px; \}/);
  assert.match(rail, /@media \(prefers-reduced-motion: reduce\)/);
  // Many apps scroll on their own, between the navigation and the foot.
  assert.match(rail, /\.rail-apps \{[^}]*flex: 1 0 84px;[^}]*overflow-y: auto;/);
  // What flies out is drawn on the body: a panel with a backdrop filter would trap a fixed box.
  assert.match(rail, /<Teleport to="body">/);
  // "Report a problem" in the rail makes its app on a click only, as the sidebar's does.
  assert.equal(rail.match(/openReportApp\(/g).length, 1);
  assert.match(rail, /async function report\(event: MouseEvent\) \{[\s\S]*?openReportApp\(/);
  assert.match(rail, /data-rail-id="foot:report"[^>]*@click="report"/);
});
