<script setup lang="ts">
/**
 * The icon rail of the Mesa: the global navigation as a narrow column, every
 * app as a tile, and the bell, "Report a problem" and Settings at the bottom.
 * The Workspaces/Conversations panel is the column beside it; the small handle
 * on that panel's edge folds it away and brings it back.
 *
 * One Tab stop: the arrows walk the items, Enter opens the one in focus, and
 * → (or the menu key) on an app opens its options.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { errorMessage } from "../api";
import { appPane } from "../pane-context";
import AppTile from "./AppTile.vue";
import AppOrderMenu from "./AppOrderMenu.vue";
import { apps, refreshApps, type HubApp } from "./apps";
import { appKey, arrangedApps } from "./app-order";
import { inbox } from "./inbox";
import { openReportApp } from "./report";
import { RAIL_MORE, RAIL_NAV, badgeText, flyoutPlace, opensOptions, rovingIndex, setMesaSidebar, type RailTarget } from "./rail";
import { refreshShortcuts, shortcutKey, shortcuts, type Shortcut } from "./shortcuts";

const props = withDefaults(defineProps<{
  /** The page on screen ("canvas" on the Mesa), for the current item. */
  currentPage: string;
  inboxUnread?: number;
  /** The app in the focused pane, as `<workspace id>/<slug>`. */
  currentApp?: string;
  /** Every app with a tab open on the Mesa. */
  openApps?: string[];
  /** Whether the Workspaces/Conversations panel beside the rail is showing. */
  panelOpen: boolean;
  /** False where the rail stands alone (an app in full screen): no panel, so no handle for it. */
  panel?: boolean;
  workspaces: Workspace[];
}>(), { inboxUnread: 0, openApps: () => [], panel: true });
const emit = defineEmits<{
  go: [target: RailTarget];
  /** A tile was pressed: the app in full screen. */
  openApp: [app: HubApp];
  /** "Report a problem": its app in a tab of the Mesa, beside what you were doing. */
  openOnMesa: [app: HubApp];
  /** A shortcut's tile: the site, in a pane or a tab (App.vue decides). */
  openShortcut: [shortcut: Shortcut];
  /** "+": the Apps page with the cursor in "Create with the agent". */
  newApp: [];
  togglePanel: [];
}>();
const { t } = useI18n();

const root = ref<HTMLElement>(), flyout = ref<HTMLElement>();
const tiles = computed(() => arrangedApps.value);
const openSet = computed(() => new Set(props.openApps));
const badge = computed(() => badgeText(props.inboxUnread));
const bellLabel = computed(() => badge.value ? t('Notifications, {count} unread', { count: props.inboxUnread }) : t('Notifications'));
onMounted(() => { if (!apps.loaded) void refreshApps(); if (!shortcuts.loaded) void refreshShortcuts(); });

// ---------------------------------------------------------------- one Tab stop, arrows inside

const ids = computed(() => [...RAIL_NAV.map(item => `nav:${item.id}`), "nav:apps", ...tiles.value.map(app => `app:${appKey(app)}`), ...shortcuts.list.map(item => `link:${shortcutKey(item)}`), "nav:new", "foot:inbox", "foot:report", "foot:more", "foot:settings"]);
const active = ref("nav:canvas");
watch(ids, list => { if (!list.includes(active.value)) active.value = "nav:canvas"; });
const tab = (id: string) => active.value === id ? 0 : -1;
const railItems = () => Array.from(root.value?.querySelectorAll<HTMLElement>("[data-rail-id]") ?? []);
const itemOf = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>("[data-rail-id]") : null;

function onFocus(event: FocusEvent) {
  const item = itemOf(event.target);
  if (!item?.dataset.railId) return;
  active.value = item.dataset.railId;
  let byKeyboard = false;
  try { byKeyboard = item.matches(":focus-visible"); } catch { /* An old browser: no tip on focus. */ }
  if (byKeyboard) showTip(item);
}
function onKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const item = itemOf(event.target);
  if (!item) return;
  if (event.key === "Escape") { hideTip(); return; }
  if (item.dataset.railApp && opensOptions(event)) { event.preventDefault(); openMenu({ kind: "app", key: item.dataset.railApp }, item, true); return; }
  const list = railItems(), next = rovingIndex(event.key, list.indexOf(item), list.length);
  if (next === undefined) return;
  event.preventDefault();
  list[next]?.focus();
}

// ---------------------------------------------------------------- the name beside an icon

const tip = ref<{ text: string; left: number; top: number }>();
function showTip(item: HTMLElement) {
  const text = item.dataset.tip;
  if (!text || menu.value) { tip.value = undefined; return; }
  const box = item.getBoundingClientRect();
  tip.value = { text, left: Math.round(box.right + 8), top: Math.round(box.top + box.height / 2) };
}
function hideTip() { tip.value = undefined; }
function onHover(event: MouseEvent) { const item = itemOf(event.target); if (item) showTip(item); else hideTip(); }

// ---------------------------------------------------------------- what flies out of the rail

type Menu = { kind: "app"; key: string } | { kind: "more" } | { kind: "notice"; text: string };
const menu = ref<Menu>();
const place = ref({ left: 0, top: 0 });
/** Whether the menu was asked for with the keyboard: then it takes the focus, and gives it back when it closes. */
let opener: HTMLElement | undefined, keyboardMenu = false;
const menuApp = computed(() => { const current = menu.value; return current?.kind === "app" ? apps.list.find(app => appKey(app) === current.key) : undefined; });

function settle() {
  if (!opener?.isConnected) return;
  place.value = flyoutPlace(opener.getBoundingClientRect(), window.innerHeight, flyout.value?.offsetHeight ?? 0);
}
function openMenu(next: Menu, from: HTMLElement, byKeyboard = false) {
  hideTip();
  opener = from; keyboardMenu = byKeyboard;
  menu.value = next;
  settle();
  void nextTick(() => {
    settle();
    if (next.kind !== "app") flyout.value?.querySelector<HTMLElement>("button")?.focus();
  });
}
const appsButton = () => root.value?.querySelector<HTMLElement>('[data-rail-id="nav:apps"]');
function closeMenu(restoreFocus = false) {
  if (!menu.value) return;
  menu.value = undefined;
  // The item the menu came from, or the Apps icon when that item is gone (an app just hidden).
  if (restoreFocus) (opener?.isConnected ? opener : appsButton())?.focus();
  opener = undefined;
}
function toggleMore(event: MouseEvent) {
  const from = event.currentTarget as HTMLElement;
  if (menu.value?.kind === "more") closeMenu(true); else openMenu({ kind: "more" }, from, true);
}
function menuKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  // Esc, ← (back towards the rail) and Tab all leave the menu for the item it came from.
  if (event.key === "Escape" || event.key === "ArrowLeft" || event.key === "Tab") {
    event.preventDefault(); event.stopPropagation();
    closeMenu(true);
    return;
  }
  // ↑ and ↓ walk it (an app's menu does its own walking and never lets the key get here).
  const list = Array.from(flyout.value?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
  const next = rovingIndex(event.key, list.indexOf(document.activeElement as HTMLElement), list.length);
  if (next === undefined) return;
  event.preventDefault();
  list[next]?.focus();
}
function outside(event: PointerEvent) {
  if (!menu.value || !(event.target instanceof Node)) return;
  if (flyout.value?.contains(event.target) || opener?.contains(event.target)) return;
  closeMenu();
}
// An app that moved takes its menu along; one that is gone (hidden, deleted) closes it.
// After the rail is redrawn, so the tile is where it will stay (or really gone).
watch(tiles, list => {
  const current = menu.value;
  if (current?.kind !== "app") return;
  if (!list.some(app => appKey(app) === current.key)) { closeMenu(!!flyout.value?.contains(document.activeElement)); return; }
  opener = railItems().find(item => item.dataset.railApp === current.key) ?? opener;
  settle();
}, { flush: "post" });
/** Esc closes whatever is open, also when the keyboard is elsewhere (a menu opened with the right button). */
function escapeAnywhere(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || !menu.value) return;
  event.preventDefault();
  closeMenu(keyboardMenu);
}
function onAppsScroll() { hideTip(); if (menu.value?.kind === "app") settle(); }
onMounted(() => { document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escapeAnywhere); window.addEventListener("resize", closeAll); });
onBeforeUnmount(() => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escapeAnywhere); window.removeEventListener("resize", closeAll); });
function closeAll() { hideTip(); closeMenu(); }

// ---------------------------------------------------------------- what the items do

function go(target: RailTarget) { closeAll(); emit("go", target); }
function open(app: HubApp) { closeAll(); emit("openApp", app); }
function openShortcut(shortcut: Shortcut) { closeAll(); emit("openShortcut", shortcut); }
function newApp() { closeAll(); emit("newApp"); }
/** Onto the Mesa as a pane, the way a conversation is dragged from the list. */
function drag(event: DragEvent, app: HubApp) {
  closeAll();
  if (!event.dataTransfer) return;
  event.dataTransfer.setData("application/tendly-pane", JSON.stringify(appPane(app)));
  event.dataTransfer.effectAllowed = "copyMove";
}
function appMenu(event: MouseEvent, app: HubApp) { openMenu({ kind: "app", key: appKey(app) }, event.currentTarget as HTMLElement); }

const reporting = ref(false);
async function report(event: MouseEvent) {
  const from = event.currentTarget as HTMLElement;
  if (reporting.value) return;
  reporting.value = true; closeAll();
  try { emit("openOnMesa", await openReportApp(props.workspaces.filter(workspace => workspace.id !== inbox.conversationsWorkspaceId).map(workspace => workspace.id), t)); }
  catch (cause) { openMenu({ kind: "notice", text: errorMessage(cause) }, from, true); }
  finally { reporting.value = false; }
}
/** "Show the full sidebar here": once saved, this rail gives way to the sidebar. */
async function expand() {
  const from = opener;
  closeMenu(true);
  const problem = await setMesaSidebar("expanded");
  if (problem && from?.isConnected) openMenu({ kind: "notice", text: t('Could not save that choice: {reason}', { reason: problem }) }, from, true);
}
</script>

<template>
  <div class="hub-rail">
    <nav ref="root" class="rail-scroll" :aria-label="t('Main navigation')" @keydown="onKey" @focusin="onFocus" @focusout="hideTip" @mouseover="onHover" @mouseleave="hideTip">
     <div class="rail-bar" role="toolbar" aria-orientation="vertical" :aria-label="t('Pages and apps')">
      <div class="rail-group" role="group" :aria-label="t('Pages')">
        <button v-for="item in RAIL_NAV" :key="item.id" type="button" :class="['rail-item', { current: currentPage === item.id }]" :data-rail-id="`nav:${item.id}`" :data-tip="t(item.label)" :tabindex="tab(`nav:${item.id}`)" :aria-label="t(item.label)" :aria-current="currentPage === item.id ? 'page' : undefined" @click="go(item.id)"><Icon :name="item.icon" :size="19" /></button>
      </div>
      <span class="rail-divider" aria-hidden="true" />
      <button type="button" :class="['rail-item', { current: currentPage === 'apps' }]" data-rail-id="nav:apps" :data-tip="t('Apps')" :tabindex="tab('nav:apps')" :aria-label="t('Apps')" :aria-current="currentPage === 'apps' ? 'page' : undefined" @click="go('apps')"><Icon name="apps" :size="19" /></button>
      <div class="rail-apps" role="group" :aria-label="t('Your apps')" @scroll.passive="onAppsScroll">
        <button v-for="app in tiles" :key="appKey(app)" type="button" :class="['rail-item', 'rail-app', { current: currentApp === appKey(app), open: openSet.has(appKey(app)) }]" :data-rail-id="`app:${appKey(app)}`" :data-rail-app="appKey(app)" :data-tip="app.name" :tabindex="tab(`app:${appKey(app)}`)" :aria-label="app.name" :aria-current="currentApp === appKey(app) ? 'true' : undefined" aria-describedby="rail-app-hint" draggable="true" @dragstart="drag($event, app)" @click="open(app)" @contextmenu.prevent="appMenu($event, app)"><AppTile :name="app.name" :letter="app.letter" :color="app.color" :size="28" /><i v-if="openSet.has(appKey(app))" class="rail-open-dot" aria-hidden="true" /></button>
        <button v-for="item in shortcuts.list" :key="shortcutKey(item)" type="button" :class="['rail-item', 'rail-app', 'rail-link', { current: currentApp === shortcutKey(item), open: openSet.has(shortcutKey(item)) }]" :data-rail-id="`link:${shortcutKey(item)}`" :data-tip="item.name" :tabindex="tab(`link:${shortcutKey(item)}`)" :aria-label="t('{name} (shortcut)', { name: item.name })" :aria-current="currentApp === shortcutKey(item) ? 'true' : undefined" @click="openShortcut(item)"><AppTile :name="item.name" :letter="item.letter" :color="item.color" :size="28" /><i class="rail-link-mark" aria-hidden="true"><Icon name="arrow" :size="8" /></i><i v-if="openSet.has(shortcutKey(item))" class="rail-open-dot" aria-hidden="true" /></button>
        <button type="button" class="rail-item rail-new" data-rail-id="nav:new" :data-tip="t('New app')" :tabindex="tab('nav:new')" :aria-label="t('New app')" @click="newApp"><Icon name="plus" :size="17" /></button>
      </div>
      <div class="rail-group rail-foot" role="group" :aria-label="t('Notifications and settings')">
        <button type="button" :class="['rail-item', { current: currentPage === 'inbox' }]" data-rail-id="foot:inbox" :data-tip="bellLabel" :tabindex="tab('foot:inbox')" :aria-label="bellLabel" :aria-current="currentPage === 'inbox' ? 'page' : undefined" @click="go('inbox')"><Icon name="bell" :size="19" /><small v-if="badge" class="rail-badge" aria-hidden="true">{{ badge }}</small></button>
        <button type="button" class="rail-item" data-rail-id="foot:report" :data-tip="reporting ? t('Opening…') : t('Report a problem')" :tabindex="tab('foot:report')" :aria-label="t('Report a problem')" :aria-busy="reporting" :aria-disabled="reporting" @click="report"><Icon name="info" :size="19" /></button>
        <button type="button" :class="['rail-item', { selected: menu?.kind === 'more' }]" data-rail-id="foot:more" :data-tip="t('More')" :tabindex="tab('foot:more')" :aria-label="t('More')" aria-haspopup="menu" :aria-expanded="menu?.kind === 'more'" @click="toggleMore"><Icon name="more" :size="19" /></button>
        <button type="button" :class="['rail-item', { current: currentPage === 'settings' }]" data-rail-id="foot:settings" :data-tip="t('Settings')" :tabindex="tab('foot:settings')" :aria-label="t('Settings')" :aria-current="currentPage === 'settings' ? 'page' : undefined" @click="go('settings')"><Icon name="settings" :size="19" /></button>
      </div>
     </div>
      <span id="rail-app-hint" class="sr-only">{{ t('Press the right arrow for options. Drag onto the Mesa to open it beside what is there.') }}</span>
    </nav>
    <button v-if="panel" type="button" :class="['rail-panel-toggle', { folded: !panelOpen }]" :aria-expanded="panelOpen" :aria-label="t(panelOpen ? 'Hide the workspaces and conversations panel' : 'Show the workspaces and conversations panel')" :title="t(panelOpen ? 'Hide the workspaces and conversations panel' : 'Show the workspaces and conversations panel')" @click="emit('togglePanel')"><Icon name="chevron" :size="12" /></button>
    <Teleport to="body">
      <div v-if="tip && !menu" class="rail-tip" aria-hidden="true" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }">{{ tip.text }}</div>
      <div v-if="menu" ref="flyout" class="rail-flyout" :style="{ left: `${place.left}px`, top: `${place.top}px` }" @keydown="menuKey">
        <template v-if="menu.kind === 'app'">
          <template v-if="menuApp"><strong class="rail-flyout-title">{{ menuApp.name }}</strong><AppOrderMenu :key="appKey(menuApp)" :app="menuApp" :autofocus="keyboardMenu" @close="closeMenu(keyboardMenu)" /></template>
        </template>
        <div v-else-if="menu.kind === 'more'" class="rail-menu" role="menu" :aria-label="t('More')">
          <button v-for="item in RAIL_MORE" :key="item.id" type="button" role="menuitem" @click="go(item.id)"><Icon :name="item.icon" :size="14" /><span>{{ t(item.label) }}</span></button>
          <hr />
          <button type="button" role="menuitem" :title="t('Shows the full sidebar on the Mesa too. Change it back in Settings → Addresses and time zone, or at the foot of the sidebar.')" @click="expand"><Icon name="panelLeft" :size="14" /><span>{{ t('Show the full sidebar here') }}</span></button>
        </div>
        <div v-else class="rail-notice" role="alert"><p>{{ menu.text }}</p><button type="button" class="small-button" @click="closeMenu(true)">{{ t('Close') }}</button></div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* The column itself: a grid item of the shell (styles.css gives it 56px). It
   sits above its neighbours so the panel handle can straddle the panel's edge. */
.hub-rail { position: relative; z-index: 6; display: flex; min-width: 0; min-height: 0; border-right: 1px solid var(--glass-edge); background: var(--glass-side); }
.rail-scroll { display: flex; flex: 1; min-width: 0; min-height: 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.rail-bar { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 1; min-width: 0; padding: 10px 0 8px; }
.rail-scroll::-webkit-scrollbar, .rail-apps::-webkit-scrollbar { display: none; }
.rail-group { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: none; }
.rail-foot { padding-top: 6px; border-top: 1px solid var(--fill-hover); }
.rail-divider { flex: none; width: 24px; height: 1px; margin: 6px 0; background: var(--line); }
/* Many apps scroll here, on their own, between the navigation and the foot.
   In a short window they keep room for two tiles and the whole rail scrolls. */
.rail-apps { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 1 0 84px; width: 100%; min-height: 0; padding: 2px 0; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; }
.rail-item { position: relative; display: grid; place-items: center; flex: none; width: 40px; height: 40px; padding: 0; border: 0; border-radius: var(--radius-md); background: none; color: var(--muted); cursor: pointer; transition: background var(--duration-fast), color var(--duration-fast); }
.rail-item:hover, .rail-item.selected { background: var(--fill); color: var(--ink); }
.rail-item.current { background: var(--selected); color: var(--accent); }
.rail-item[aria-disabled="true"] { opacity: .6; cursor: progress; }
/* The rail clips what spills past its edge: the focus ring is drawn inside the item. */
.rail-item:focus-visible, .rail-panel-toggle:focus-visible { outline-offset: -2px; }
.rail-app { cursor: grab; }
.rail-app.current { background: var(--elevated); box-shadow: 0 0 0 1px var(--line-strong), var(--shadow-sm); }
.rail-app.current::before { content: ""; position: absolute; left: -7px; top: 10px; bottom: 10px; width: 3px; border-radius: var(--radius-full); background: var(--accent); }
.rail-open-dot { position: absolute; right: 3px; bottom: 3px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg-accent); }
.rail-link { cursor: pointer; }
.rail-link-mark { position: absolute; right: 2px; top: 2px; display: grid; place-items: center; width: 12px; height: 12px; border-radius: 50%; background: var(--elevated); color: var(--muted); box-shadow: 0 0 0 1px var(--line); }
.rail-new { width: 32px; height: 32px; margin-top: 2px; border: 1px dashed var(--line-input); color: var(--muted); }
.rail-new:hover { border-style: solid; }
.rail-badge { position: absolute; top: 2px; right: 0; min-width: 16px; height: 16px; padding: 0 4px; border-radius: var(--radius-full); background: var(--accent); color: var(--on-accent); font-size: var(--text-xs); font-weight: 600; line-height: 16px; text-align: center; }
.rail-panel-toggle { position: absolute; top: 50%; left: calc(100% + var(--rail-left, 0px) - 11px); display: grid; place-items: center; width: 22px; height: 22px; padding: 0; border: 1px solid var(--line); border-radius: var(--radius-full); background: var(--elevated); color: var(--muted); box-shadow: var(--shadow-sm); cursor: pointer; transform: translateY(-50%); }
.rail-panel-toggle:hover { color: var(--ink); border-color: var(--line-strong); }
.rail-panel-toggle > svg { transform: rotate(180deg); }
.rail-panel-toggle.folded > svg { transform: none; }
.rail-tip { position: fixed; z-index: 91; max-width: 240px; padding: 4px 8px; border-radius: var(--radius-sm); background: var(--ink); color: var(--bg); font-size: var(--text-xs); font-weight: 500; line-height: 1.4; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; transform: translateY(-50%); box-shadow: var(--shadow-md); }
.rail-flyout { position: fixed; z-index: 90; width: 220px; max-width: calc(100vw - 80px); padding: 5px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); box-shadow: var(--shadow-lg); }
.rail-flyout-title { display: block; padding: 4px 8px 6px; font-size: var(--text-xs); font-weight: 600; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-menu { display: grid; gap: 1px; }
.rail-menu > button { display: flex; align-items: center; gap: var(--space-2); width: 100%; min-height: 30px; padding: 5px 8px; border: 0; border-radius: var(--radius-xs); background: none; color: var(--ink-soft); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer; }
.rail-menu > button > svg { flex: none; color: var(--muted); }
.rail-menu > button:hover { background: var(--fill); color: var(--ink); }
.rail-menu > button:focus-visible { outline-offset: -2px; }
.rail-menu > hr { width: 100%; margin: 4px 0; border: 0; border-top: 1px solid var(--border); }
.rail-notice { display: grid; gap: var(--space-2); justify-items: start; padding: 6px 8px; }
.rail-notice > p { margin: 0; font-size: var(--text-sm); line-height: 1.45; color: var(--danger-ink); overflow-wrap: anywhere; }
@media (pointer: coarse) {
  .rail-item, .rail-new { width: 44px; height: 44px; }
  .rail-menu > button { min-height: 44px; }
  /* The handle stays small to look at; its target reaches 44px around it. */
  .rail-panel-toggle::after { content: ""; position: absolute; inset: -11px; }
}
@media (prefers-reduced-motion: reduce) { .rail-item { transition: none; } }
</style>
