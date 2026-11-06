<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { EndpointProfile, ProviderKind, Session, Workspace } from "@tendly/protocol";
import { PROFILE_CHOICE_REQUIRED, preferredProfileSelection } from "../profile-preferences";
import { loadPreferences, preferenceFor } from "../preferences";
import { errorMessage, json, request } from "../api";
import { providerLabel } from "../clients";
import Icon from "../Icon.vue";
import ProviderIcon from "../ProviderIcon.vue";
import { useI18n } from "../../i18n";
import { inbox, isUnread, loadConversationsWorkspace, shortAgo } from "./inbox";
import AppTile from "./AppTile.vue";
import { apps, refreshApps, type HubApp } from "./apps";

/**
 * Início: where a day starts. A box to ask for something new, what is running,
 * what changed lately and the latest conversations, each one click from the Mesa.
 */
const props = defineProps<{ workspaces: Workspace[]; sessions: Session[]; profiles: EndpointProfile[]; selectedWorkspaceId?: string }>();
const emit = defineEmits<{ openSession: [session: Session]; started: [id: string]; openFile: [workspaceId: string, path: string]; openCanvas: []; openApp: [app: HubApp]; apps: [] }>();
const { t } = useI18n();

const STORAGE = "tendly.hub.home";
const saved = (() => { try { return JSON.parse(localStorage.getItem(STORAGE) ?? "{}"); } catch { return {}; } })();
const prompt = ref("");
const provider = ref<ProviderKind>(saved.provider === "codex" ? "codex" : "claude_code");
const workspaceId = ref<string | undefined>(saved.workspace ?? props.selectedWorkspaceId);
const busy = ref(false), error = ref("");
const recent = ref<{ workspace_id: string; workspace_name: string; path: string; modified_at: string }[]>([]);

/** "No project" first, then the projects. */
const projects = computed(() => props.workspaces.filter(w => w.id !== inbox.conversationsWorkspaceId));
watch([() => props.workspaces, () => inbox.conversationsWorkspaceId], ([list]) => {
  if (!list.some(w => w.id === workspaceId.value)) workspaceId.value = inbox.conversationsWorkspaceId || props.selectedWorkspaceId || list[0]?.id;
}, { immediate: true });
watch([provider, workspaceId], () => { try { localStorage.setItem(STORAGE, JSON.stringify({ provider: provider.value, workspace: workspaceId.value })); } catch { /* Fine without it. */ } });

const greeting = computed(() => {
  const hour = new Date().getHours();
  return t(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
});
const live = (s: Session) => s.status === "running" || s.status === "starting" || s.status === "waiting";
const visible = computed(() => props.sessions.filter(s => !s.archived_at && s.provider !== "terminal"));
const running = computed(() => visible.value.filter(live));
const latest = computed(() => [...visible.value].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 6));
const workspaceName = (id: string) => id === inbox.conversationsWorkspaceId ? t("No project") : props.workspaces.find(w => w.id === id)?.name ?? "";
const subtitle = computed(() => running.value.length ? t("{count} agents working now.", { count: running.value.length }) : t("No agent working right now."));

async function loadRecent() {
  try { recent.value = (await request<{ files: typeof recent.value }>("/hub/recent-files?limit=6")).files; }
  catch { recent.value = []; }
}
onMounted(() => { void loadRecent(); void loadConversationsWorkspace(); void refreshApps(); });
const homeApps = computed(() => [...apps.list].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 8));

async function send() {
  const text = prompt.value.trim();
  if (!text || !workspaceId.value || busy.value) return;
  busy.value = true; error.value = "";
  try {
    // The same account and endpoint "New session" would use for this agent.
    await loadPreferences();
    const chosen = preferredProfileSelection(provider.value, props.profiles, undefined, preferenceFor(provider.value)?.endpoint_profile_id);
    if (chosen === PROFILE_CHOICE_REQUIRED) { error.value = t("This host has several accounts and none is the default. Choose one in Settings → Preferences, then send again."); return; }
    const endpoint = chosen || null;
    const result = await request<{ started: { id: string } }>("/hub/start", json("POST", { workspace_id: workspaceId.value, provider: provider.value, prompt: text, endpoint_id: endpoint }));
    prompt.value = "";
    emit("started", result.started.id);
  } catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = false; }
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
}
const suggestions = computed(() => [
  t("Summarize what changed in this workspace today"),
  t("Review the open files and list what is unfinished"),
  t("Create a simple dashboard app for our sales"),
]);
</script>

<template>
  <section class="home-page" tabindex="-1" :aria-label="t('Home')">
    <div class="home-inner">
      <header class="home-header">
        <h1>{{ greeting }}</h1>
        <p>{{ subtitle }}</p>
      </header>

      <form class="home-composer" @submit.prevent="send">
        <textarea v-model="prompt" rows="2" :placeholder="t('What do we do now?')" :aria-label="t('What do we do now?')" :disabled="busy" @keydown="keydown" />
        <div class="home-composer-bar">
          <label class="home-chip"><ProviderIcon :provider="provider" :size="14" />
            <select v-model="provider" :aria-label="t('Agent')">
              <option value="claude_code">{{ providerLabel('claude_code') }}</option>
              <option value="codex">{{ providerLabel('codex') }}</option>
            </select>
          </label>
          <label class="home-chip"><Icon name="folder" :size="14" />
            <select v-model="workspaceId" :aria-label="t('Workspace')">
              <option v-if="inbox.conversationsWorkspaceId" :value="inbox.conversationsWorkspaceId">{{ t('No project') }}</option>
              <option v-for="w in projects" :key="w.id" :value="w.id">{{ w.name }}</option>
            </select>
          </label>
          <span class="flex-spacer" />
          <button class="home-send" type="submit" :disabled="busy || !prompt.trim() || !workspaceId" :aria-label="t('Send')"><Icon name="arrowUp" :size="16" /></button>
        </div>
        <p v-if="!workspaces.length && !inbox.conversationsWorkspaceId" class="inline-notice">{{ t('Add a workspace first: it is the folder the agent works in.') }}</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      </form>

      <div class="home-suggestions">
        <button v-for="s in suggestions" :key="s" type="button" class="home-suggestion" @click="prompt = s"><Icon name="chat" :size="14" />{{ s }}</button>
      </div>

      <div class="home-cards">
        <article class="home-card">
          <header><h2>{{ t('Running now') }}</h2></header>
          <p v-if="!running.length" class="home-empty">{{ t('No agent working right now.') }}</p>
          <button v-for="s in running" :key="s.id" type="button" class="home-row" @click="emit('openSession', s)">
            <ProviderIcon :provider="s.provider" :size="14" /><span class="home-row-title">{{ s.title }}</span>
            <small :class="['home-state', s.status]">{{ s.status === 'waiting' ? t('Needs you') : t('Working') }}</small>
          </button>
        </article>

        <article class="home-card">
          <header><h2>{{ t('Files') }}</h2><button type="button" class="link-button" @click="emit('openCanvas')">{{ t('Open') }}</button></header>
          <p v-if="!recent.length" class="home-empty">{{ t('No recent changes.') }}</p>
          <button v-for="f in recent" :key="f.workspace_id + f.path" type="button" class="home-row" @click="emit('openFile', f.workspace_id, f.path)">
            <Icon name="file" :size="14" /><span class="home-row-title">{{ f.path.split('/').pop() }}</span>
            <small class="home-row-meta" :title="f.path">{{ f.path.includes('/') ? f.path.split('/').slice(-2, -1)[0] : f.workspace_name }}</small>
          </button>
        </article>

        <article class="home-card">
          <header><h2>{{ t('Apps') }}</h2><button type="button" class="link-button" @click="emit('apps')">+ {{ t('New') }}</button></header>
          <p v-if="!homeApps.length" class="home-empty">{{ t('No apps yet. Ask an agent to build one for you.') }}</p>
          <div v-else class="home-apps">
            <button v-for="app in homeApps" :key="app.workspace_id + app.slug" type="button" class="home-app" :title="app.description || app.name" @click="emit('openApp', app)">
              <AppTile :name="app.name" :letter="app.letter" :color="app.color" :size="36" /><span>{{ app.name }}</span>
            </button>
          </div>
        </article>

        <article class="home-card">
          <header><h2>{{ t('Your latest conversations') }}</h2></header>
          <p v-if="!latest.length" class="home-empty">{{ t('No conversations yet.') }}</p>
          <button v-for="s in latest" :key="s.id" type="button" :class="['home-row', { unread: isUnread(s.id) }]" @click="emit('openSession', s)">
            <i v-if="isUnread(s.id)" class="home-dot" :aria-label="t('Unread')" /><span class="home-row-title">{{ s.title }}</span>
            <small class="home-row-meta">{{ workspaceName(s.workspace_id) }} · {{ shortAgo(inbox.activity[s.id]?.last_turn_at ?? s.updated_at, t) }}</small>
          </button>
        </article>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-page { position: absolute; inset: 0; overflow: auto; background: var(--bg); z-index: 5; outline: none; }
.home-inner { max-width: 1080px; margin: 0 auto; padding: 48px 24px 64px; display: grid; gap: 20px; }
.home-header h1 { margin: 0; font-size: 2rem; letter-spacing: -0.02em; color: var(--ink); }
.home-header p { margin: 4px 0 0; color: var(--muted); }
.home-composer { background: var(--elevated); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 14px 16px 10px; display: grid; gap: 8px; box-shadow: 0 1px 3px rgb(0 0 0 / 6%); }
.home-composer textarea { border: 0; background: transparent; resize: none; font: inherit; font-size: 1.05rem; color: var(--ink); outline: none; min-height: 52px; }
.home-composer-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.home-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; color: var(--ink-soft, var(--ink)); }
.home-chip select { border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; }
.home-chip:hover { background: var(--fill-hover); }
.flex-spacer { flex: 1; }
.home-send { width: 36px; height: 36px; border-radius: var(--radius-md); border: 0; background: var(--ink); color: var(--surface); display: grid; place-items: center; cursor: pointer; }
.home-send:disabled { opacity: .35; cursor: default; }
.home-suggestions { display: flex; flex-wrap: wrap; gap: 8px; }
.home-suggestion { display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; border-radius: 999px; border: 1px solid var(--line); background: var(--elevated); color: var(--ink); font: inherit; cursor: pointer; }
.home-suggestion:hover { border-color: var(--accent); }
.home-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
.home-card { background: var(--elevated); border: 1px solid var(--line); border-radius: var(--radius-lg); padding: 14px 16px; display: grid; align-content: start; gap: 2px; min-height: 160px; }
.home-card header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.home-card h2 { margin: 0; font-size: 1rem; color: var(--ink); }
.link-button { border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; }
.home-empty { color: var(--muted); margin: 4px 0; }
.home-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border: 0; background: none; border-radius: var(--radius-sm); font: inherit; color: var(--ink); text-align: left; cursor: pointer; min-width: 0; }
.home-row:hover { background: var(--fill-hover); }
.home-row.unread .home-row-title { font-weight: 600; }
.home-row-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-row-meta { color: var(--muted); white-space: nowrap; max-width: 45%; overflow: hidden; text-overflow: ellipsis; }
.home-state { padding: 1px 8px; border-radius: 999px; background: var(--fill-hover); }
.home-state.waiting { background: var(--warn-soft); color: var(--warn-ink); }
.home-apps { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 6px; }
.home-app { display: grid; justify-items: center; gap: 6px; padding: 8px 4px; border: 0; border-radius: var(--radius-md); background: none; color: var(--ink); font: inherit; font-size: var(--text-xs); cursor: pointer; min-width: 0; }
.home-app > span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-app:hover { background: var(--fill-hover); }
.home-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
@media (max-width: 640px) { .home-inner { padding: 24px 16px 48px; } .home-header h1 { font-size: 1.6rem; } }
</style>
