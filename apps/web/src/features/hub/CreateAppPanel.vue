<script setup lang="ts">
/**
 * "Create with the agent": one sentence, a template, and a name, letter and
 * colour guessed from the sentence (no model is asked). Creating makes the app
 * from the template on the server and hands it up with the first message for
 * a composer; nothing is sent from here.
 */
import { computed, nextTick, reactive, ref, watch } from "vue";
import type { Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { ApiError, errorMessage } from "../api";
import { useI18n } from "../../i18n";
import AppTile from "./AppTile.vue";
import { APP_COLORS, appLetter, type AppColor } from "./app-tile";
import { freeSlug, refreshApps, scaffoldApp, type HubApp } from "./apps";
import { TEMPLATES, TEMPLATE_GROUPS, builderPrompt, suggest, type Template, type TemplateId } from "./builder";

const props = defineProps<{ projects: Workspace[]; selectedWorkspaceId?: string; /** Where the cursor goes when "+" was pressed somewhere. */ focusKey?: number }>();
const emit = defineEmits<{ /** The app exists: open it on the Mesa with this text in a composer beside it. */ created: [app: HubApp, prompt: string] }>();
const { t, locale } = useI18n();

const STORAGE = "tendly.hub.apps";
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE) ?? "{}"); } catch { return {}; } })();
const form = reactive({ sentence: "", template: "blank" as TemplateId, name: "", letter: "", color: "slate" as AppColor, workspaceId: (saved.workspace ?? props.selectedWorkspaceId) as string | undefined });
/** Which fields the person changed by hand: those stop following the sentence. */
const own = reactive({ template: false, name: false, letter: false, color: false });
const busy = ref(false), problem = ref("");
const sentenceField = ref<HTMLTextAreaElement>();

watch([() => props.projects, () => props.selectedWorkspaceId], ([list]) => {
  if (!list.some(w => w.id === form.workspaceId)) form.workspaceId = list.find(w => w.id === props.selectedWorkspaceId)?.id ?? list[0]?.id;
}, { immediate: true });
watch(() => form.workspaceId, id => { try { localStorage.setItem(STORAGE, JSON.stringify({ ...saved, workspace: id })); } catch { /* Fine without it. */ } });
watch(() => props.focusKey, async () => { await nextTick(); sentenceField.value?.focus(); sentenceField.value?.scrollIntoView?.({ block: "nearest" }); });

/** The sentence fills in whatever the person has not set by hand. */
watch(() => form.sentence, sentence => {
  const guess = suggest(sentence, own.template ? form.template : undefined, t);
  if (!own.template) form.template = guess.template;
  if (!own.name) form.name = guess.name;
  if (!own.letter) form.letter = guess.letter;
  if (!own.color) form.color = guess.color;
}, { immediate: true });
function pickTemplate(id: TemplateId) {
  own.template = true;
  form.template = id;
  const guess = suggest(form.sentence, id, t);
  if (!own.name) form.name = guess.name;
  if (!own.letter) form.letter = guess.letter;
  if (!own.color) form.color = guess.color;
}

/** The list as drawn: the featured pair first, then each group that has templates, all in `TEMPLATES` order. */
const featured = TEMPLATES.filter(template => template.group === "featured");
const sections = TEMPLATE_GROUPS.map(group => ({ ...group, templates: TEMPLATES.filter(template => template.group === group.id) })).filter(group => group.templates.length);
/** Visual order across every group: what the arrow keys walk. */
const ordered: readonly Template[] = [...featured, ...sections.flatMap(section => section.templates)];
const templateList = ref<HTMLElement>();
/** Marked while the template still comes from the sentence (not blank: that is "nothing suggested"). */
const suggestedId = computed(() => !own.template && form.sentence.trim() && form.template !== "blank" ? form.template : undefined);
watch(suggestedId, async id => {
  if (!id) return;
  await nextTick();
  // Only brings the card into view; the sentence field keeps the focus.
  templateList.value?.querySelector<HTMLElement>(`[data-template="${id}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
});
/** One radio group: arrows (and Home/End) move across all groups and choose, the chosen card is the only tab stop. */
function templateKey(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const at = Math.max(0, ordered.findIndex(template => template.id === form.template));
  const to = event.key === "ArrowRight" || event.key === "ArrowDown" ? (at + 1) % ordered.length
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (at - 1 + ordered.length) % ordered.length
    : event.key === "Home" ? 0 : event.key === "End" ? ordered.length - 1 : -1;
  if (to < 0) return;
  event.preventDefault();
  pickTemplate(ordered[to].id);
  nextTick(() => templateList.value?.querySelector<HTMLElement>(`[data-template="${ordered[to].id}"]`)?.focus());
}
function typedName() { own.name = true; if (!own.letter) form.letter = appLetter(undefined, form.name || "A"); }

const canCreate = computed(() => !!form.name.trim() && !!form.workspaceId && !busy.value);
async function create() {
  const name = form.name.trim(), workspaceId = form.workspaceId;
  if (!name || !workspaceId || busy.value) return;
  busy.value = true; problem.value = "";
  try {
    await refreshApps();
    const app = await scaffoldApp(workspaceId, { slug: freeSlug(name, workspaceId), name, description: form.sentence.trim().slice(0, 500) || undefined, color: form.color, letter: form.letter.trim() || undefined, template: form.template, locale: locale.value });
    const prompt = builderPrompt({ app, sentence: form.sentence, template: form.template });
    form.sentence = ""; own.template = own.name = own.letter = own.color = false;
    emit("created", app, prompt);
  } catch (cause) {
    problem.value = cause instanceof ApiError && cause.status === 409 ? t("There is already an app in that folder. Choose another name.") : errorMessage(cause);
  } finally { busy.value = false; }
}
</script>

<template>
  <form class="create-app" :aria-label="t('Create with the agent')" @submit.prevent="create">
    <header class="create-app-head"><span class="create-app-icon"><Icon name="sparkles" :size="16" /></span><h2>{{ t('Create with the agent') }}</h2></header>
    <label class="create-app-field">
      <span>{{ t('What should the app do? One sentence.') }}</span>
      <textarea ref="sentenceField" v-model="form.sentence" rows="2" maxlength="500" :placeholder="t('A board with my deals by stage, where I can add and move them.')" />
    </label>
    <fieldset class="create-app-templates">
      <legend>{{ t('Start from') }}</legend>
      <div ref="templateList" class="create-app-template-list" role="radiogroup" :aria-label="t('Start from')" @keydown="templateKey">
        <template v-for="(block, index) in [{ id: 'featured', label: '', templates: featured }, ...sections]" :key="block.id">
          <section :class="['create-app-group', { featured: index === 0 }]" :aria-labelledby="index ? `create-app-group-${block.id}` : undefined">
            <h3 v-if="index" :id="`create-app-group-${block.id}`" class="create-app-group-title">{{ t(block.label) }}</h3>
            <div class="create-app-template-grid">
              <button v-for="template in block.templates" :key="template.id" type="button" role="radio" :aria-checked="form.template === template.id" :tabindex="form.template === template.id ? 0 : -1" :data-template="template.id" :class="['create-app-template', { chosen: form.template === template.id }]" :title="t(template.hint)" @click="pickTemplate(template.id)">
                <AppTile :name="t(template.label)" :letter="t(template.label)[0]" :color="template.color" :size="22" />
                <span class="create-app-template-text"><strong>{{ t(template.label) }}</strong><small>{{ t(template.hint) }}</small></span>
                <span v-if="suggestedId === template.id" class="create-app-suggested">{{ t('Suggested') }}</span>
              </button>
            </div>
          </section>
        </template>
      </div>
    </fieldset>
    <div class="create-app-row">
      <label class="create-app-field grow"><span>{{ t('Name') }}</span><input v-model="form.name" type="text" maxlength="60" required :placeholder="t('Sales pipeline')" @input="typedName" /></label>
      <label class="create-app-field narrow"><span>{{ t('Letter') }}</span><input v-model="form.letter" type="text" maxlength="2" :aria-label="t('Letter on the tile')" @input="own.letter = true" /></label>
      <label class="create-app-field"><span>{{ t('Colour') }}</span>
        <span class="create-app-colours" role="radiogroup" :aria-label="t('Colour')">
          <button v-for="colour in APP_COLORS" :key="colour" type="button" role="radio" :aria-checked="form.color === colour" :aria-label="t(colour)" :title="t(colour)" :class="['create-app-colour', { chosen: form.color === colour }]" @click="own.color = true; form.color = colour"><AppTile :name="form.name || 'A'" :letter="form.letter" :color="colour" :size="22" /></button>
        </span>
      </label>
    </div>
    <div class="create-app-row">
      <label class="create-app-field grow"><span>{{ t('Project') }}</span>
        <select v-model="form.workspaceId" :disabled="!projects.length"><option v-for="w in projects" :key="w.id" :value="w.id">{{ w.name }}</option></select>
      </label>
      <div class="create-app-preview" aria-hidden="true"><AppTile :name="form.name || 'A'" :letter="form.letter" :color="form.color" :size="36" /><span>{{ form.name || t('Name') }}</span></div>
    </div>
    <p v-if="!projects.length" class="inline-notice">{{ t('Add a project first: an app lives in a project folder.') }}</p>
    <p v-if="problem" class="inline-error" role="alert">{{ problem }}</p>
    <footer class="create-app-actions">
      <small class="create-app-note">{{ t('Creates the app from the template now, opens it on the Mesa with a conversation beside it and writes the first message for you. Nothing is sent until you press send.') }}</small>
      <button type="submit" class="primary-button" :disabled="!canCreate">{{ busy ? t('Creating…') : t('Create') }}</button>
    </footer>
  </form>
</template>

<style scoped>
.create-app { display: grid; gap: var(--space-3); padding: var(--space-4); min-width: 0; }
.create-app-head { display: flex; align-items: center; gap: var(--space-2); }
.create-app-head h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.create-app-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--accent-soft); color: var(--accent-ink); }
.create-app-field { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--muted); min-width: 0; }
.create-app-field.grow { flex: 1 1 180px; }
.create-app-field.narrow { width: 64px; }
.create-app-field input, .create-app-field select, .create-app-field textarea { font: inherit; font-size: var(--text-md); color: var(--ink); background: var(--surface); border: 1px solid var(--line-input); border-radius: var(--radius-sm); padding: 6px 10px; min-width: 0; }
.create-app-field textarea { resize: vertical; min-height: 56px; }
.create-app-field :is(input, select, textarea):focus { border-color: var(--accent); }
.create-app-templates { margin: 0; padding: 0; border: 0; min-width: 0; container-type: inline-size; }
.create-app-templates legend { padding: 0 0 4px; font-size: var(--text-sm); color: var(--muted); }
.create-app-template-list { display: grid; gap: var(--space-3); }
.create-app-group { display: grid; gap: var(--space-2); min-width: 0; break-inside: avoid; }
.create-app-group-title { margin: 0; font-size: var(--text-xs); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.create-app-template-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
.create-app-group.featured .create-app-template { padding: 12px; border-color: var(--line-input); background: linear-gradient(135deg, var(--accent-soft), var(--surface) 70%); }
.create-app-group.featured .create-app-template-text strong { font-size: var(--text-md); }
.create-app-group.featured .create-app-template:hover { background: var(--fill-hover); }
.create-app-group.featured .create-app-template.chosen { border-color: var(--accent); background: var(--accent-soft); }
.create-app-suggested { margin-left: auto; flex: none; padding: 1px 8px; border-radius: 999px; background: var(--accent); color: var(--surface); font-size: var(--text-xs); font-weight: 600; line-height: 1.5; }
.create-app-template:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.create-app-template { display: flex; align-items: flex-start; gap: var(--space-2); min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.create-app-template:hover { background: var(--fill-hover); }
.create-app-template.chosen { border-color: var(--accent); background: var(--accent-soft); }
.create-app-template-text { display: grid; gap: 1px; min-width: 0; }
.create-app-template-text strong { font-size: var(--text-sm); font-weight: 600; }
.create-app-template-text small { color: var(--muted); font-size: var(--text-xs); line-height: 1.35; }
.create-app-row { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); min-width: 0; }
.create-app-colours { display: flex; flex-wrap: wrap; gap: 4px; }
.create-app-colour { display: grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 2px solid transparent; border-radius: var(--radius-sm); background: none; cursor: pointer; }
.create-app-colour.chosen { border-color: var(--accent); }
.create-app-preview { display: flex; align-items: center; gap: var(--space-2); min-width: 0; padding-bottom: 2px; color: var(--ink); font-weight: 600; }
.create-app-preview > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.create-app-actions { display: flex; align-items: center; gap: var(--space-3); }
.create-app-note { flex: 1; color: var(--muted); font-size: var(--text-xs); line-height: 1.4; }
@media (pointer: coarse) { .create-app-template { min-height: 44px; } .create-app-colour { width: 44px; height: 44px; } }
@container (max-width: 480px) { .create-app-template-grid { grid-template-columns: 1fr; } }
@media (max-width: 640px) { .create-app-actions { flex-direction: column; align-items: stretch; } }
</style>
