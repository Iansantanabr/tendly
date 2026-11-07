<script setup lang="ts">
/**
 * "Add shortcut" (and editing one): name, address, letter and colour. The
 * server keeps it and checks whether the site can be framed.
 */
import { computed, nextTick, onMounted, reactive, ref } from "vue";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import AppTile from "./AppTile.vue";
import { APP_COLORS, appLetter, type AppColor } from "./app-tile";
import { createShortcut, updateShortcut, type Shortcut } from "./shortcuts";

const props = defineProps<{ /** Editing this one; otherwise a new one. */ shortcut?: Shortcut }>();
const emit = defineEmits<{ saved: [shortcut: Shortcut]; cancel: [] }>();
const { t } = useI18n();

const form = reactive({ name: props.shortcut?.name ?? "", url: props.shortcut?.url ?? "", letter: props.shortcut?.letter ?? "", color: (props.shortcut?.color ?? "slate") as AppColor });
const ownLetter = ref(!!props.shortcut), ownColor = ref(!!props.shortcut);
const busy = ref(false), problem = ref("");
const nameField = ref<HTMLInputElement>();
onMounted(async () => { await nextTick(); nameField.value?.focus(); });

function typedName() {
  if (!ownLetter.value) form.letter = appLetter(undefined, form.name || "A");
  if (!ownColor.value) { let hash = 0; for (const char of form.name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0; form.color = APP_COLORS[hash % APP_COLORS.length]; }
}
/** A pasted address without a scheme gets https. */
function typedUrl() { const value = form.url.trim(); if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value)) form.url = `https://${value}`; }
const valid = computed(() => !!form.name.trim() && /^https?:\/\/\S+/i.test(form.url.trim()));

async function save() {
  if (!valid.value || busy.value) return;
  busy.value = true; problem.value = "";
  try {
    const input = { name: form.name.trim(), url: form.url.trim(), letter: form.letter.trim() || undefined, color: form.color };
    emit("saved", props.shortcut ? await updateShortcut(props.shortcut.id, input) : await createShortcut(input));
  } catch (cause) { problem.value = errorMessage(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <form class="shortcut-form" :aria-label="shortcut ? t('Edit shortcut') : t('Add shortcut')" @submit.prevent="save" @keydown.esc.stop="emit('cancel')">
    <h2>{{ shortcut ? t('Edit shortcut') : t('Add shortcut') }}</h2>
    <p class="shortcut-form-hint">{{ t('A site with a tile of its own, beside your apps. It opens in a pane of the Mesa when the site allows it, else in a new tab.') }}</p>
    <div class="shortcut-form-row">
      <label class="shortcut-field grow"><span>{{ t('Name') }}</span><input ref="nameField" v-model="form.name" type="text" maxlength="80" required :placeholder="t('Notion')" @input="typedName" /></label>
      <label class="shortcut-field narrow"><span>{{ t('Letter') }}</span><input v-model="form.letter" type="text" maxlength="2" :aria-label="t('Letter on the tile')" @input="ownLetter = true" /></label>
    </div>
    <label class="shortcut-field"><span>{{ t('Address') }}</span><input v-model="form.url" type="url" inputmode="url" maxlength="2000" required placeholder="https://" @blur="typedUrl" /></label>
    <label class="shortcut-field"><span>{{ t('Colour') }}</span>
      <span class="shortcut-colours" role="radiogroup" :aria-label="t('Colour')">
        <button v-for="colour in APP_COLORS" :key="colour" type="button" role="radio" :aria-checked="form.color === colour" :aria-label="t(colour)" :title="t(colour)" :class="['shortcut-colour', { chosen: form.color === colour }]" @click="ownColor = true; form.color = colour"><AppTile :name="form.name || 'A'" :letter="form.letter" :color="colour" :size="22" /></button>
      </span>
    </label>
    <p v-if="problem" class="inline-error" role="alert">{{ problem }}</p>
    <footer class="shortcut-form-actions">
      <button type="button" class="secondary-button" @click="emit('cancel')">{{ t('Cancel') }}</button>
      <button type="submit" class="primary-button" :disabled="!valid || busy">{{ busy ? t('Saving…') : shortcut ? t('Save') : t('Add') }}</button>
    </footer>
  </form>
</template>

<style scoped>
.shortcut-form { display: grid; gap: var(--space-3); padding: var(--space-4); min-width: 0; }
.shortcut-form h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.shortcut-form-hint { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.shortcut-form-row { display: flex; gap: var(--space-3); align-items: flex-end; }
.shortcut-field { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--muted); min-width: 0; }
.shortcut-field.grow { flex: 1; }
.shortcut-field.narrow { width: 64px; }
.shortcut-field input { font: inherit; font-size: var(--text-md); color: var(--ink); background: var(--surface); border: 1px solid var(--line-input); border-radius: var(--radius-sm); padding: 6px 10px; min-width: 0; }
.shortcut-field input:focus { border-color: var(--accent); }
.shortcut-colours { display: flex; flex-wrap: wrap; gap: 4px; }
.shortcut-colour { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 2px solid transparent; border-radius: var(--radius-sm); background: none; cursor: pointer; }
.shortcut-colour.chosen { border-color: var(--accent); }
.shortcut-form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
@media (pointer: coarse) { .shortcut-colour { width: 44px; height: 44px; } }
</style>
