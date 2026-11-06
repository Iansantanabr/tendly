<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import type { EndpointProfile, ProviderKind, Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import { ApiError, errorMessage, json, request, routedUrl } from "../api";
import { providerLabel } from "../clients";
import { PROFILE_CHOICE_REQUIRED, preferredProfileSelection } from "../profile-preferences";
import { loadPreferences, preferenceFor } from "../preferences";
import { useI18n } from "../../i18n";
import { inbox, loadConversationsWorkspace } from "./inbox";
import AppTile from "./AppTile.vue";
import { apps, colorFor, createPrompt, freeSlug, refreshApps, scaffoldApp, type HubApp } from "./apps";

/** Apps: small tools an agent builds in a project's `apps/` folder, opened on the Mesa. */
const props = defineProps<{ workspaces: Workspace[]; profiles: EndpointProfile[]; selectedWorkspaceId?: string }>();
const emit = defineEmits<{ back: []; started: [sessionId: string]; openApp: [app: HubApp] }>();
const { t } = useI18n();

const STORAGE = "tendly.hub.apps";
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE) ?? "{}"); } catch { return {}; } })();

/** Projects only: an app lives in a project's folder, not among the loose conversations. */
const projects = computed(() => props.workspaces.filter(w => w.id !== inbox.conversationsWorkspaceId));
const form = reactive({ name: "", description: "", workspaceId: (saved.workspace ?? props.selectedWorkspaceId) as string | undefined, provider: (saved.provider === "codex" ? "codex" : "claude_code") as ProviderKind });
const busy = ref<"" | "agent" | "blank">(""), formError = ref("");
watch([projects, () => props.selectedWorkspaceId], ([list]) => {
  if (!list.some(w => w.id === form.workspaceId)) form.workspaceId = list.find(w => w.id === props.selectedWorkspaceId)?.id ?? list[0]?.id;
}, { immediate: true });
watch(() => [form.provider, form.workspaceId], () => { try { localStorage.setItem(STORAGE, JSON.stringify({ provider: form.provider, workspace: form.workspaceId })); } catch { /* Fine without it. */ } });

const sorted = computed(() => [...apps.list].sort((a, b) => a.name.localeCompare(b.name)));
const workspaceName = (id: string) => props.workspaces.find(w => w.id === id)?.name ?? "";
const showWorkspace = computed(() => new Set(apps.list.map(app => app.workspace_id)).size > 1);

onMounted(() => { void loadConversationsWorkspace(); void refreshApps(); });

/** The account "New session" would use for this agent; null for the default. */
async function endpointFor(provider: ProviderKind): Promise<string | null> {
  await loadPreferences();
  const chosen = preferredProfileSelection(provider, props.profiles, undefined, preferenceFor(provider)?.endpoint_profile_id);
  if (chosen === PROFILE_CHOICE_REQUIRED) throw new Error(t("This host has several accounts and none is the default. Choose one in Settings → Preferences, then send again."));
  return chosen || null;
}

async function createWithAgent() {
  const name = form.name.trim(), workspaceId = form.workspaceId;
  if (!name || !workspaceId || busy.value) return;
  busy.value = "agent"; formError.value = "";
  try {
    await refreshApps();
    const slug = freeSlug(name, workspaceId);
    const result = await request<{ started: { id: string } }>("/hub/start", json("POST", {
      workspace_id: workspaceId, provider: form.provider, prompt: createPrompt({ name, description: form.description, slug }), endpoint_id: await endpointFor(form.provider),
    }));
    form.name = ""; form.description = "";
    emit("started", result.started.id);
  } catch (cause) { formError.value = errorMessage(cause); }
  finally { busy.value = ""; }
}

async function createBlank() {
  const name = form.name.trim(), workspaceId = form.workspaceId;
  if (!name || !workspaceId || busy.value) return;
  busy.value = "blank"; formError.value = "";
  try {
    await refreshApps();
    const app = await scaffoldApp(workspaceId, { slug: freeSlug(name, workspaceId), name, description: form.description.trim() || undefined, color: colorFor(name) });
    form.name = ""; form.description = "";
    emit("openApp", app);
  } catch (cause) {
    formError.value = cause instanceof ApiError && cause.status === 409 ? t("There is already an app in that folder. Choose another name.") : errorMessage(cause);
  } finally { busy.value = ""; }
}
function openTab(app: HubApp) { window.open(routedUrl(app.url), "_blank", "noopener"); }
</script>

<template>
  <PageShell :title="t('Apps')" :subtitle="t('Small tools an agent builds for you inside a project, opened on the Mesa.')" @back="emit('back')">
    <template #actions>
      <button type="button" class="secondary-button" :disabled="apps.loading" @click="refreshApps()"><Icon name="refresh" :size="14" />{{ t('Refresh') }}</button>
    </template>
    <div class="apps-page">
      <div v-if="apps.errors.length" class="apps-notice" role="status">
        <Icon name="info" :size="15" />
        <div><strong>{{ t('Some apps could not be read') }}</strong>
          <ul><li v-for="error in apps.errors" :key="error.workspace_id + error.slug"><code>apps/{{ error.slug }}/</code> · {{ workspaceName(error.workspace_id) }}: {{ error.message }}</li></ul>
        </div>
      </div>
      <p v-if="apps.error" class="inline-error" role="alert">{{ apps.error }}</p>

      <div class="apps-grid">
        <form class="apps-card apps-create" @submit.prevent="createWithAgent">
          <header><span class="apps-create-icon"><Icon name="sparkles" :size="16" /></span><h2>{{ t('Create with the agent') }}</h2></header>
          <label class="apps-field"><span>{{ t('Name') }}</span><input v-model="form.name" type="text" maxlength="60" required :placeholder="t('Sales pipeline')" /></label>
          <label class="apps-field"><span>{{ t('What should it do?') }}</span><textarea v-model="form.description" rows="3" maxlength="4000" :placeholder="t('A board with my deals by stage, where I can add and move them.')" /></label>
          <div class="apps-row">
            <label class="apps-field"><span>{{ t('Project') }}</span>
              <select v-model="form.workspaceId" :disabled="!projects.length"><option v-for="w in projects" :key="w.id" :value="w.id">{{ w.name }}</option></select>
            </label>
            <label class="apps-field"><span>{{ t('Agent') }}</span>
              <select v-model="form.provider">
                <option value="claude_code">{{ providerLabel('claude_code') }}</option>
                <option value="codex">{{ providerLabel('codex') }}</option>
              </select>
            </label>
          </div>
          <p v-if="!projects.length" class="inline-notice">{{ t('Add a project first: an app lives in a project folder.') }}</p>
          <p v-if="formError" class="inline-error" role="alert">{{ formError }}</p>
          <div class="apps-create-actions">
            <button type="button" class="link-button" :disabled="!!busy || !form.name.trim() || !form.workspaceId" :title="t('Creates an empty app now, without an agent')" @click="createBlank">{{ busy === 'blank' ? t('Creating…') : t('Blank app') }}</button>
            <span class="flex-spacer" />
            <button type="submit" class="primary-button" :disabled="!!busy || !form.name.trim() || !form.workspaceId">{{ busy === 'agent' ? t('Starting…') : t('Create') }}</button>
          </div>
        </form>

        <article v-for="app in sorted" :key="app.workspace_id + app.slug" class="apps-card apps-app">
          <button type="button" class="apps-app-main" :title="t('Open on the Mesa')" @click="emit('openApp', app)">
            <AppTile :name="app.name" :letter="app.letter" :color="app.color" :size="40" />
            <span class="apps-app-text"><strong>{{ app.name }}</strong><small v-if="app.description">{{ app.description }}</small></span>
          </button>
          <footer>
            <small class="apps-app-meta" :title="app.code_path">{{ showWorkspace || projects.length > 1 ? app.workspace_name : app.code_path }}</small>
            <span class="flex-spacer" />
            <button type="button" class="icon-button" :aria-label="t('Open in new tab')" :title="t('Open in new tab')" @click="openTab(app)"><Icon name="arrow" :size="14" /></button>
            <button type="button" class="small-button" @click="emit('openApp', app)">{{ t('Open on the Mesa') }}</button>
          </footer>
        </article>
      </div>
      <p v-if="apps.loaded && !apps.list.length && !apps.error" class="apps-empty">{{ t('No apps yet. Describe one above and an agent builds it in the project you choose.') }}</p>
    </div>
  </PageShell>
</template>

<style scoped>
.apps-page { max-width: 1080px; display: grid; gap: var(--space-3); }
.apps-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--space-3); align-items: start; }
.apps-card { background: var(--elevated); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); min-width: 0; }
.apps-create { grid-column: 1 / -1; padding: var(--space-4); display: grid; gap: var(--space-3); max-width: 640px; }
.apps-create header { display: flex; align-items: center; gap: var(--space-2); }
.apps-create h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.apps-create-icon { display: grid; place-items: center; width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--accent-soft); color: var(--accent-ink); }
.apps-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.apps-field { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--muted); min-width: 0; }
.apps-field input, .apps-field select, .apps-field textarea { font: inherit; font-size: var(--text-md); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 10px; min-width: 0; }
.apps-field textarea { resize: vertical; }
.apps-field :is(input, select, textarea):focus { outline: none; border-color: var(--accent); }
.apps-create-actions { display: flex; align-items: center; gap: var(--space-2); }
.flex-spacer { flex: 1; }
.link-button { border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: var(--text-sm); padding: 4px 6px; border-radius: var(--radius-sm); }
.link-button:hover:not(:disabled) { color: var(--ink); background: var(--fill-hover); }
.link-button:disabled { opacity: .5; cursor: default; }
.apps-app { display: grid; }
.apps-app-main { display: flex; align-items: flex-start; gap: var(--space-3); padding: var(--space-3) var(--space-4); border: 0; background: none; text-align: left; font: inherit; color: var(--ink); cursor: pointer; border-radius: var(--radius-lg) var(--radius-lg) 0 0; min-width: 0; }
.apps-app-main:hover { background: var(--fill-hover); }
.apps-app-text { display: grid; gap: 2px; min-width: 0; }
.apps-app-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.apps-app-text small { color: var(--muted); font-size: var(--text-sm); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
.apps-app footer { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4); border-top: 1px solid var(--border); min-width: 0; }
.apps-app-meta { color: var(--faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.apps-notice { display: flex; gap: var(--space-2); align-items: flex-start; padding: var(--space-2) var(--space-3); border: 1px solid var(--warn-line); background: var(--warn-soft); color: var(--warn-ink); border-radius: var(--radius-md); font-size: var(--text-sm); }
.apps-notice ul { margin: 4px 0 0; padding-left: 18px; }
.apps-notice code { font-family: var(--mono); }
.apps-empty { margin: 0; color: var(--muted); }
@media (max-width: 640px) { .apps-row { grid-template-columns: 1fr; } .apps-grid { grid-template-columns: 1fr; } }
</style>
