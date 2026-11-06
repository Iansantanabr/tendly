<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import CopyButton from "../CopyButton.vue";
import ModalDialog from "../ModalDialog.vue";
import { MarkdownContent } from "../MarkdownContent";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import {
  filterSkills, groupBy, loadSkillContent, loadSkills, skillChatPrompt, skillOrigin, skillOrigins, sortSkills, stripFrontMatter,
  type Skill, type SkillContent,
} from "./catalog";
import { AccountChoiceRequired, startConversation } from "./start";

/** Skills the agents on this machine can load: read them, filter by folder, or start a chat that uses one. */
const props = defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ back: []; openFile: [workspaceId: string, path: string] }>();
const { t } = useI18n();

const skills = ref<Skill[]>();
const loading = ref(false);
const failure = ref("");
const query = ref("");
const origin = ref("");

async function load() {
  loading.value = true;
  failure.value = "";
  try { skills.value = await loadSkills(); }
  catch (error) { failure.value = errorMessage(error); }
  finally { loading.value = false; }
}
onMounted(load);

function workspaceName(skill: Skill) {
  return props.workspaces.find(w => w.id === skill.workspace_id)?.name ?? skill.workspace_name ?? "";
}
const origins = computed(() => skillOrigins(skills.value ?? [], workspaceName));
const visible = computed(() => filterSkills(skills.value ?? [], query.value, origin.value, workspaceName));
const groups = computed(() => groupBy(sortSkills(visible.value, workspaceName), skill => skillOrigin(skill, workspaceName)));
const filtered = computed(() => !!query.value.trim() || !!origin.value);
const subtitle = computed(() => skills.value ? t("{count} skills", { count: skills.value.length }) : undefined);

function open(skill: Skill) {
  if (skill.workspace_id && skill.rel_path) emit("openFile", skill.workspace_id, skill.rel_path);
}

// View: the SKILL.md, rendered, in a panel over the page.
const viewing = ref<Skill>();
const content = ref<SkillContent>();
const contentError = ref("");
async function view(skill: Skill) {
  viewing.value = skill;
  content.value = undefined;
  contentError.value = "";
  try {
    const loaded = await loadSkillContent(skill.id);
    if (viewing.value?.id === skill.id) content.value = loaded;
  } catch (cause) {
    if (viewing.value?.id === skill.id) contentError.value = errorMessage(cause);
  }
}
const body = computed(() => content.value ? stripFrontMatter(content.value.content) : "");

// Use in chat: an inline note, then a conversation that uses the skill.
const composing = ref<string>();
const note = ref("");
const starting = ref(false);
const chatError = ref("");
const noteInput = ref<HTMLInputElement[]>();
function compose(skill: Skill) {
  composing.value = skill.id;
  note.value = "";
  chatError.value = "";
  void nextTick(() => noteInput.value?.[0]?.focus());
}
function cancelCompose() { composing.value = undefined; chatError.value = ""; }
async function useInChat(skill: Skill) {
  if (starting.value) return;
  starting.value = true;
  chatError.value = "";
  try {
    await startConversation({
      prompt: skillChatPrompt(skill, note.value, t),
      workspaceId: skill.source === "workspace" ? skill.workspace_id : null,
    });
    composing.value = undefined;
    note.value = "";
  } catch (cause) {
    chatError.value = cause instanceof AccountChoiceRequired ? t(cause.message) : errorMessage(cause);
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <PageShell :title="t('Skills')" :subtitle="subtitle" @back="emit('back')">
    <div class="catalog-page">
      <div class="catalog-filters">
        <label class="catalog-search">
          <Icon name="search" :size="14" />
          <input v-model="query" type="search" :placeholder="t('Search skills')" :aria-label="t('Search skills')">
        </label>
        <label class="catalog-folder">
          <span>{{ t('Folder') }}</span>
          <select v-model="origin" :aria-label="t('Show skills from')">
            <option value="">{{ t('All folders') }}</option>
            <option v-for="entry in origins" :key="entry.key" :value="entry.key">{{ t(entry.label, entry.values) }} ({{ entry.count }})</option>
          </select>
        </label>
      </div>
      <p v-if="skills && filtered" class="catalog-count" role="status">{{ t('{visible} of {count} skills shown', { visible: visible.length, count: skills.length }) }}</p>
      <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
      <p v-if="!skills && loading" class="catalog-muted">{{ t('Looking for skills…') }}</p>
      <p v-else-if="skills && !skills.length" class="catalog-muted">{{ t('No skills found on this computer.') }}</p>
      <p v-else-if="skills && !visible.length" class="catalog-muted">{{ t('No skill matches this search.') }}</p>

      <section v-for="group in groups" :key="group.key" class="catalog-group">
        <h2>{{ t(group.label, group.values) }} <small>{{ group.items.length }}</small></h2>
        <ul class="catalog-list">
          <li v-for="skill in group.items" :key="skill.id" class="catalog-row">
            <div class="catalog-line">
              <Icon name="sparkles" :size="16" class="catalog-icon" />
              <div class="catalog-text">
                <strong>{{ skill.name }}</strong>
                <span v-if="skill.description" class="catalog-description" :title="skill.description">{{ skill.description }}</span>
                <span v-if="skill.source !== 'workspace'" class="catalog-path">
                  <span :title="skill.path">{{ skill.path }}</span>
                  <CopyButton :text="skill.path" label="Copy path" compact />
                </span>
              </div>
              <div class="catalog-actions">
                <button type="button" class="small-button" :aria-label="t('View {name}', { name: skill.name })" @click="view(skill)">{{ t('View') }}</button>
                <button v-if="skill.source === 'workspace' && skill.rel_path" type="button" class="small-button" @click="open(skill)">{{ t('Open on the canvas') }}</button>
                <button type="button" class="small-button primary" :aria-expanded="composing === skill.id" :aria-label="t('Use {name} in chat', { name: skill.name })" @click="composing === skill.id ? cancelCompose() : compose(skill)"><Icon name="chat" :size="13" />{{ t('Use in chat') }}</button>
              </div>
            </div>
            <form v-if="composing === skill.id" class="catalog-compose" @submit.prevent="useInChat(skill)" @keydown.esc.prevent.stop="cancelCompose">
              <input
                ref="noteInput" v-model="note" type="text" maxlength="2000"
                :aria-label="t('What should the agent do with {name}? (optional)', { name: skill.name })"
                :placeholder="t('What should it do? (optional)')"
              >
              <button type="submit" class="small-button primary" :disabled="starting"><Icon name="arrowUp" :size="13" />{{ t(starting ? 'Starting…' : 'Start chat') }}</button>
              <button type="button" class="small-button" @click="cancelCompose">{{ t('Cancel') }}</button>
              <span class="catalog-compose-hint">{{ skill.source === 'workspace' ? t('Starts in the project {name}.', { name: workspaceName(skill) }) : t('Starts as a conversation without a project.') }}</span>
              <p v-if="chatError" class="inline-error" role="alert">{{ chatError }}</p>
            </form>
          </li>
        </ul>
      </section>
    </div>

    <ModalDialog v-if="viewing" wide :title="viewing.name" @close="viewing = undefined">
      <div class="skill-view">
        <p class="skill-view-path"><span :title="viewing.path">{{ viewing.path }}</span><CopyButton :text="viewing.path" label="Copy path" compact /></p>
        <p v-if="viewing.description" class="skill-view-description">{{ viewing.description }}</p>
        <p v-if="contentError" class="inline-error" role="alert">{{ contentError }}</p>
        <p v-else-if="!content" class="catalog-muted">{{ t('Loading…') }}</p>
        <template v-else>
          <p v-if="content.truncated" class="inline-notice">{{ t('This file is long; only its first 256 KB is shown.') }}</p>
          <div class="markdown-preview skill-view-body" tabindex="0" :aria-label="t('Content of {name}', { name: viewing.name })"><MarkdownContent :text="body" /></div>
        </template>
        <div class="skill-view-actions">
          <button v-if="viewing.source === 'workspace' && viewing.rel_path" type="button" class="small-button" @click="open(viewing); viewing = undefined">{{ t('Open on the canvas') }}</button>
          <button type="button" class="small-button primary" @click="compose(viewing); viewing = undefined"><Icon name="chat" :size="13" />{{ t('Use in chat') }}</button>
        </div>
      </div>
    </ModalDialog>
  </PageShell>
</template>

<style scoped>
.catalog-page { max-width: 820px; display: grid; gap: 14px; }
.catalog-page > .inline-error { margin: 0; }
.catalog-muted { color: var(--muted); }
.catalog-filters { display: flex; flex-wrap: wrap; gap: 10px; }
.catalog-search { flex: 1 1 16rem; display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 36px; border: 1px solid var(--line-input); border-radius: var(--radius-md); background: var(--surface); color: var(--muted); }
.catalog-search:focus-within { border-color: var(--accent); }
.catalog-search:has(input:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.catalog-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font: inherit; font-size: var(--input-text); color: var(--ink); }
.catalog-folder { flex: 0 1 18rem; display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: var(--text-sm); }
.catalog-folder select { flex: 1; min-width: 0; min-height: 36px; padding: 0 10px; border: 1px solid var(--line-input); border-radius: var(--radius-md); background: var(--surface); color: var(--ink); font: inherit; font-size: var(--input-text); }
.catalog-count { margin: -6px 0 0; color: var(--muted); font-size: var(--text-xs); }
.catalog-group { display: grid; gap: 6px; }
.catalog-group h2 { margin: 6px 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.catalog-group h2 small { color: var(--faint); font-weight: 500; }
.catalog-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.catalog-row { display: grid; gap: 8px; padding: 10px 14px; min-width: 0; }
.catalog-row + .catalog-row { border-top: 1px solid var(--line); }
.catalog-line { display: flex; align-items: flex-start; gap: 12px; min-width: 0; }
.catalog-icon { flex: none; margin-top: 2px; color: var(--muted); }
.catalog-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.catalog-text strong { color: var(--ink); font-family: var(--mono); font-size: var(--text-sm); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-description { color: var(--muted); font-size: var(--text-sm); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.catalog-path { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); }
.catalog-path > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-actions { flex: none; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.catalog-compose { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-left: 28px; }
.catalog-compose input { flex: 1 1 16rem; min-width: 0; min-height: 32px; padding: 0 10px; border: 1px solid var(--line-input); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); font: inherit; font-size: var(--input-text); }
.catalog-compose input:focus { border-color: var(--accent); }
.catalog-compose-hint { flex-basis: 100%; color: var(--muted); font-size: var(--text-xs); }
.catalog-compose .inline-error { flex-basis: 100%; margin: 0; }
.skill-view { display: grid; gap: 10px; min-width: 0; }
.skill-view-path { display: flex; align-items: center; gap: 4px; margin: 0; min-width: 0; color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); }
.skill-view-path > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-view-description { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.skill-view .inline-error, .skill-view .inline-notice { margin: 0; }
.skill-view-body { max-height: min(62vh, 640px); padding: 18px 22px 28px; border: 1px solid var(--line); border-radius: var(--radius-md); }
.skill-view-actions { display: flex; justify-content: flex-end; gap: 6px; }
@media (max-width: 640px) {
  .catalog-line { flex-wrap: wrap; }
  .catalog-actions { flex-basis: 100%; justify-content: flex-start; margin-left: 28px; }
  .catalog-folder { flex-basis: 100%; }
}
</style>
