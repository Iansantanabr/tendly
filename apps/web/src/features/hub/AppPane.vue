<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { PaneNode, Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { routedUrl } from "../api";
import { paneString } from "../pane-context";
import { useI18n } from "../../i18n";
import AppTile from "./AppTile.vue";
import { apps, findApp, refreshApps } from "./apps";

/**
 * A custom app on the Mesa: a thin bar with what it is and a few actions, and
 * the app itself in a frame below. The tab keeps the name and tile it was
 * opened with; the bar follows the app's current app.json.
 */
const props = defineProps<{ pane: PaneNode; workspace: Workspace }>();
const emit = defineEmits<{ chat: []; remove: [] }>();
const { t } = useI18n();

const slug = computed(() => paneString(props.pane, "slug"));
const app = computed(() => findApp(props.workspace.id, slug.value));
const name = computed(() => app.value?.name ?? paneString(props.pane, "name") ?? props.pane.title ?? slug.value ?? "");
const letter = computed(() => app.value?.letter ?? paneString(props.pane, "letter"));
const color = computed(() => app.value?.color ?? paneString(props.pane, "color"));
const codePath = computed(() => app.value?.code_path ?? (slug.value ? `apps/${slug.value}/` : ""));
const src = computed(() => app.value ? routedUrl(app.value.url) : undefined);
const brokenReason = computed(() => apps.errors.find(error => error.workspace_id === props.workspace.id && error.slug === slug.value)?.message);
/** Gone once the list has been read without it; an unreadable list is not "gone". */
const missing = computed(() => apps.loaded && !apps.loading && !apps.error && !app.value);

const reloads = ref(0), framing = ref(true);
watch(src, () => { framing.value = true; });
function reload() { framing.value = true; reloads.value++; void refreshApps(); }
function openTab() { if (src.value) window.open(src.value, "_blank", "noopener"); }
onMounted(() => { void refreshApps(); });
</script>

<template>
  <section class="app-pane" :aria-label="name">
    <header class="app-pane-bar">
      <AppTile :name="name" :letter="letter" :color="color" :size="20" />
      <strong class="app-pane-name" :title="app?.description || name">{{ name }}</strong>
      <code class="app-pane-path" :title="`${workspace.name} · ${codePath}`">{{ codePath }}</code>
      <span class="flex-spacer" />
      <button type="button" class="small-button app-pane-chat" :title="t('Talk to an agent about this app')" @click="emit('chat')"><Icon name="chat" :size="13" /><span>{{ t('Chat') }}</span></button>
      <button type="button" class="icon-button" :aria-label="t('Reload')" :title="t('Reload')" :disabled="!src" @click="reload"><Icon name="refresh" :size="14" /></button>
      <button type="button" class="icon-button" :aria-label="t('Open in new tab')" :title="t('Open in new tab')" :disabled="!src" @click="openTab"><Icon name="arrow" :size="14" /></button>
    </header>
    <div class="app-pane-body">
      <iframe v-if="src" :key="`${src}#${reloads}`" class="app-pane-frame" :src="src" :title="name" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups" @load="framing = false" />
      <div v-if="src && framing" class="app-pane-loading" role="status">{{ t('Loading…') }}</div>
      <div v-else-if="!src && missing" class="pane-empty">
        <Icon name="apps" :size="28" />
        <h3>{{ t('This app is not here anymore') }}</h3>
        <p>{{ brokenReason ? t('Tendly could not read {path}: {reason}', { path: codePath, reason: brokenReason }) : t('No app was found in {path} of {workspace}.', { path: codePath, workspace: workspace.name }) }}</p>
        <div class="app-pane-actions"><button type="button" class="secondary-button" @click="emit('remove')">{{ t('Remove tab') }}</button><button type="button" class="small-button" @click="reload">{{ t('Try again') }}</button></div>
      </div>
      <div v-else-if="!src && apps.error" class="pane-empty">
        <Icon name="info" :size="26" />
        <h3>{{ t('Could not load the apps') }}</h3>
        <p>{{ apps.error }}</p>
        <button type="button" class="small-button" @click="reload">{{ t('Try again') }}</button>
      </div>
      <div v-else-if="!src" class="app-pane-loading" role="status">{{ t('Loading…') }}</div>
    </div>
  </section>
</template>

<style scoped>
.app-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; height: 100%; }
.app-pane-bar { display: flex; align-items: center; gap: 8px; flex: none; min-height: 34px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--border); background: var(--sunken); min-width: 0; }
.app-pane-name { color: var(--ink); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.app-pane-path { color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.flex-spacer { flex: 1; }
.app-pane-chat { display: inline-flex; align-items: center; gap: 5px; }
.app-pane-body { position: relative; flex: 1; min-height: 0; display: flex; background: var(--surface); }
.app-pane-frame { flex: 1; width: 100%; height: 100%; border: 0; background: var(--surface); }
.app-pane-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: var(--text-sm); background: var(--surface); pointer-events: none; }
.app-pane-actions { display: flex; gap: 8px; align-items: center; }
@container dock-pane (max-width: 420px) { .app-pane-path { display: none; } }
@media (max-width: 480px) { .app-pane-path { display: none; } .app-pane-chat > span { display: none; } }
</style>
