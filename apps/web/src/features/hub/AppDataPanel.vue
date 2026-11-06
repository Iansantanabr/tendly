<script setup lang="ts">
/**
 * A collection of an app out of Tendly, or back in: what "Export data…" and
 * "Import data…" in the "…" of the app's header open, above the app.
 *
 * Export saves every record of one collection as JSON (everything, to keep or
 * to import again) or CSV (one column per field, for a spreadsheet). Import
 * reads such a file into a collection, added to what is there or instead of
 * it; replacing what is there is confirmed here, in place.
 */
import { computed, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "../Icon.vue";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import { exportCollection, formatOf, importCollection, importSummary, listCollections, saveBlob, validCollection, type AppCollection, type ImportMode, type TransferFormat } from "./app-records";

const props = defineProps<{
  app: { workspace_id: string; slug: string; name: string };
  mode: "export" | "import";
  /** The app's collections, when whoever shows this already has them; they are asked of the server either way. */
  known?: AppCollection[];
}>();
const emit = defineEmits<{ close: []; /** Records were written: the app on screen may need to read them again. */ imported: [collection: string] }>();
const { t } = useI18n();

const collections = ref<AppCollection[]>(props.known ?? []), loading = ref(!props.known);
const problem = ref(""), done = ref(""), busy = ref(false);
// Export
const collection = ref(collections.value[0]?.name ?? ""), format = ref<TransferFormat>("json");
// Import
const target = ref(""), file = shallowRef<File>(), importMode = ref<ImportMode>("merge"), confirming = ref(false);
const listId = `app-data-collections-${Math.random().toString(36).slice(2, 8)}`;

const title = computed(() => props.mode === "export" ? t('Export data from {app}', { app: props.app.name }) : t('Import data into {app}', { app: props.app.name }));
/** How many records the collection being imported into already holds. */
const there = computed(() => collections.value.find(known => known.name === target.value.trim())?.count ?? 0);
const canImport = computed(() => !!file.value && validCollection(target.value.trim()) && !busy.value);

let turn = 0;
async function load() {
  const mine = ++turn;
  loading.value = true;
  try {
    const listed = await listCollections(props.app);
    if (mine !== turn) return;
    collections.value = listed;
    if (!listed.some(known => known.name === collection.value)) collection.value = listed[0]?.name ?? "";
    if (!target.value && listed.length === 1) target.value = listed[0].name;
  } catch (cause) { if (mine === turn) problem.value = errorMessage(cause); }
  finally { if (mine === turn) loading.value = false; }
}
onMounted(load);
watch(() => `${props.app.workspace_id}/${props.app.slug}`, () => { collections.value = []; collection.value = ""; target.value = ""; file.value = undefined; reset(); void load(); });
watch(() => props.mode, reset);
watch([target, importMode, file], () => { confirming.value = false; });
function reset() { problem.value = ""; done.value = ""; confirming.value = false; }

async function runExport() {
  if (!collection.value || busy.value) return;
  reset(); busy.value = true;
  try {
    const saved = await exportCollection(props.app, collection.value, format.value);
    saveBlob(saved.blob, saved.filename);
    done.value = t('Saved {file}', { file: saved.filename });
  } catch (cause) { problem.value = errorMessage(cause); }
  finally { busy.value = false; }
}

function pick(event: Event) {
  const chosen = (event.target as HTMLInputElement).files?.[0];
  file.value = chosen;
  reset();
  // A file Tendly exported is named after its collection: `<app>-<collection>.json`.
  const guess = chosen?.name.replace(/\.[^.]+$/, "").replace(new RegExp(`^${props.app.slug}-`), "") ?? "";
  if (!target.value.trim() && validCollection(guess)) target.value = guess;
}
/** Replacing records that are there is asked first; anything else goes ahead. */
function startImport() {
  if (!canImport.value) return;
  if (importMode.value === "replace" && there.value > 0 && !confirming.value) { problem.value = ""; done.value = ""; confirming.value = true; return; }
  void runImport();
}
async function runImport() {
  const chosen = file.value, name = target.value.trim();
  if (!chosen || !validCollection(name) || busy.value) return;
  reset(); busy.value = true;
  try {
    const result = await importCollection(props.app, name, chosen, { format: formatOf(chosen.name), mode: importMode.value });
    const summary = importSummary(result);
    done.value = t(summary.text, summary.values);
    emit("imported", name);
    void load();
  } catch (cause) { problem.value = errorMessage(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <section class="app-data" role="region" :aria-label="title">
    <div class="app-data-card">
      <header>
        <Icon :name="mode === 'export' ? 'download' : 'upload'" :size="16" />
        <h3>{{ title }}</h3>
        <button type="button" class="icon-button" :aria-label="t('Close')" :title="t('Close')" @click="emit('close')"><Icon name="close" :size="13" /></button>
      </header>

      <template v-if="mode === 'export'">
        <p v-if="loading && !collections.length" class="app-data-note" role="status">{{ t('Loading…') }}</p>
        <p v-else-if="!collections.length && !problem" class="app-data-note">{{ t('This app keeps no records in collections yet, so there is nothing to export.') }}</p>
        <form v-else-if="collections.length" class="app-data-form" @submit.prevent="runExport">
          <label class="app-data-field"><span>{{ t('Collection') }}</span>
            <select v-model="collection"><option v-for="known in collections" :key="known.name" :value="known.name">{{ t(known.count === 1 ? '{name} · {count} record' : '{name} · {count} records', { name: known.name, count: known.count }) }}</option></select>
          </label>
          <fieldset class="app-data-choice">
            <legend>{{ t('Format') }}</legend>
            <label><input v-model="format" type="radio" value="json" /><span><strong>JSON</strong><small>{{ t('Everything, as it is stored. For a backup, or to import again.') }}</small></span></label>
            <label><input v-model="format" type="radio" value="csv" /><span><strong>CSV</strong><small>{{ t('One column per field, for a spreadsheet. Lists and nested values go as text.') }}</small></span></label>
          </fieldset>
          <footer>
            <span class="app-data-done" role="status">{{ done }}</span>
            <button type="submit" class="small-button primary" :disabled="busy || !collection">{{ busy ? t('Exporting…') : t('Export') }}</button>
          </footer>
        </form>
      </template>

      <form v-else class="app-data-form" @submit.prevent="startImport">
        <label class="app-data-field"><span>{{ t('File (JSON or CSV)') }}</span>
          <input type="file" accept=".json,.csv,application/json,text/csv" @change="pick" />
        </label>
        <label class="app-data-field"><span>{{ t('Into the collection') }}</span>
          <input v-model="target" type="text" maxlength="64" spellcheck="false" autocapitalize="off" autocomplete="off" :list="listId" placeholder="leads" :aria-invalid="!!target.trim() && !validCollection(target.trim())" />
          <datalist :id="listId"><option v-for="known in collections" :key="known.name" :value="known.name" /></datalist>
          <small v-if="target.trim() && !validCollection(target.trim())" class="app-data-hint is-problem">{{ t('Letters, digits, _ and -, up to 64 characters.') }}</small>
          <small v-else-if="target.trim() && !loading" class="app-data-hint">{{ there ? t(there === 1 ? 'It has {count} record now.' : 'It has {count} records now.', { count: there }) : t('A new collection.') }}</small>
        </label>
        <fieldset class="app-data-choice">
          <legend>{{ t('Records already there') }}</legend>
          <label><input v-model="importMode" type="radio" value="merge" /><span><strong>{{ t('Keep them') }}</strong><small>{{ t('A record in the file with the same id replaces the one there; the rest are added.') }}</small></span></label>
          <label><input v-model="importMode" type="radio" value="replace" /><span><strong>{{ t('Remove them first') }}</strong><small>{{ t('The collection ends up with only what is in the file.') }}</small></span></label>
        </fieldset>
        <div v-if="confirming" class="app-data-confirm" role="alert">
          <span>{{ t(there === 1 ? 'This removes the {count} record in {collection} before importing. It cannot be undone.' : 'This removes the {count} records in {collection} before importing. It cannot be undone.', { count: there, collection: target.trim() }) }}</span>
          <span class="app-data-confirm-actions">
            <button type="button" class="small-button" :disabled="busy" @click="confirming = false">{{ t('Cancel') }}</button>
            <button type="button" class="small-button danger" :disabled="busy" @click="runImport">{{ t('Remove and import') }}</button>
          </span>
        </div>
        <footer v-else>
          <span class="app-data-done" role="status">{{ done }}</span>
          <button type="submit" class="small-button primary" :disabled="!canImport">{{ busy ? t('Importing…') : t('Import') }}</button>
        </footer>
      </form>

      <p v-if="problem" class="app-data-problem" role="alert">{{ problem }}</p>
    </div>
  </section>
</template>

<style scoped>
.app-data { flex: none; min-width: 0; max-height: 70%; overflow: auto; border-bottom: 1px solid var(--border); padding: 10px 12px; background: var(--surface); }
.app-data-card { display: grid; gap: 10px; width: 100%; max-width: 520px; min-width: 0; }
.app-data header { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); }
.app-data h3 { flex: 1; min-width: 0; margin: 0; color: var(--ink); font-size: var(--text-md); font-weight: 600; overflow-wrap: anywhere; }
.app-data-note { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.app-data-form { display: grid; gap: 10px; min-width: 0; }
.app-data-field { display: grid; gap: 4px; min-width: 0; color: var(--muted); font-size: var(--text-sm); }
.app-data-field :is(input, select) { min-width: 0; max-width: 100%; padding: 6px 10px; border: 1px solid var(--line-input); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: var(--text-md); }
.app-data-field input[type="file"] { padding: 5px 6px; font-size: var(--text-sm); }
.app-data-field :is(input, select)[aria-invalid="true"] { border-color: var(--danger-line); }
.app-data-hint { color: var(--muted); font-size: var(--text-xs); }
.app-data-hint.is-problem { color: var(--danger-ink); }
.app-data-choice { display: grid; gap: 4px; min-width: 0; margin: 0; padding: 0; border: 0; }
.app-data-choice legend { padding: 0; margin-bottom: 4px; color: var(--muted); font-size: var(--text-sm); }
.app-data-choice label { display: flex; align-items: flex-start; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--sunken); min-width: 0; cursor: pointer; }
.app-data-choice label:has(input:checked) { border-color: var(--line-input); background: var(--elevated); }
.app-data-choice input { flex: none; margin: 3px 0 0; }
.app-data-choice label > span { display: grid; gap: 1px; min-width: 0; }
.app-data-choice strong { color: var(--ink); font-size: var(--text-sm); font-weight: 600; }
.app-data-choice small { color: var(--muted); font-size: var(--text-xs); overflow-wrap: anywhere; }
.app-data footer { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 8px; min-width: 0; }
.app-data-done { flex: 1; min-width: 0; color: var(--ok-ink); font-size: var(--text-sm); overflow-wrap: anywhere; }
.app-data-confirm { display: grid; gap: 8px; padding: 8px 10px; border: 1px solid var(--danger-line); border-radius: var(--radius-sm); background: var(--danger-soft); color: var(--danger-ink); font-size: var(--text-sm); }
.app-data-confirm-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.app-data-problem { margin: 0; padding: 6px 10px; border: 1px solid var(--danger-line); border-radius: var(--radius-sm); background: var(--danger-soft); color: var(--danger-ink); font-size: var(--text-sm); overflow-wrap: anywhere; }
@media (pointer: coarse) {
  .app-data .small-button { min-height: 44px; min-width: 44px; }
  .app-data .icon-button { width: 44px; height: 44px; }
  .app-data-field :is(input, select) { min-height: 44px; }
  .app-data-choice label { min-height: 44px; align-items: center; }
  .app-data-choice input { margin: 0; }
}
</style>
