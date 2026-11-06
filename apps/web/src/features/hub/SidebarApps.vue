<script setup lang="ts">
/**
 * Apps in the expanded sidebar: "Apps ›" (the catalog) with "+" (create), a
 * list of up to eight apps in the person's order, and "See all".
 */
import { computed, onMounted, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { appPane } from "../pane-context";
import AppTile from "./AppTile.vue";
import AppOrderMenu from "./AppOrderMenu.vue";
import { apps, refreshApps, type HubApp } from "./apps";
import { appKey, arrangedApps, hiddenAppList } from "./app-order";
import { loadHubSettings } from "./settings";

/** How many apps the sidebar lists before "See all". */
const LIMIT = 8;
const emit = defineEmits<{ /** The Apps page. */ catalog: []; openApp: [app: HubApp] }>();
const { t } = useI18n();

const shown = computed(() => arrangedApps.value.slice(0, LIMIT));
const total = computed(() => arrangedApps.value.length + hiddenAppList.value.length);
const menuKey = ref<string>();
const openers = new Map<string, HTMLElement>();
function recordOpener(key: string, element: unknown) { if (element instanceof HTMLElement) openers.set(key, element); else openers.delete(key); }
const section = ref<HTMLElement>(), title = ref<HTMLElement>();
// An app that left the list (hidden just now) takes its menu with it; the keyboard goes to "Apps".
watch(shown, list => {
  if (!menuKey.value || list.some(app => appKey(app) === menuKey.value)) return;
  const inside = !!section.value?.contains(document.activeElement);
  menuKey.value = undefined;
  if (inside) title.value?.focus();
});
onMounted(() => { if (!apps.loaded) void refreshApps(); void loadHubSettings(); });

function create() { apps.wantCreate = true; emit("catalog"); }
function toggleMenu(key: string) { menuKey.value = menuKey.value === key ? undefined : key; }
function closeMenu(key: string) { if (menuKey.value !== key) return; menuKey.value = undefined; openers.get(key)?.focus(); }
function escape(event: KeyboardEvent, key: string) {
  if (event.key !== "Escape" || menuKey.value !== key) return;
  event.preventDefault(); event.stopPropagation();
  closeMenu(key);
}
/** Onto the Mesa as a pane, the way a conversation is dragged from the list. */
function drag(event: DragEvent, app: HubApp) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData("application/tendly-pane", JSON.stringify(appPane(app)));
  event.dataTransfer.effectAllowed = "copyMove";
}
</script>

<template>
  <section ref="section" class="side-apps" :aria-label="t('Apps')">
    <header class="side-apps-head">
      <button ref="title" type="button" class="side-apps-title" :title="t('See all apps')" @click="emit('catalog')"><span>{{ t('Apps') }}</span><Icon name="chevron" :size="11" /></button>
      <button type="button" class="icon-button side-apps-new" :aria-label="t('New app')" :title="t('New app')" @click="create"><Icon name="plus" :size="15" /></button>
    </header>
    <ul v-if="shown.length" class="side-apps-list">
      <li v-for="app in shown" :key="appKey(app)" :class="{ 'menu-open': menuKey === appKey(app) }" @keydown="escape($event, appKey(app))">
        <div class="side-app-row">
          <button type="button" class="side-app" draggable="true" :title="app.description ? `${app.name}\n${app.description}` : app.name" @dragstart="drag($event, app)" @click="emit('openApp', app)"><AppTile :name="app.name" :letter="app.letter" :color="app.color" :size="20" /><span>{{ app.name }}</span></button>
          <button :ref="element => recordOpener(appKey(app), element)" type="button" class="icon-button side-app-more" :aria-label="t('Options for {app}', { app: app.name })" :title="t('Options for {app}', { app: app.name })" :aria-expanded="menuKey === appKey(app)" @click="toggleMenu(appKey(app))"><Icon name="more" :size="14" /></button>
        </div>
        <AppOrderMenu v-if="menuKey === appKey(app)" class="side-app-menu" :app="app" autofocus @close="closeMenu(appKey(app))" />
      </li>
    </ul>
    <button v-if="total" type="button" class="side-apps-all" @click="emit('catalog')">{{ total > shown.length ? t('See all ({count})', { count: total }) : t('See all') }}</button>
  </section>
</template>

<style scoped>
.side-apps { flex-shrink: 0; min-width: 0; padding: 6px 0 8px; border-bottom: 1px solid var(--fill-hover); }
.side-apps-head { display: flex; align-items: center; gap: 4px; min-height: 28px; padding: 0 2px 0 10px; }
.side-apps-title { display: inline-flex; align-items: center; gap: 4px; min-width: 0; margin-right: auto; padding: 4px 6px 4px 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--muted); font: inherit; font-size: var(--text-xs); font-weight: 600; letter-spacing: .4px; cursor: pointer; }
.side-apps-title:hover { color: var(--ink); }
.side-apps-title > svg { flex: none; }
.side-apps-new { width: 24px; height: 24px; }
.side-apps-list { list-style: none; margin: 0; padding: 0; }
.side-app-row { display: flex; align-items: center; gap: 2px; min-width: 0; border-radius: var(--radius-sm); }
.side-app-row:hover, .menu-open > .side-app-row { background: var(--fill); }
.side-app { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; min-height: 30px; padding: 4px 6px 4px 8px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--ink); font: inherit; font-size: var(--text-md); text-align: left; cursor: pointer; }
.side-app > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-app-more { width: 24px; height: 24px; margin-right: 2px; opacity: 0; }
.side-app-row:hover > .side-app-more, .side-app-more:focus-visible, .side-app-more[aria-expanded="true"], .side-apps-list:focus-within .side-app-more { opacity: 1; }
.side-app-menu { margin: 2px 4px 6px 8px; padding: 4px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); box-shadow: var(--shadow-md); }
.side-apps-all { display: block; margin: 2px 0 0; padding: 5px 10px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--muted); font: inherit; font-size: var(--text-xs); text-align: left; cursor: pointer; }
.side-apps-all:hover { color: var(--ink); text-decoration: underline; }
/* No hover on a touch screen: the "…" is always there, and every row is a full target. */
@media (pointer: coarse), (hover: none) { .side-app-more { opacity: 1; } }
@media (pointer: coarse) { .side-app { min-height: 44px; } .side-app-more, .side-apps-new { width: 44px; height: 44px; } .side-apps-title, .side-apps-all { min-height: 44px; } }
</style>
