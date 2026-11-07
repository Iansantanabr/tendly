<script setup lang="ts">
/**
 * A shortcut in a pane of the Mesa: a slim bar with its tile, name and
 * address, and the site in a frame below. The site keeps its own origin and
 * cookies (it is not sandboxed into an opaque origin like an app: that would
 * break most sites); it cannot reach Tendly's page, which is another origin.
 */
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import AppTile from "./AppTile.vue";
import { findShortcut, shortcutHost } from "./shortcuts";

const props = defineProps<{ id: string; fallback: { name?: string; letter?: string; color?: string; url?: string } }>();
const emit = defineEmits<{ remove: [] }>();
const { t } = useI18n();

const shortcut = computed(() => findShortcut(props.id));
const name = computed(() => shortcut.value?.name ?? props.fallback.name ?? "");
const url = computed(() => shortcut.value?.url ?? props.fallback.url ?? "");
const reloads = ref(0), loading = ref(true);
function reload() { loading.value = true; reloads.value++; }
function openTab() { if (url.value) window.open(url.value, "_blank", "noopener,noreferrer"); }
</script>

<template>
  <section class="shortcut-view" :aria-label="name">
    <header class="shortcut-view-bar">
      <div class="shortcut-view-id">
        <AppTile :name="name" :letter="shortcut?.letter ?? fallback.letter" :color="shortcut?.color ?? fallback.color" :size="20" />
        <strong class="shortcut-view-name">{{ name }}</strong>
        <a class="shortcut-view-url" :href="url" target="_blank" rel="noopener noreferrer" :title="url">{{ shortcutHost(url) }}</a>
      </div>
      <div class="shortcut-view-actions">
        <button type="button" class="icon-button" :aria-label="t('Reload')" :title="t('Reload')" :disabled="!url" @click="reload"><Icon name="refresh" :size="14" /></button>
        <button type="button" class="icon-button" :aria-label="t('Open in new tab')" :title="t('Open in new tab')" :disabled="!url" @click="openTab"><Icon name="arrow" :size="14" /></button>
      </div>
    </header>
    <div class="shortcut-view-body">
      <iframe v-if="url" :key="`${url}#${reloads}`" class="shortcut-view-frame" :src="url" :title="name" referrerpolicy="strict-origin-when-cross-origin" allow="clipboard-write; fullscreen" @load="loading = false" />
      <div v-if="url && loading" class="shortcut-view-loading" role="status">{{ t('Loading…') }}</div>
      <div v-if="!url" class="pane-empty">
        <Icon name="apps" :size="28" />
        <h3>{{ t('This shortcut is not here anymore') }}</h3>
        <button type="button" class="secondary-button" @click="emit('remove')">{{ t('Remove tab') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.shortcut-view { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; height: 100%; }
.shortcut-view-bar { display: flex; align-items: center; gap: 4px 8px; flex: none; min-height: 34px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--border); background: var(--sunken); min-width: 0; }
.shortcut-view-id { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.shortcut-view-name { color: var(--ink); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shortcut-view-url { color: var(--muted); font-size: var(--text-xs); text-decoration: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.shortcut-view-url:hover { color: var(--ink); text-decoration: underline; }
.shortcut-view-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.shortcut-view-body { position: relative; flex: 1; min-height: 0; display: flex; background: var(--surface); }
.shortcut-view-frame { flex: 1; width: 100%; height: 100%; border: 0; background: var(--surface); }
.shortcut-view-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: var(--text-sm); background: var(--surface); pointer-events: none; }
@media (pointer: coarse) { .shortcut-view-bar .icon-button { width: 44px; height: 44px; } }
</style>
