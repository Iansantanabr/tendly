<script setup lang="ts">
/**
 * "Versions", above the app: each burst of changes to its folder as one
 * entry (what the agent said, when, which files), and "Restore the app to
 * this version" with the confirmation in place. Restoring writes new file
 * versions; the open app reloads by itself.
 */
import { onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { errorMessage } from "../api";
import { showToast } from "../toasts";
import { useI18n } from "../../i18n";
import type { HubApp } from "./apps";
import { authorLabel, filesTitle, listVersions, restoreSummary, restoreVersion, versionTitle, type AppVersion } from "./app-versions";
import { shortAgo } from "./inbox";

const props = defineProps<{ app: HubApp }>();
const emit = defineEmits<{ close: []; /** Files were put back: the app shows them once it reloads. */ restored: [] }>();
const { t } = useI18n();

const versions = ref<AppVersion[]>([]), truncated = ref(false), loading = ref(true), problem = ref("");
/** The version whose "Restore" is asking for confirmation, and the one being restored. */
const confirming = ref<number>(), busy = ref<number>();
async function load() {
  loading.value = true; problem.value = "";
  try { const result = await listVersions(props.app); versions.value = result.versions; truncated.value = result.truncated; }
  catch (cause) { problem.value = errorMessage(cause); }
  finally { loading.value = false; }
}
onMounted(load);
async function restore(version: AppVersion) {
  if (busy.value !== undefined) return;
  busy.value = version.id; problem.value = "";
  try {
    const outcome = await restoreVersion(props.app, version.id);
    showToast(restoreSummary(outcome, t), { tone: outcome.skipped.length ? "info" : "success" });
    confirming.value = undefined;
    emit("restored");
    await load();
  } catch (cause) { problem.value = errorMessage(cause); }
  finally { busy.value = undefined; }
}
function when(version: AppVersion) { return shortAgo(version.at, t); }
</script>

<template>
  <section class="app-versions" role="region" :aria-label="t('Versions of {app}', { app: app.name })">
    <header class="app-versions-head">
      <Icon name="timer" :size="14" />
      <strong>{{ t('Versions') }}</strong>
      <small>{{ t('Every burst of changes to {path} is one version.', { path: app.code_path }) }}</small>
      <span class="flex-spacer" />
      <button type="button" class="icon-button" :aria-label="t('Close')" :title="t('Close')" @click="emit('close')"><Icon name="close" :size="13" /></button>
    </header>
    <p v-if="problem" class="inline-error" role="alert">{{ problem }}</p>
    <p v-if="loading" class="app-versions-note" role="status">{{ t('Loading…') }}</p>
    <p v-else-if="!versions.length" class="app-versions-note">{{ t('No versions yet: they appear as the files of the app change.') }}</p>
    <ol v-else class="app-versions-list">
      <li v-for="version in versions" :key="version.id" :class="['app-version', { current: version.current, confirming: confirming === version.id }]">
        <div class="app-version-main">
          <span :class="['app-version-author', version.author_kind]">{{ authorLabel(version, t) }}</span>
          <span class="app-version-title" :title="version.message ?? ''">{{ versionTitle(version, t) }}</span>
          <small class="app-version-meta" :title="filesTitle(version)">{{ when(version) }} · {{ t(version.count === 1 ? '{count} file' : '{count} files', { count: version.count }) }}</small>
        </div>
        <span v-if="version.current" class="app-version-flag">{{ t('Current') }}</span>
        <button v-else-if="confirming !== version.id" type="button" class="small-button" :disabled="busy !== undefined" @click="confirming = version.id">{{ t('Restore the app to this version') }}</button>
        <div v-if="confirming === version.id" class="app-version-confirm" role="group" :aria-label="t('Restore the app to this version')">
          <small>{{ t('Every file goes back to how it was then; later files are removed. The history keeps everything, so you can come back.') }}</small>
          <button type="button" class="small-button" :disabled="busy !== undefined" @click="confirming = undefined">{{ t('Cancel') }}</button>
          <button type="button" class="small-button primary" :disabled="busy !== undefined" @click="restore(version)">{{ busy === version.id ? t('Restoring…') : t('Restore') }}</button>
        </div>
      </li>
    </ol>
    <p v-if="truncated" class="app-versions-note">{{ t('Older versions are not shown.') }}</p>
  </section>
</template>

<style scoped>
.app-versions { flex: none; display: flex; flex-direction: column; max-height: 50%; min-height: 0; border-bottom: 1px solid var(--border); background: var(--surface); }
.app-versions-head { display: flex; align-items: center; gap: 8px; flex: none; min-height: 34px; padding: 4px 6px 4px 12px; border-bottom: 1px solid var(--border); color: var(--ink); font-size: var(--text-sm); }
.app-versions-head > svg { color: var(--muted); flex: none; }
.app-versions-head > small { color: var(--muted); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.flex-spacer { flex: 1; }
.app-versions-note { margin: 0; padding: 8px 12px; color: var(--muted); font-size: var(--text-sm); }
.app-versions-list { flex: 1; min-height: 0; margin: 0; padding: 4px 0; overflow: auto; list-style: none; }
.app-version { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; padding: 6px 12px; border-bottom: 1px solid var(--border); min-width: 0; }
.app-version:last-child { border-bottom: 0; }
.app-version.confirming { background: var(--accent-soft); }
.app-version-main { display: grid; gap: 1px; flex: 1 1 200px; min-width: 0; }
.app-version-author { font-size: var(--text-xs); font-weight: 600; color: var(--muted); }
.app-version-author.agent { color: var(--accent-ink); }
.app-version-title { color: var(--ink); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-version-meta { color: var(--muted); font-size: var(--text-xs); }
.app-version-flag { flex: none; padding: 1px 8px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); }
.app-version-confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 1 1 100%; }
.app-version-confirm > small { flex: 1 1 200px; color: var(--ink-soft); font-size: var(--text-xs); }
@media (pointer: coarse) { .app-versions .small-button { min-height: 44px; } .app-versions-head .icon-button { width: 44px; height: 44px; } }
</style>
