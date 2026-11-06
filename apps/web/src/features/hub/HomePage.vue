<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import type { EndpointProfile, ProviderKind, Session, Workspace } from "@tendly/protocol";
import { PROFILE_CHOICE_REQUIRED, isProfileSelectionValid, preferredProfileSelection } from "../profile-preferences";
import { loadPreferences, preferenceFor } from "../preferences";
import { errorMessage, request } from "../api";
import { providerLabel } from "../clients";
import { effortLabel } from "../reasoning-effort";
import { PERMISSION_LABELS, PERMISSION_NOTES } from "../permission-modes";
import { accountFor, loadAccountQuotas } from "../balance-store";
import Icon from "../Icon.vue";
import ProviderIcon from "../ProviderIcon.vue";
import { useI18n } from "../../i18n";
import { inbox, isUnread, loadConversationsWorkspace, shortAgo } from "./inbox";
import { startConversation } from "./start";
import { continueTarget, effortOptions, keepOffered, modelOptions, permissionOptions, readHomeMemory, usageText, type AgentChoice } from "./home";
import AppTile from "./AppTile.vue";
import { apps, refreshApps, type HubApp } from "./apps";
import { arrangedApps } from "./app-order";
import { conversationChips, insertAt, parseConversationLink, pastedConversation, removeConversationChip, restoreConversationChips, takeConversationChips, withConversations } from "./conversation-link";
import { speechLang, useDictation } from "./dictation";
import DictationButton from "./DictationButton.vue";
import DictationStatus from "./DictationStatus.vue";
import ConversationChips from "./ConversationChips.vue";
import InstallHint from "./InstallHint.vue";

/**
 * Início: where a day starts. A box to ask for something new, what is running,
 * what changed lately and the latest conversations, each one click from the Mesa.
 */
const props = defineProps<{ workspaces: Workspace[]; sessions: Session[]; profiles: EndpointProfile[]; selectedWorkspaceId?: string }>();
const emit = defineEmits<{ openSession: [session: Session]; started: [id: string]; openFile: [workspaceId: string, path: string]; openCanvas: []; openApp: [app: HubApp]; apps: [] }>();
const { t, locale } = useI18n();

const STORAGE = "tendly.hub.home";
const saved = (() => { try { return readHomeMemory(localStorage.getItem(STORAGE)); } catch { return readHomeMemory(null); } })();
const prompt = ref("");
const provider = ref<ProviderKind>(saved.provider ?? "claude_code");
const workspaceId = ref<string | undefined>(saved.workspace ?? props.selectedWorkspaceId);
const busy = ref(false), error = ref("");
const recent = ref<{ workspace_id: string; workspace_name: string; path: string; modified_at: string }[]>([]);

/** "No project" first, then the projects. */
const projects = computed(() => props.workspaces.filter(w => w.id !== inbox.conversationsWorkspaceId));
watch([() => props.workspaces, () => inbox.conversationsWorkspaceId], ([list]) => {
  if (!list.some(w => w.id === workspaceId.value)) workspaceId.value = inbox.conversationsWorkspaceId || props.selectedWorkspaceId || list[0]?.id;
}, { immediate: true });

// Account, model, thinking depth and permission: what "New session" would
// start with (Preferences), unless a choice made here last time still applies.
const agents = ref<Partial<Record<ProviderKind, AgentChoice>>>({ ...saved.agents });
const endpoint = ref(""), model = ref(""), effort = ref(""), permission = ref("");
const preferencesReady = ref(false);
const accounts = computed(() => props.profiles.filter(p => p.provider === provider.value));
const profile = computed(() => accounts.value.find(p => p.id === endpoint.value));
const models = computed(() => modelOptions(profile.value));
const efforts = computed(() => effortOptions(provider.value, profile.value, model.value, effort.value));
const permissions = computed(() => permissionOptions(provider.value));
const accountUsage = (p: EndpointProfile) => usageText(accountFor(p.id), t);

/** Fills the four choices for the agent in use, from memory when still valid, else from Preferences. */
function restoreChoices() {
  const remembered = agents.value[provider.value] ?? {};
  const preference = preferenceFor(provider.value);
  const fallbackEndpoint = preferredProfileSelection(provider.value, props.profiles, undefined, preference?.endpoint_profile_id);
  endpoint.value = remembered.endpoint !== undefined && isProfileSelectionValid(provider.value, remembered.endpoint, props.profiles) ? remembered.endpoint : fallbackEndpoint;
  model.value = keepOffered(remembered.model, models.value.map(m => m.id), "");
  const defaultEffort = profile.value?.effort ?? preference?.effort ?? "";
  effort.value = keepOffered(remembered.effort, efforts.value, efforts.value.includes(defaultEffort) ? defaultEffort : "");
  const modes = permissions.value;
  permission.value = keepOffered(remembered.permission, modes, modes.includes(preference?.permission ?? "") ? preference!.permission! : "");
}
watch(provider, restoreChoices);
watch(() => props.profiles, () => { if (preferencesReady.value) restoreChoices(); });
// A model or account the new pick does not offer falls back to the default.
watch(endpoint, () => { if (model.value && !models.value.some(m => m.id === model.value)) model.value = ""; });
watch(efforts, list => { if (effort.value && !list.includes(effort.value)) effort.value = ""; });

watch([provider, workspaceId, endpoint, model, effort, permission], () => {
  if (!preferencesReady.value) return;
  if (endpoint.value !== PROFILE_CHOICE_REQUIRED) agents.value = { ...agents.value, [provider.value]: { endpoint: endpoint.value, model: model.value, effort: effort.value, permission: permission.value } };
  try { localStorage.setItem(STORAGE, JSON.stringify({ provider: provider.value, workspace: workspaceId.value, agents: agents.value })); } catch { /* Fine without it. */ }
});

const greeting = computed(() => {
  const hour = new Date().getHours();
  return t(hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening");
});
const live = (s: Session) => s.status === "running" || s.status === "starting" || s.status === "waiting";
const visible = computed(() => props.sessions.filter(s => !s.archived_at && s.provider !== "terminal"));
const running = computed(() => visible.value.filter(live));
const latest = computed(() => [...visible.value].sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 6));
const resume = computed(() => continueTarget(props.sessions, inbox.activity));
const workspaceName = (id: string) => id === inbox.conversationsWorkspaceId ? t("No project") : props.workspaces.find(w => w.id === id)?.name ?? "";
const subtitle = computed(() => running.value.length ? t("{count} agents working now.", { count: running.value.length }) : t("No agent working right now."));

async function loadRecent() {
  try { recent.value = (await request<{ files: typeof recent.value }>("/hub/recent-files?limit=6")).files; }
  catch { recent.value = []; }
}
onMounted(async () => {
  void loadRecent(); void loadConversationsWorkspace(); void refreshApps(); void loadAccountQuotas();
  try { await loadPreferences(); } catch { /* The defaults then come from the accounts alone. */ }
  restoreChoices();
  preferencesReady.value = true;
});
/** The first eight, in the order of the rail and the sidebar; hidden apps stay out. */
const homeApps = computed(() => arrangedApps.value.slice(0, 8));

/** The composer's key for conversation chips. */
const CHIPS = "home";
const linked = computed(() => conversationChips(CHIPS));
const input = ref<HTMLTextAreaElement>();
function insertIntoPrompt(text: string) {
  const el = input.value, value = prompt.value;
  const start = el?.selectionStart ?? value.length, end = el?.selectionEnd ?? start;
  const next = insertAt(value, start, end, text);
  prompt.value = next.value;
  void nextTick(() => input.value?.setSelectionRange(next.caret, next.caret));
}
/** A pasted Tendly conversation link becomes a chip instead of the raw URL. */
async function paste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (!parseConversationLink(text, location.origin)) return;
  event.preventDefault();
  const outcome = await pastedConversation(text, {
    origin: location.origin, key: CHIPS,
    lookup: async id => props.sessions.find(s => s.id === id)?.title ?? (await request<Session>(`/sessions/${id}`).then(s => s.title, () => undefined)),
  });
  if (outcome.kind === "unknown") insertIntoPrompt(text.trim());
}
const dictation = useDictation({ lang: () => speechLang(locale.value), onFinal: insertIntoPrompt });

async function send() {
  const text = prompt.value.trim();
  if (!text || !workspaceId.value || busy.value) return;
  if (endpoint.value === PROFILE_CHOICE_REQUIRED) { error.value = t("Choose an account for this conversation, then send again."); return; }
  busy.value = true; error.value = "";
  dictation.stop();
  const refs = takeConversationChips(CHIPS);
  try {
    const id = await startConversation({
      prompt: withConversations(text, refs),
      workspaceId: workspaceId.value,
      provider: provider.value,
      endpointId: endpoint.value || null,
      model: model.value || null,
      // "Automatic" is a choice too: it must not fall back to the preferred depth.
      effort: efforts.value.length ? effort.value || "auto" : null,
      permission: permission.value || null,
      open: false,
    });
    prompt.value = "";
    emit("started", id);
  } catch (cause) { restoreConversationChips(CHIPS, refs); error.value = errorMessage(cause); }
  finally { busy.value = false; }
}
function keydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
  else if (event.key === "Escape" && dictation.listening.value) { event.preventDefault(); dictation.stop(); }
  else if (event.key === "Escape") (event.target as HTMLElement).blur();
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
        <button v-if="resume" type="button" class="home-continue" @click="emit('openSession', resume)">
          <Icon name="chat" :size="14" /><span>{{ t('Continue “{title}”', { title: resume.title }) }}</span>
          <small>{{ shortAgo(inbox.activity[resume.id]?.last_turn_at ?? resume.updated_at, t) }}</small>
        </button>
      </header>

      <form class="home-composer" @submit.prevent="send">
        <textarea ref="input" v-model="prompt" rows="2" :placeholder="t('What do we do now?')" :aria-label="t('What do we do now?')" :disabled="busy" @keydown="keydown" @paste="paste" />
        <DictationStatus :dictation="dictation" />
        <ConversationChips :items="linked" @remove="id => removeConversationChip(CHIPS, id)" />
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
          <label class="home-chip" :title="t('Used in each quota window')"><Icon name="account" :size="14" />
            <select v-model="endpoint" :aria-label="t('Account')" :disabled="busy">
              <option v-if="endpoint === PROFILE_CHOICE_REQUIRED" :value="PROFILE_CHOICE_REQUIRED" disabled>{{ t('Choose a session configuration') }}</option>
              <option v-for="p in accounts" :key="p.id" :value="p.id">{{ p.name }}{{ accountUsage(p) ? ` · ${accountUsage(p)}` : '' }}</option>
              <option value="">{{ t('Isolated configuration · separate sign-in may be required') }}</option>
            </select>
          </label>
          <label v-if="models.length" class="home-chip"><Icon name="spark" :size="14" />
            <select v-model="model" :aria-label="t('Model')" :disabled="busy">
              <option value="">{{ profile?.model || t('Default model') }}</option>
              <option v-for="m in models" :key="m.id" :value="m.id">{{ m.name }}</option>
            </select>
          </label>
          <label v-if="efforts.length" class="home-chip"><Icon name="gauge" :size="14" />
            <select v-model="effort" :aria-label="t('Thinking depth')" :disabled="busy">
              <option value="">{{ t('Automatic · provider default') }}</option>
              <option v-for="level in efforts" :key="level" :value="level">{{ effortLabel(level) }}</option>
            </select>
          </label>
          <label v-if="permissions.length" :class="['home-chip', { danger: permission === 'danger' }]"><Icon name="shield" :size="14" />
            <select v-model="permission" :aria-label="t('How tools are approved')" :disabled="busy">
              <option value="">{{ t('Default approval') }}</option>
              <option v-for="mode in permissions" :key="mode" :value="mode">{{ t(PERMISSION_LABELS[mode] ?? mode) }}</option>
            </select>
          </label>
          <span class="flex-spacer" />
          <DictationButton :dictation="dictation" :disabled="busy" />
          <button class="home-send" type="submit" :disabled="busy || !prompt.trim() || !workspaceId" :aria-label="t('Send')"><Icon name="arrowUp" :size="16" /></button>
        </div>
        <p v-if="!workspaces.length && !inbox.conversationsWorkspaceId" class="inline-notice">{{ t('Add a workspace first: it is the folder the agent works in.') }}</p>
        <p v-if="permission === 'danger'" class="inline-notice">{{ t(PERMISSION_NOTES.danger) }}</p>
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
      </form>

      <InstallHint dismissible />

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
          <p v-if="!apps.list.length" class="home-empty">{{ t('No apps yet. Ask an agent to build one for you.') }}</p>
          <p v-else-if="!homeApps.length" class="home-empty">{{ t('Every app is hidden.') }} <button type="button" class="link-button" @click="emit('apps')">{{ t('See all apps') }}</button></p>
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
.home-continue { margin-top: 12px; display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 8px 14px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--elevated); color: var(--ink); font: inherit; cursor: pointer; box-shadow: var(--shadow-sm); }
.home-continue span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.home-continue small { color: var(--muted); white-space: nowrap; }
.home-continue:hover { background: var(--fill-hover); }
.home-composer { background: var(--elevated); border: 1px solid var(--line-input); border-radius: var(--radius-lg); padding: 14px 16px 10px; display: grid; gap: 8px; box-shadow: 0 1px 3px rgb(0 0 0 / 6%); }
.home-composer:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
.home-composer textarea { border: 0; background: transparent; resize: none; font: inherit; font-size: 1.05rem; color: var(--ink); outline: none; min-height: 52px; }
.home-composer-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.home-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; color: var(--ink-soft, var(--ink)); }
.home-chip select { border: 0; background: transparent; font: inherit; color: inherit; cursor: pointer; }
.home-chip:hover { background: var(--fill-hover); }
.home-chip:has(select:focus-visible) { outline: 2px solid var(--focus); outline-offset: 2px; }
.home-chip select { max-width: 220px; text-overflow: ellipsis; }
.home-chip.danger { color: var(--danger-ink); background: var(--danger-soft); }
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
@media (pointer: coarse) { .home-chip, .home-continue { min-height: 44px; } }
@media (max-width: 640px) { .home-inner { padding: 24px 16px 48px; } .home-header h1 { font-size: 1.6rem; } }
</style>
