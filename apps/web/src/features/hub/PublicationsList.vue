<script setup lang="ts">
/** Every published file: its link, who sees it, how it updates, and Unpublish (two clicks, inline). */
import { onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { errorMessage } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../../i18n";
import { MODE_SHORT, VISIBILITY_SHORT, fileName, listPublications, publicLink, unpublish, type Publication } from "./publish";

/** `compact` is the short list inside the publish panel; the Settings page shows every column. */
const props = defineProps<{ compact?: boolean; current?: string | null }>();
const emit = defineEmits<{ removed: [slug: string] }>();
const { t } = useI18n();

const items = ref<Publication[]>();
const error = ref(""), busy = ref(""), copied = ref("");
/** The slug whose Unpublish is armed: the next click on it confirms. */
const removing = ref<string | null>(null);
const origin = typeof location === "undefined" ? "" : location.origin;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

async function load() {
  error.value = "";
  try { items.value = await listPublications(); }
  catch (cause) { error.value = errorMessage(cause); }
}
onMounted(load);
defineExpose({ load });

const when = (at: string | null) => at ? new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

async function copy(item: Publication) {
  await copyText(publicLink(item, origin));
  copied.value = item.slug;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => { copied.value = ""; }, 1500);
}

async function remove(item: Publication) {
  if (removing.value !== item.slug) { removing.value = item.slug; return; }
  removing.value = null;
  busy.value = item.slug; error.value = "";
  try {
    await unpublish(item.slug);
    items.value = items.value?.filter(other => other.slug !== item.slug);
    emit("removed", item.slug);
  } catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = ""; }
}
</script>

<template>
  <div :class="['publications', { compact: props.compact }]">
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-if="!items && !error" class="publications-hint">{{ t('Loading…') }}</p>
    <p v-else-if="items && !items.length" class="publications-hint">{{ t('Nothing is published yet.') }}</p>
    <ul v-else-if="items" class="publications-list">
      <li v-for="item in items" :key="item.slug" :class="{ current: item.slug === props.current }">
        <div class="publications-main">
          <a :href="item.url" target="_blank" rel="noopener" class="publications-name" :title="item.path">{{ fileName(item.path) }}</a>
          <code class="publications-url" :title="publicLink(item, origin)">{{ item.url }}</code>
          <span v-if="!props.compact" class="publications-meta">
            <span class="publications-pill">{{ t(VISIBILITY_SHORT[item.visibility]) }}</span>
            <span class="publications-pill">{{ t(MODE_SHORT[item.mode]) }}</span>
            <span v-if="item.mode === 'frozen' && item.frozen_at">{{ t('Frozen at {time}', { time: when(item.frozen_at) }) }}</span>
            <span class="publications-path" :title="item.path">{{ item.path }}</span>
          </span>
        </div>
        <div class="publications-actions">
          <template v-if="!props.compact">
            <button type="button" class="small-button" :aria-label="t('Copy link to {name}', { name: fileName(item.path) })" @click="copy(item)"><Icon :name="copied === item.slug ? 'check' : 'clipboard'" :size="13" /><span role="status">{{ t(copied === item.slug ? 'Copied' : 'Copy') }}</span></button>
            <a class="small-button" :href="item.url" target="_blank" rel="noopener" :aria-label="t('Open {name} in a new tab', { name: fileName(item.path) })">{{ t('Open') }}</a>
          </template>
          <button v-if="removing === item.slug" type="button" class="small-button" @click="removing = null">{{ t('Cancel') }}</button>
          <button type="button" class="small-button danger" :disabled="!!busy" @click="remove(item)">{{ t(busy === item.slug ? 'Unpublishing…' : removing === item.slug ? 'Confirm unpublish' : 'Unpublish') }}</button>
        </div>
        <p v-if="removing === item.slug" class="publications-hint publications-confirm" role="alert">{{ t('Unpublish {name}? The link stops working.', { name: fileName(item.path) }) }}</p>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.publications { display: grid; gap: var(--space-2); min-width: 0; }
.publications > .inline-error { margin: 0; }
.publications-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); }
.publications-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.publications-list li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: 10px 14px; min-width: 0; }
.publications-list li + li { border-top: 1px solid var(--line); }
.publications-list li.current { background: var(--fill); }
.publications-main { flex: 1 1 16rem; min-width: 0; display: grid; gap: 2px; }
.publications-name { color: var(--ink); font-weight: 600; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.publications-name:hover { color: var(--accent); text-decoration: underline; }
.publications-url { font-family: var(--mono); color: var(--muted); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.publications-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--muted); font-size: var(--text-xs); min-width: 0; }
.publications-pill { padding: 0 8px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-weight: 600; }
.publications-path { font-family: var(--mono); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.publications-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.publications-confirm { flex-basis: 100%; }
.compact .publications-list { border: 0; border-radius: 0; background: none; max-height: 220px; overflow: auto; }
.compact .publications-list li { padding: 4px 6px; border-top: 0; border-radius: var(--radius-sm); }
.compact .publications-list li:hover { background: var(--fill-hover); }
.compact .publications-main { display: flex; align-items: center; gap: var(--space-2); }
.compact .publications-name { font-weight: 500; }
</style>
