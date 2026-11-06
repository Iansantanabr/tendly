<script setup lang="ts">
/** The Mesa's space control: the open space's name (● when the canvas changed since it was saved) and a menu to save, rename, delete and open spaces. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { spaceNameError, type SpaceControl } from "./spaces";

const props = defineProps<{ spaces: SpaceControl }>();
const { t } = useI18n();

const root = ref<HTMLDetailsElement>(), field = ref<HTMLInputElement>();
const isOpen = ref(false);
/** The inline form in use: a new space's name, or a new name for the active one. */
const editing = ref<"new" | "rename" | null>(null);
const draft = ref(""), touched = ref(false);
/** Delete is armed: the next click confirms. */
const confirmingDelete = ref(false);
const note = ref("");

const control = computed(() => props.spaces);
const state = computed(() => control.value.state);
const active = computed(() => control.value.active.value);
const dirty = computed(() => control.value.dirty.value);
const label = computed(() => active.value?.name ?? t("Mesa"));
const draftError = computed(() => spaceNameError(draft.value, state.value.list, editing.value === "rename" ? active.value?.id : undefined));

function reset() { editing.value = null; draft.value = ""; touched.value = false; confirmingDelete.value = false; note.value = ""; }
function close() { if (root.value) root.value.open = false; }
function toggled() {
  isOpen.value = !!root.value?.open;
  reset();
  if (isOpen.value) void control.value.refresh();
}
async function edit(kind: "new" | "rename") {
  reset(); editing.value = kind; draft.value = kind === "rename" ? active.value?.name ?? "" : "";
  await nextTick(); field.value?.focus(); field.value?.select();
}
async function submit() {
  touched.value = true;
  if (draftError.value || state.value.busy) return;
  const done = editing.value === "rename" && active.value
    ? await control.value.rename(active.value.id, draft.value)
    : await control.value.saveAs(draft.value);
  if (done) { reset(); close(); }
}
async function save() { if (await control.value.save()) close(); }
async function remove() {
  if (!active.value) return;
  if (!confirmingDelete.value) { reset(); confirmingDelete.value = true; return; }
  if (await control.value.remove(active.value.id)) reset();
}
async function open(id: string) {
  reset();
  const result = await control.value.open(id);
  if (result === "opened") close();
  else if (result === "conflict") note.value = t("The canvas changed in another window. Choose a layout in the bar above, then open the space again.");
}

function keydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !root.value?.open) return;
  event.preventDefault(); event.stopPropagation();
  if (editing.value || confirmingDelete.value) { reset(); return; }
  close(); root.value.querySelector("summary")?.focus();
}
function outside(event: PointerEvent) {
  if (root.value?.open && event.target instanceof Node && !root.value.contains(event.target)) close();
}
onMounted(() => { document.addEventListener("pointerdown", outside); void control.value.refresh(); });
onBeforeUnmount(() => document.removeEventListener("pointerdown", outside));
</script>

<template>
  <details ref="root" class="space-menu" @toggle="toggled" @keydown="keydown">
    <summary :title="dirty ? t('{name} · changed since it was saved', { name: label }) : t('Space: {name}', { name: label })" :aria-label="dirty ? t('{name} · changed since it was saved', { name: label }) : t('Space: {name}', { name: label })">
      <Icon name="layout" :size="13" /><span class="space-name">{{ label }}</span><i v-if="dirty" class="space-dirty" aria-hidden="true" /><Icon name="chevron" :size="10" class="space-caret" />
    </summary>
    <div class="space-panel" role="group" :aria-label="t('Spaces')">
      <template v-if="active">
        <div class="space-label">{{ t('This space') }}</div>
        <button type="button" class="space-row" :disabled="state.busy" @click="save"><Icon name="check" :size="14" /><span>{{ t('Save') }}</span><small v-if="dirty">{{ t('Changed') }}</small></button>
        <button type="button" class="space-row" :disabled="state.busy" @click="edit('rename')"><Icon name="edit" :size="14" /><span>{{ t('Rename') }}</span></button>
        <button type="button" :class="['space-row', { danger: confirmingDelete }]" :disabled="state.busy" @click="remove"><Icon name="close" :size="14" /><span>{{ confirmingDelete ? t('Click again to delete “{name}”', { name: active.name }) : t('Delete') }}</span></button>
        <p v-if="confirmingDelete" class="space-hint" role="alert">{{ t('The layout on the Mesa stays; only the saved space goes.') }}</p>
        <div class="space-divider" />
      </template>
      <form v-if="editing" class="space-form" @submit.prevent="submit">
        <label :for="'space-name-' + editing">{{ editing === 'rename' ? t('New name') : t('Space name') }}</label>
        <input :id="'space-name-' + editing" ref="field" v-model="draft" maxlength="200" autocomplete="off" :aria-invalid="touched && !!draftError" @input="touched = true" />
        <p v-if="touched && draftError" class="space-hint danger-text" role="alert">{{ t(draftError) }}</p>
        <div class="space-form-actions">
          <button type="button" class="small-button" @click="reset">{{ t('Cancel') }}</button>
          <button type="submit" class="small-button primary" :disabled="state.busy || !!draftError">{{ editing === 'rename' ? t('Rename') : t('Save') }}</button>
        </div>
      </form>
      <button v-else type="button" class="space-row" :disabled="state.busy" @click="edit('new')"><Icon name="plus" :size="14" /><span>{{ t('Save as space…') }}</span></button>
      <div class="space-divider" />
      <div class="space-label">{{ t('Spaces') }}</div>
      <p v-if="state.loaded && !state.list.length" class="space-hint">{{ t('No saved spaces yet. Arrange the Mesa, then save it as a space.') }}</p>
      <div class="space-list">
        <button v-for="space in state.list" :key="space.id" type="button" class="space-row" :aria-current="space.id === state.activeId ? 'true' : undefined" :disabled="state.busy" :title="t('Open {name}', { name: space.name })" @click="open(space.id)">
          <span class="space-check"><Icon v-if="space.id === state.activeId" name="check" :size="13" /></span><span>{{ space.name }}</span>
        </button>
      </div>
      <p v-if="note" class="space-hint" role="status">{{ note }}</p>
      <p v-if="state.error" class="space-hint danger-text" role="alert">{{ state.error }}</p>
    </div>
  </details>
</template>

<style scoped>
.space-menu { position: relative; }
.space-menu > summary { display: flex; align-items: center; gap: 5px; min-height: 22px; max-width: 220px; padding: 2px 6px; border-radius: var(--radius-sm); list-style: none; color: var(--ink-soft); font-size: var(--text-xs); cursor: pointer; box-sizing: border-box; }
.space-menu > summary::-webkit-details-marker { display: none; }
.space-menu[open] > summary, .space-menu > summary:hover { background: var(--fill); color: var(--ink); }
.space-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-dirty { flex-shrink: 0; width: 6px; height: 6px; border-radius: var(--radius-full); background: var(--warn); }
.space-caret { transform: rotate(-90deg); flex-shrink: 0; }
.space-panel { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 40; width: 260px; max-width: calc(100vw - 28px); max-height: min(70vh, 440px); overflow-y: auto; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--elevated); box-shadow: var(--shadow-lg); box-sizing: border-box; }
.space-label { padding: 4px 7px 6px; font-size: var(--text-xs); font-weight: 600; color: var(--faint); }
.space-row { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 32px; border: 0; border-radius: var(--radius-sm); padding: 7px; background: transparent; font-family: inherit; font-size: var(--text-xs); color: var(--ink-soft); text-align: left; cursor: pointer; }
.space-row > span:not(.space-check) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-row:hover:not(:disabled) { background: var(--fill); color: var(--ink); }
.space-row:disabled { opacity: .6; cursor: default; }
.space-row[aria-current] { color: var(--ink); font-weight: 600; }
.space-row.danger { color: var(--danger); }
.space-row small { color: var(--warn-ink); font-size: var(--text-xs); }
.space-check { display: inline-flex; width: 14px; flex-shrink: 0; color: var(--accent); }
.space-divider { height: 1px; background: var(--fill); margin: 5px 4px; }
.space-hint { margin: 2px 7px 6px; font-size: var(--text-xs); line-height: 1.4; color: var(--muted); }
.space-form { display: grid; gap: 6px; padding: 4px 7px 6px; }
.space-form label { font-size: var(--text-xs); font-weight: 600; color: var(--ink-soft); }
.space-form input { min-height: 30px; padding: 4px 8px; border: 1px solid var(--line-input); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: var(--text-sm); box-sizing: border-box; }
.space-form .space-hint { margin: 0; }
.space-form-actions { display: flex; justify-content: flex-end; gap: 6px; }
.space-menu > summary:focus-visible, .space-row:focus-visible, .space-form input:focus-visible, .space-form-actions button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
@media (pointer: coarse) {
  .space-menu > summary { min-height: 44px; }
  .space-row, .space-form input, .space-form-actions button { min-height: 44px; }
}
</style>
