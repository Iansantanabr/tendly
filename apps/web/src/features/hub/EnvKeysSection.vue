<script setup lang="ts">
/** Variable names found in the `.env` files of each project. Names only:
 * the server never reads a value into its answer, so none can show here. */
import { computed, onMounted, ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { envKeyCount, loadEnvKeys, splitEnvNames, type EnvWorkspace } from "./catalog";

const props = defineProps<{ workspaces: Workspace[] }>();
const { t } = useI18n();

const found = ref<EnvWorkspace[]>();
const loading = ref(false);
const failure = ref("");

async function load() {
  loading.value = true;
  failure.value = "";
  try { found.value = await loadEnvKeys(); }
  catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
  finally { loading.value = false; }
}
onMounted(() => { void load(); });
defineExpose({ load });

const count = computed(() => envKeyCount(found.value ?? []));
const nameOf = (workspace: EnvWorkspace) =>
  props.workspaces.find(w => w.id === workspace.workspace_id)?.name ?? workspace.workspace_name;
</script>

<template>
  <section class="env-keys" aria-labelledby="env-keys-title">
    <h2 id="env-keys-title">{{ t('Keys found without a registration') }}<span v-if="count" class="env-count">{{ count }}</span></h2>
    <p class="env-hint">{{ t('Variables found in the .env files of your projects. Tendly reads only their names, never their values. A key that lives only in a file is lost with the file: keep a copy in a password manager.') }}</p>
    <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
    <p v-else-if="!found && loading" class="env-hint">{{ t('Looking for .env files…') }}</p>
    <p v-else-if="found && !found.length" class="env-hint">{{ t('No .env file with variables was found in your projects.') }}</p>
    <div v-for="workspace in found ?? []" :key="workspace.workspace_id" class="env-project">
      <h3>{{ t('From the project {name}', { name: nameOf(workspace) }) }}</h3>
      <ul class="env-files">
        <li v-for="file in workspace.files" :key="file.path" class="env-file">
          <Icon name="shield" :size="16" class="env-icon" />
          <div class="env-text">
            <code class="env-path">{{ file.path }}</code>
            <p v-if="splitEnvNames(file).keys.length" class="env-line">
              <span class="env-label">{{ t('Keys') }}</span>
              <code v-for="name in splitEnvNames(file).keys" :key="name" class="env-name key">{{ name }}</code>
            </p>
            <p v-if="splitEnvNames(file).others.length" class="env-line">
              <span class="env-label">{{ t('Other variables') }}</span>
              <code v-for="name in splitEnvNames(file).others" :key="name" class="env-name">{{ name }}</code>
            </p>
          </div>
        </li>
      </ul>
      <p v-if="workspace.truncated" class="env-hint">{{ t('This project has more .env files than are shown here.') }}</p>
    </div>
  </section>
</template>

<style scoped>
.env-keys { display: grid; gap: 6px; }
.env-keys h2 { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.env-count { padding: 0 7px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); font-weight: 600; }
.env-hint { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.env-keys > .inline-error { margin: 0; }
.env-project { display: grid; gap: 6px; }
.env-project h3 { margin: 6px 0 0; font-size: var(--text-xs); font-weight: 600; color: var(--muted); }
.env-files { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.env-file { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; min-width: 0; }
.env-file + .env-file { border-top: 1px solid var(--line); }
.env-icon { flex: none; margin-top: 2px; color: var(--muted); }
.env-text { flex: 1; min-width: 0; display: grid; gap: 4px; }
.env-path { color: var(--ink); font-family: var(--mono); font-size: var(--text-sm); font-weight: 600; overflow-wrap: anywhere; }
.env-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; margin: 0; }
.env-label { color: var(--muted); font-size: var(--text-xs); }
.env-name { padding: 0 6px; border-radius: var(--radius-sm); background: var(--fill); color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
.env-name.key { color: var(--ink); font-weight: 600; }
</style>
