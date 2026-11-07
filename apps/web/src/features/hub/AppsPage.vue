<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { EndpointProfile, Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import { inbox, loadConversationsWorkspace } from "./inbox";
import AppTile from "./AppTile.vue";
import AppOrderMenu from "./AppOrderMenu.vue";
import CreateAppPanel from "./CreateAppPanel.vue";
import ShortcutForm from "./ShortcutForm.vue";
import { appPagePath, apps, refreshApps, type HubApp, type HubAppError } from "./apps";
import { appKey, appOrder, arrangedApps, hiddenAppList, isHiddenApp, isPinnedApp } from "./app-order";
import { updatedAgo } from "./builder";
import { loadHubSettings } from "./settings";
import { refreshShortcuts, removeShortcut, shortcutHost, shortcuts, type Shortcut } from "./shortcuts";

/**
 * Apps: small tools an agent builds in a project's `apps/` folder, opened on
 * the Mesa, and shortcuts to sites. "Create with the agent" makes an app from
 * a template and opens it beside a conversation; nothing is sent from here.
 */
const props = defineProps<{ workspaces: Workspace[]; profiles: EndpointProfile[]; selectedWorkspaceId?: string }>();
const emit = defineEmits<{
  back: [];
  /** In full screen. */
  openApp: [app: HubApp];
  openOnMesa: [app: HubApp];
  /** A new app from a template: on the Mesa, with this text in a composer beside it. */
  created: [app: HubApp, prompt: string];
  /** "Ask for a fix" on an app that reported errors: the errors go to a composer beside the app. */
  fixApp: [app: HubApp];
  /** "Ask for a fix" on an app Tendly cannot read: a conversation in that project, with the reason in its composer. */
  fixBroken: [problem: HubAppError];
  openShortcut: [shortcut: Shortcut];
}>();
const { t } = useI18n();

/** Projects only: an app lives in a project's folder, not among the loose conversations. */
const projects = computed(() => props.workspaces.filter(w => w.id !== inbox.conversationsWorkspaceId));
/** The person's order (as in the rail and the sidebar), then the apps they hid. */
const sorted = computed(() => [...arrangedApps.value, ...hiddenAppList.value]);
const menuKey = ref<string>();
const menuOpeners = new Map<string, HTMLElement>();
function recordOpener(key: string, element: unknown) { if (element instanceof HTMLElement) menuOpeners.set(key, element); else menuOpeners.delete(key); }
function closeMenu(key: string) { if (menuKey.value !== key) return; menuKey.value = undefined; menuOpeners.get(key)?.focus(); }
function menuEscape(event: KeyboardEvent, key: string) {
  if (event.key !== "Escape" || menuKey.value !== key) return;
  event.preventDefault(); event.stopPropagation();
  closeMenu(key);
}
/** "+" beside Apps, anywhere: the panel takes the cursor. */
const focusKey = ref(0);
watch(() => apps.wantCreate, wanted => { if (!wanted) return; apps.wantCreate = false; focusKey.value++; }, { immediate: true });
const workspaceName = (id: string) => props.workspaces.find(w => w.id === id)?.name ?? "";
const showWorkspace = computed(() => new Set(apps.list.map(app => app.workspace_id)).size > 1);
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
onMounted(() => { void loadConversationsWorkspace(); void refreshApps(); void refreshShortcuts(); void loadHubSettings(); clock = setInterval(() => { now.value = Date.now(); }, 30000); });
watch(() => props.workspaces.length, () => clearInterval(clock), { flush: "post" });

/** In a browser tab of its own: Tendly's page around the app, so it keeps its data and its bridge. */
function openTab(app: HubApp) { window.open(new URL(appPagePath(app), window.location.origin).href, "_blank", "noopener"); }
const route = (app: HubApp) => appPagePath(app);

// ---------------------------------------------------------------- shortcuts

const shortcutForm = ref<"new" | string>();
const removing = ref<string>(), removeBusy = ref(false), shortcutProblem = ref("");
function saved() { shortcutForm.value = undefined; }
async function remove(shortcut: Shortcut) {
  if (removeBusy.value) return;
  removeBusy.value = true; shortcutProblem.value = "";
  try { await removeShortcut(shortcut.id); removing.value = undefined; }
  catch (cause) { shortcutProblem.value = errorMessage(cause); }
  finally { removeBusy.value = false; }
}
function embedNote(shortcut: Shortcut): string {
  const { allowed } = shortcut.embed;
  return allowed === true ? t("Opens in a pane of the Mesa") : allowed === false ? t("Opens in a new tab: the site does not allow framing") : t("Opens in a new tab until the site answers");
}
</script>

<template>
  <PageShell :title="t('Apps')" :subtitle="t('Small tools an agent builds for you inside a project, and shortcuts to sites. Open one in full screen, or as a tab on the Mesa.')" @back="emit('back')">
    <template #actions>
      <button type="button" class="secondary-button" :disabled="apps.loading" @click="refreshApps(); refreshShortcuts()"><Icon name="refresh" :size="14" />{{ t('Refresh') }}</button>
    </template>
    <div class="apps-page">
      <p v-if="apps.error" class="inline-error" role="alert">{{ apps.error }}</p>

      <div class="apps-grid">
        <section class="apps-card apps-create"><CreateAppPanel :projects="projects" :selected-workspace-id="selectedWorkspaceId" :focus-key="focusKey" @created="(app, prompt) => emit('created', app, prompt)" /></section>

        <article v-for="problem in apps.errors" :key="'broken' + problem.workspace_id + problem.slug" class="apps-card apps-app is-broken" role="group" :aria-label="t('Broken app {slug}', { slug: problem.slug })">
          <div class="apps-app-main static">
            <span class="apps-broken-tile" aria-hidden="true"><Icon name="info" :size="18" /></span>
            <span class="apps-app-text"><strong>apps/{{ problem.slug }}/</strong><small>{{ t('Could not be read: {reason}', { reason: problem.message }) }}</small></span>
          </div>
          <footer>
            <small class="apps-app-meta">{{ workspaceName(problem.workspace_id) }}</small>
            <span class="flex-spacer" />
            <button type="button" class="small-button primary" :title="t('Opens a conversation in this project with the problem written for the agent. Nothing is sent until you press send.')" @click="emit('fixBroken', problem)">{{ t('Ask for a fix') }}</button>
          </footer>
        </article>

        <article v-for="app in sorted" :key="app.workspace_id + app.slug" :class="['apps-card', 'apps-app', { 'is-hidden': isHiddenApp(appOrder, appKey(app)) }]" @keydown="menuEscape($event, appKey(app))">
          <button type="button" class="apps-app-main" :title="t('Open {app}', { app: app.name })" @click="emit('openApp', app)">
            <AppTile :name="app.name" :letter="app.letter" :color="app.color" :size="40" />
            <span class="apps-app-text"><strong>{{ app.name }}</strong><small v-if="app.description">{{ app.description }}</small></span>
          </button>
          <div class="apps-app-facts">
            <code class="apps-app-route" :title="t('Its address in Tendly')">{{ route(app) }}</code>
            <small class="apps-app-updated" :title="app.updated_at">{{ updatedAgo(app.updated_at, t, now) }}</small>
            <button v-if="app.errors" type="button" class="apps-app-errors" :title="t('Errors the last window showing this app reported. Opens the app with the errors written for the agent; nothing is sent until you press send.')" @click="emit('fixApp', app)"><Icon name="info" :size="12" /><span>{{ t(app.errors === 1 ? '{count} error' : '{count} errors', { count: app.errors }) }}</span> · {{ t('Ask for a fix') }}</button>
          </div>
          <footer>
            <small class="apps-app-meta" :title="app.code_path">{{ showWorkspace || projects.length > 1 ? app.workspace_name : app.code_path }}</small>
            <span v-if="isHiddenApp(appOrder, appKey(app))" class="apps-app-flag" :title="t('Hidden: it is only on the Apps page.')">{{ t('Hidden') }}</span>
            <span v-else-if="isPinnedApp(appOrder, appKey(app))" class="apps-app-flag pinned">{{ t('Pinned') }}</span>
            <span class="flex-spacer" />
            <button :ref="element => recordOpener(appKey(app), element)" type="button" class="icon-button" :aria-label="t('Options for {app}', { app: app.name })" :title="t('Options for {app}', { app: app.name })" :aria-expanded="menuKey === appKey(app)" @click="menuKey = menuKey === appKey(app) ? undefined : appKey(app)"><Icon name="more" :size="14" /></button>
            <button type="button" class="icon-button" :aria-label="t('Open in new tab')" :title="t('Open in new tab')" @click="openTab(app)"><Icon name="arrow" :size="14" /></button>
            <button type="button" class="small-button" :title="t('Open this app in a tab on the Mesa')" @click="emit('openOnMesa', app)">{{ t('Open on the Mesa') }}</button>
          </footer>
          <AppOrderMenu v-if="menuKey === appKey(app)" class="apps-app-menu" :app="app" autofocus @close="closeMenu(appKey(app))" />
        </article>
      </div>
      <p v-if="apps.loaded && !apps.list.length && !apps.errors.length && !apps.error" class="apps-empty">{{ t('No apps yet. Describe one above: it is made from a template and an agent shapes it with you.') }}</p>

      <section class="apps-shortcuts" :aria-label="t('Shortcuts')">
        <header class="apps-shortcuts-head">
          <h2>{{ t('Shortcuts') }}</h2>
          <small>{{ t('Sites with a tile beside your apps.') }}</small>
          <span class="flex-spacer" />
          <button v-if="shortcutForm !== 'new'" type="button" class="small-button" @click="shortcutForm = 'new'"><Icon name="plus" :size="13" />{{ t('Add shortcut') }}</button>
        </header>
        <p v-if="shortcuts.error" class="inline-error" role="alert">{{ shortcuts.error }}</p>
        <p v-if="shortcutProblem" class="inline-error" role="alert">{{ shortcutProblem }}</p>
        <div class="apps-grid">
          <section v-if="shortcutForm === 'new'" class="apps-card apps-create"><ShortcutForm @saved="saved" @cancel="shortcutForm = undefined" /></section>
          <article v-for="shortcut in shortcuts.list" :key="shortcut.id" class="apps-card apps-app apps-shortcut">
            <template v-if="shortcutForm === shortcut.id"><ShortcutForm :shortcut="shortcut" @saved="saved" @cancel="shortcutForm = undefined" /></template>
            <template v-else>
              <button type="button" class="apps-app-main" :title="t('Open {app}', { app: shortcut.name })" @click="emit('openShortcut', shortcut)">
                <AppTile :name="shortcut.name" :letter="shortcut.letter" :color="shortcut.color" :size="40" />
                <span class="apps-app-text"><strong>{{ shortcut.name }}</strong><small>{{ shortcutHost(shortcut.url) }}</small></span>
              </button>
              <div class="apps-app-facts"><small class="apps-app-updated">{{ embedNote(shortcut) }}</small></div>
              <footer v-if="removing !== shortcut.id">
                <a class="apps-app-meta" :href="shortcut.url" target="_blank" rel="noopener noreferrer" :title="shortcut.url">{{ t('Open in new tab') }}</a>
                <span class="flex-spacer" />
                <button type="button" class="small-button" @click="shortcutForm = shortcut.id">{{ t('Edit') }}</button>
                <button type="button" class="small-button" @click="removing = shortcut.id">{{ t('Remove') }}</button>
              </footer>
              <footer v-else class="apps-shortcut-confirm" role="group" :aria-label="t('Remove {name}?', { name: shortcut.name })">
                <small>{{ t('Remove {name}?', { name: shortcut.name }) }}</small>
                <span class="flex-spacer" />
                <button type="button" class="small-button" :disabled="removeBusy" @click="removing = undefined">{{ t('Cancel') }}</button>
                <button type="button" class="small-button danger" :disabled="removeBusy" @click="remove(shortcut)">{{ t('Remove') }}</button>
              </footer>
            </template>
          </article>
        </div>
        <p v-if="shortcuts.loaded && !shortcuts.list.length && shortcutForm !== 'new'" class="apps-empty">{{ t('No shortcuts yet.') }}</p>
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.apps-page { max-width: 1080px; display: grid; gap: var(--space-4); }
.apps-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); align-items: start; }
.apps-card { background: var(--elevated); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); min-width: 0; }
.apps-create { grid-column: 1 / -1; max-width: 760px; }
.flex-spacer { flex: 1; }
.apps-app { display: grid; }
.apps-app-main { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 0; background: none; text-align: left; font: inherit; color: var(--ink); cursor: pointer; border-radius: var(--radius-lg) var(--radius-lg) 0 0; min-width: 0; }
.apps-app-main:hover { background: var(--fill-hover); }
.apps-app-main.static { cursor: default; }
.apps-app-main.static:hover { background: none; }
.apps-app-text { display: grid; gap: 2px; min-width: 0; }
.apps-app-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apps-app-text small { color: var(--muted); font-size: var(--text-sm); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.apps-app-facts { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 0 var(--space-4) var(--space-2); min-width: 0; }
.apps-app-route { color: var(--faint); font-family: var(--mono); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; max-width: 100%; }
.apps-app-updated { color: var(--muted); font-size: var(--text-xs); white-space: nowrap; }
.apps-app-errors { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 1px solid var(--danger-line); border-radius: var(--radius-full); background: var(--danger-soft); color: var(--danger-ink); font: inherit; font-size: var(--text-xs); font-weight: 600; cursor: pointer; }
.apps-app-errors:hover { filter: brightness(.97); }
.apps-app footer { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4); border-top: 1px solid var(--border); min-width: 0; }
.apps-app-meta { color: var(--faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
a.apps-app-meta { color: var(--muted); text-decoration: none; }
a.apps-app-meta:hover { color: var(--ink); text-decoration: underline; }
.apps-app-flag { flex: none; padding: 1px 7px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); }
.apps-app-flag.pinned { background: var(--accent-soft); color: var(--accent-ink); }
.apps-app.is-hidden .apps-app-main { opacity: .7; }
.apps-app.is-broken { border-color: var(--warn-line); }
.apps-broken-tile { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: var(--radius-sm); background: var(--warn-soft); color: var(--warn-ink); }
.apps-app-menu { padding: 4px; border-top: 1px solid var(--border); }
.apps-shortcuts { display: grid; gap: var(--space-3); }
.apps-shortcuts-head { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); }
.apps-shortcuts-head h2 { margin: 0; font-size: var(--text-lg); color: var(--ink); }
.apps-shortcuts-head small { color: var(--muted); font-size: var(--text-sm); }
.apps-shortcuts-head .small-button { display: inline-flex; align-items: center; gap: 4px; }
.apps-shortcut-confirm { background: var(--danger-soft); }
.apps-shortcut-confirm > small { color: var(--danger-ink); font-size: var(--text-sm); }
@media (pointer: coarse) { .apps-app footer .icon-button { width: 44px; height: 44px; } .apps-app footer .small-button, .apps-app-errors, .apps-shortcuts-head .small-button { min-height: 44px; } }
.apps-empty { margin: 0; color: var(--muted); }
@media (max-width: 640px) { .apps-grid { grid-template-columns: 1fr; } }
</style>
