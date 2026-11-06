<script setup lang="ts">
/** Versions of one file: who changed it and when, a diff, and restore. */
import { computed, ref, watch } from "vue";
import Icon from "../Icon.vue";
import GitDiffLines from "../GitDiffLines.vue";
import { useI18n } from "../../i18n";
import { ago, authorLabel, listVersions, readCurrent, readVersion, restoreVersion, size, unifiedDiff, type FileVersion } from "./history";

const props = defineProps<{ workspaceId: string; path: string; dirty: boolean }>();
const emit = defineEmits<{ close: []; restored: [] }>();
const { t } = useI18n();

const versions = ref<FileVersion[]>([]);
const loading = ref(true);
const error = ref("");
const selected = ref<number>();
const diff = ref<string>();
const base = ref<"previous" | "current">("previous");
const content = ref<string>();
const viewing = ref(false);
const comparing = ref(false);
const restoring = ref(false);
const confirming = ref(false);
/** Content already fetched, by version id. */
const contents = new Map<number, string>();
let revision = 0;

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const chosen = computed(() => versions.value.find(v => v.id === selected.value));

async function contentOf(id: number) {
  const known = contents.get(id);
  if (known !== undefined) return known;
  const text = (await readVersion(id)).content;
  contents.set(id, text);
  return text;
}

async function load() {
  const own = ++revision;
  loading.value = true;
  error.value = "";
  try {
    const list = await listVersions(props.workspaceId, props.path);
    if (own !== revision) return;
    versions.value = list;
    if (selected.value === undefined || !list.some(v => v.id === selected.value)) {
      if (list[0]) void select(list[0].id); else selected.value = undefined;
    }
  } catch (cause) {
    if (own === revision) error.value = message(cause);
  } finally {
    if (own === revision) loading.value = false;
  }
}

async function select(id: number) {
  selected.value = id;
  viewing.value = false;
  confirming.value = false;
  diff.value = undefined;
  content.value = undefined;
  comparing.value = true;
  const own = revision;
  try {
    const index = versions.value.findIndex(v => v.id === id);
    const previous = versions.value[index + 1];
    const text = await contentOf(id);
    // The oldest version is compared with what the file holds now.
    const before = previous ? await contentOf(previous.id) : await readCurrent(props.workspaceId, props.path).catch(() => "");
    if (own !== revision || selected.value !== id) return;
    content.value = text;
    base.value = previous ? "previous" : "current";
    diff.value = previous ? unifiedDiff(before, text) : unifiedDiff(text, before);
  } catch (cause) {
    if (selected.value === id) error.value = message(cause);
  } finally {
    if (selected.value === id) comparing.value = false;
  }
}

async function restore() {
  const version = chosen.value;
  if (!version) return;
  if (props.dirty && !confirming.value) { confirming.value = true; return; }
  restoring.value = true;
  error.value = "";
  try {
    await restoreVersion(version.id);
    confirming.value = false;
    emit("restored");
    await load();
  } catch (cause) {
    error.value = message(cause);
  } finally {
    restoring.value = false;
  }
}

watch(() => [props.workspaceId, props.path], () => { contents.clear(); selected.value = undefined; void load(); }, { immediate: true });
</script>

<template>
  <section class="file-history-panel" :aria-label="t('File history')">
    <header class="history-head">
      <Icon name="clock" :size="13" />
      <strong>{{ t('File history') }}</strong>
      <button type="button" class="icon-button" :aria-label="t('Refresh')" :title="t('Refresh')" :disabled="loading" @click="load"><Icon name="refresh" :size="13" /></button>
      <button type="button" class="icon-button" :aria-label="t('Close file history')" :title="t('Close')" @click="emit('close')"><Icon name="close" :size="13" /></button>
    </header>
    <div v-if="error" class="inline-error" role="alert">{{ error }}</div>
    <p v-if="loading && !versions.length" class="history-note">{{ t('Loading versions…') }}</p>
    <p v-else-if="!versions.length" class="history-note">{{ t('No versions yet. Tendly keeps a version each time this file changes.') }}</p>
    <div v-else class="history-body">
      <ol class="history-list">
        <li v-for="version in versions" :key="version.id">
          <button type="button" :class="['history-item', { active: version.id === selected }]" :aria-pressed="version.id === selected" @click="select(version.id)">
            <span :class="['history-author', version.author_kind]">{{ authorLabel(version, t) }}</span>
            <span class="history-meta"><time :datetime="version.created_at" :title="new Date(version.created_at).toLocaleString()">{{ ago(version.created_at, t) }}</time> · {{ size(version.size) }}</span>
          </button>
        </li>
      </ol>
      <div v-if="chosen" class="history-detail">
        <div class="history-actions">
          <span class="history-caption">{{ viewing ? t('This version') : base === 'previous' ? t('Changes from the previous version') : t('Compared with the current file') }}</span>
          <button type="button" class="small-button" :disabled="content === undefined" @click="viewing = !viewing">{{ viewing ? t('Show changes') : t('View this version') }}</button>
          <button type="button" :class="['small-button', confirming ? 'danger' : 'primary']" :disabled="restoring || content === undefined" @click="restore"><Icon name="restore" :size="13" />{{ restoring ? t('Restoring…') : confirming ? t('Replace draft and restore') : t('Restore') }}</button>
          <button v-if="confirming" type="button" class="small-button" @click="confirming = false">{{ t('Cancel') }}</button>
        </div>
        <p v-if="confirming" class="history-warning" role="alert">{{ t('This file has unsaved changes. Restoring replaces your draft with this version.') }}</p>
        <p v-if="comparing" class="history-note">{{ t('Comparing…') }}</p>
        <pre v-else-if="viewing" class="history-content" tabindex="0" :aria-label="t('Content of this version')">{{ content }}</pre>
        <GitDiffLines v-else-if="diff" class="history-diff" :diff="diff" />
        <p v-else-if="diff === ''" class="history-note">{{ base === 'previous' ? t('No line changes from the previous version.') : t('Same as the current file.') }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.file-history-panel{display:flex;flex-direction:column;max-height:min(46vh,420px);min-height:0;border-bottom:1px solid var(--line);background:var(--elevated);flex-shrink:0}
.history-head{display:flex;align-items:center;gap:6px;padding:4px 6px 4px 11px;border-bottom:1px solid var(--line);color:var(--muted);font-size:var(--text-xs)}
.history-head strong{flex:1;color:var(--ink);font-weight:600}
.history-note{margin:0;padding:10px 12px;color:var(--muted);font-size:var(--text-sm)}
.history-body{display:flex;min-height:0;flex:1}
.history-list{list-style:none;margin:0;padding:4px;width:min(38%,240px);flex-shrink:0;overflow:auto;border-right:1px solid var(--line)}
.history-item{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;padding:5px 8px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--ink);text-align:left;cursor:pointer}
.history-item:hover{background:var(--fill-hover)}
.history-item.active{background:var(--fill)}
.history-author{font-size:var(--text-sm);font-weight:550;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.history-author.agent{color:var(--accent)}
.history-author.unknown{color:var(--muted)}
.history-meta{font-size:var(--text-xs);color:var(--faint)}
.history-detail{display:flex;flex-direction:column;min-width:0;min-height:0;flex:1}
.history-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:6px 8px;border-bottom:1px solid var(--line)}
.history-caption{flex:1;min-width:0;color:var(--muted);font-size:var(--text-xs)}
.history-actions .small-button{min-height:26px;padding:0 9px;font-size:var(--text-xs)}
.history-warning{margin:0;padding:6px 10px;background:var(--surface);color:var(--warn);font-size:var(--text-xs);border-bottom:1px solid var(--line)}
.history-content{margin:0;padding:8px 12px;overflow:auto;flex:1;min-height:0;font:var(--text-xs)/19px var(--mono);color:var(--ink);background:var(--surface);white-space:pre}
.history-diff{flex:1;min-height:0;overflow:auto;background:var(--surface)}
@media (max-width: 640px){.history-body{flex-direction:column}.history-list{width:auto;max-height:30%;border-right:0;border-bottom:1px solid var(--line)}}
</style>
