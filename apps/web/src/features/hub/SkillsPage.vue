<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import CopyButton from "../CopyButton.vue";
import { useI18n } from "../../i18n";
import { groupBy, loadSkills, matchesSkill, type Skill } from "./catalog";

/** Skills the agents on this machine can load. Read only. */
const props = defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ back: []; openFile: [workspaceId: string, path: string] }>();
const { t } = useI18n();

const skills = ref<Skill[]>();
const loading = ref(false);
const failure = ref("");
const query = ref("");

async function load() {
  loading.value = true;
  failure.value = "";
  try { skills.value = await loadSkills(); }
  catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
  finally { loading.value = false; }
}
onMounted(load);

const ORDER = ["workspace", "claude_user", "claude_plugin", "codex"];
function workspaceName(skill: Skill) {
  return props.workspaces.find(w => w.id === skill.workspace_id)?.name ?? skill.workspace_name ?? "";
}
const visible = computed(() => (skills.value ?? []).filter(skill => matchesSkill(skill, query.value)));
const groups = computed(() => {
  const sorted = [...visible.value].sort((a, b) =>
    ORDER.indexOf(a.source) - ORDER.indexOf(b.source)
    || workspaceName(a).localeCompare(workspaceName(b))
    || (a.plugin ?? "").localeCompare(b.plugin ?? "")
    || a.name.localeCompare(b.name));
  return groupBy(sorted, skill => {
    if (skill.source === "workspace") return { key: `workspace:${skill.workspace_id}`, label: "From the project {name}", values: { name: workspaceName(skill) } };
    if (skill.source === "claude_plugin") return { key: `plugin:${skill.plugin}`, label: "Plugin {name}", values: { name: skill.plugin ?? "" } };
    if (skill.source === "codex") return { key: "codex", label: "Codex" };
    return { key: "user", label: "Installed by you" };
  });
});

function open(skill: Skill) {
  if (skill.workspace_id && skill.rel_path) emit("openFile", skill.workspace_id, skill.rel_path);
}
</script>

<template>
  <PageShell :title="t('Skills')" :subtitle="skills ? t('{count} skills', { count: skills.length }) : undefined" @back="emit('back')">
    <div class="catalog-page">
      <label class="catalog-search">
        <Icon name="search" :size="14" />
        <input v-model="query" type="search" :placeholder="t('Search skills')" :aria-label="t('Search skills')">
      </label>
      <p v-if="failure" class="inline-error">{{ failure }}</p>
      <p v-if="!skills && loading" class="catalog-muted">{{ t('Looking for skills…') }}</p>
      <p v-else-if="skills && !skills.length" class="catalog-muted">{{ t('No skills found on this computer.') }}</p>
      <p v-else-if="skills && !visible.length" class="catalog-muted">{{ t('No skill matches this search.') }}</p>

      <section v-for="group in groups" :key="group.key" class="catalog-group">
        <h2>{{ t(group.label, group.values) }} <small>{{ group.items.length }}</small></h2>
        <ul class="catalog-list">
          <li v-for="skill in group.items" :key="skill.path" class="catalog-row">
            <Icon name="sparkles" :size="16" class="catalog-icon" />
            <div class="catalog-text">
              <strong>{{ skill.name }}</strong>
              <span v-if="skill.description" class="catalog-description" :title="skill.description">{{ skill.description }}</span>
              <span v-if="skill.source !== 'workspace'" class="catalog-path">
                <span :title="skill.path">{{ skill.path }}</span>
                <CopyButton :text="skill.path" label="Copy path" compact />
              </span>
            </div>
            <button v-if="skill.source === 'workspace' && skill.rel_path" type="button" class="secondary-button catalog-open" @click="open(skill)">{{ t('Open on the canvas') }}</button>
          </li>
        </ul>
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.catalog-page { max-width: 820px; display: grid; gap: 14px; }
.catalog-page > .inline-error { margin: 0; }
.catalog-muted { color: var(--muted); }
.catalog-search { display: flex; align-items: center; gap: 8px; padding: 0 12px; min-height: 36px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); color: var(--muted); }
.catalog-search:focus-within { border-color: var(--line-strong); }
.catalog-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; font: inherit; color: var(--ink); }
.catalog-group { display: grid; gap: 6px; }
.catalog-group h2 { margin: 6px 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.catalog-group h2 small { color: var(--faint); font-weight: 500; }
.catalog-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.catalog-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; min-width: 0; }
.catalog-row + .catalog-row { border-top: 1px solid var(--line); }
.catalog-icon { flex: none; margin-top: 2px; color: var(--muted); }
.catalog-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.catalog-text strong { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-description { color: var(--muted); font-size: var(--text-sm); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; }
.catalog-path { display: flex; align-items: center; gap: 4px; min-width: 0; color: var(--faint); font-family: var(--mono); font-size: var(--text-xs); }
.catalog-path > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-open { flex: none; }
</style>
