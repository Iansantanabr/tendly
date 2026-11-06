<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import type { EndpointProfile, ProviderKind, Session, Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import ProviderIcon from "../ProviderIcon.vue";
import { errorMessage, json, request } from "../api";
import { providerLabel } from "../clients";
import { PROFILE_CHOICE_REQUIRED, preferredProfileSelection } from "../profile-preferences";
import { loadPreferences, preferenceFor } from "../preferences";
import { useI18n } from "../../i18n";
import { inbox, loadConversationsWorkspace } from "./inbox";
import {
  CRON_PRESETS, automationRuns, createAutomation, deleteAutomation, duration, editPrompt, lastResult, listAutomations,
  presetLabel, runAutomation, updateAutomation, type Automation, type AutomationDraft, type AutomationKind, type AutomationRun,
} from "./automations";
import { hubTimezone, loadHubSettings } from "./settings";

/** Scheduled scripts and agent routines: what runs when, and how it went. */
const props = defineProps<{ workspaces: Workspace[]; sessions: Session[]; profiles: EndpointProfile[] }>();
const emit = defineEmits<{ back: []; openSession: [session: Session]; started: [sessionId: string] }>();
const { t } = useI18n();

const automations = ref<Automation[]>([]);
const loaded = ref(false), loadError = ref("");
const busy = reactive<Record<string, string>>({});
const errors = reactive<Record<string, string>>({});
const logs = reactive<Record<string, AutomationRun[] | undefined>>({});
const openLog = ref<string>();
const openOutput = ref<number>();
const now = ref(Date.now());

const projects = computed(() => props.workspaces.filter(w => w.id !== inbox.conversationsWorkspaceId));
const workspaceName = (id: string | null) => !id || id === inbox.conversationsWorkspaceId ? t("No project") : props.workspaces.find(w => w.id === id)?.name ?? t("Missing workspace");
const sessionOf = (id: string | null) => id ? props.sessions.find(s => s.id === id) : undefined;
const nextLabel = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const runTime = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const statusLabel = (status: AutomationRun["status"]) => t(status === "ok" ? "Succeeded" : status === "timeout" ? "Timed out" : status === "running" ? "Running" : "Failed");

let poll: ReturnType<typeof setInterval> | undefined, soon: ReturnType<typeof setTimeout> | undefined;
async function refresh() {
  try {
    automations.value = await listAutomations();
    loadError.value = "";
    now.value = Date.now();
    if (openLog.value) void loadLog(openLog.value);
  } catch (cause) { loadError.value = errorMessage(cause); }
  finally { loaded.value = true; }
  // Something running: look again shortly rather than in 30 s.
  clearTimeout(soon);
  if (automations.value.some(a => a.running || a.last_run?.status === "running")) soon = setTimeout(refresh, 3000);
}
onMounted(() => { void loadHubSettings(); void loadConversationsWorkspace(); void refresh(); poll = setInterval(refresh, 30_000); });
onBeforeUnmount(() => { clearInterval(poll); clearTimeout(soon); });

async function act(id: string, label: string, work: () => Promise<unknown>) {
  if (busy[id]) return;
  busy[id] = label; delete errors[id];
  try { await work(); }
  catch (cause) { errors[id] = errorMessage(cause); }
  finally { delete busy[id]; }
}

const toggle = (a: Automation, enabled: boolean) => act(a.id, "toggle", async () => {
  const updated = await updateAutomation(a.id, { enabled });
  automations.value = automations.value.map(item => item.id === a.id ? updated : item);
});
const runNow = (a: Automation) => act(a.id, "run", async () => {
  const run = await runAutomation(a.id);
  // Stay here, with the log open on this run.
  openLog.value = a.id; openOutput.value = run.id;
  await refresh();
});
const remove = (a: Automation) => act(a.id, "delete", async () => {
  if (!window.confirm(t("Delete the automation “{name}” and its log?", { name: a.name }))) return;
  await deleteAutomation(a.id);
  automations.value = automations.value.filter(item => item.id !== a.id);
});

async function loadLog(id: string) {
  try { logs[id] = await automationRuns(id, 20); }
  catch (cause) { errors[id] = errorMessage(cause); }
}
function toggleLog(a: Automation) {
  openOutput.value = undefined;
  if (openLog.value === a.id) { openLog.value = undefined; return; }
  openLog.value = a.id;
  void loadLog(a.id);
}

/** The account "New session" would use for this agent; "" for the default. */
async function endpointFor(provider: ProviderKind): Promise<string | null> {
  await loadPreferences();
  const chosen = preferredProfileSelection(provider, props.profiles, undefined, preferenceFor(provider)?.endpoint_profile_id);
  if (chosen === PROFILE_CHOICE_REQUIRED) throw new Error(t("This host has several accounts and none is the default. Choose one in Settings → Preferences, then send again."));
  return chosen || null;
}

const editWithChat = (a: Automation) => act(a.id, "chat", async () => {
  const provider: ProviderKind = a.provider === "codex" ? "codex" : "claude_code";
  const workspace = a.workspace_id && props.workspaces.some(w => w.id === a.workspace_id) ? a.workspace_id : await loadConversationsWorkspace();
  if (!workspace) throw new Error(t("Add a workspace first: it is the folder the agent works in."));
  const result = await request<{ started: { id: string } }>("/hub/start", json("POST", {
    workspace_id: workspace, provider, prompt: editPrompt(a, t), endpoint_id: await endpointFor(provider),
  }));
  emit("started", result.started.id);
});

// The form, for a new automation or a change by hand.
const editing = ref<string | "new">();
const formError = ref(""), saving = ref(false);
const blank = (): AutomationDraft => ({ name: "", description: "", kind: "script", cron: "0 9 * * *", workspace_id: null, command: "", prompt: "", provider: "claude_code" });
const form = reactive<AutomationDraft>(blank());
const preset = computed({
  get: () => CRON_PRESETS.some(p => p.cron === form.cron.trim()) ? form.cron.trim() : "custom",
  set: value => { if (value !== "custom") form.cron = value; },
});
function startNew() { Object.assign(form, blank()); formError.value = ""; editing.value = "new"; }
function startEdit(a: Automation) {
  Object.assign(form, { name: a.name, description: a.description, kind: a.kind, cron: a.cron, workspace_id: a.workspace_id, command: a.command ?? "", prompt: a.prompt ?? "", provider: a.provider ?? "claude_code" });
  formError.value = ""; editing.value = a.id;
}
function setKind(kind: AutomationKind) { form.kind = kind; }
async function save() {
  if (saving.value) return;
  saving.value = true; formError.value = "";
  try {
    const draft: AutomationDraft = { ...form, workspace_id: form.workspace_id === inbox.conversationsWorkspaceId ? null : form.workspace_id };
    if (draft.kind === "agent" && editing.value === "new") draft.endpoint_id = await endpointFor(draft.provider === "codex" ? "codex" : "claude_code");
    if (editing.value === "new") await createAutomation(draft);
    else if (editing.value) await updateAutomation(editing.value, draft);
    editing.value = undefined;
    await refresh();
  } catch (cause) { formError.value = errorMessage(cause); }
  finally { saving.value = false; }
}
</script>

<template>
  <PageShell :title="t('Automations')" :subtitle="t('Scripts and agent routines that run on a schedule on this machine.')" @back="emit('back')">
    <template #actions>
      <button type="button" class="primary-button" :disabled="editing === 'new'" @click="startNew"><Icon name="plus" :size="14" />{{ t('New automation') }}</button>
    </template>
    <div class="auto-page">
      <form v-if="editing" class="auto-form" @submit.prevent="save">
        <h2>{{ editing === 'new' ? t('New automation') : t('Edit automation') }}</h2>
        <div class="auto-kinds" role="radiogroup" :aria-label="t('Kind')">
          <button type="button" role="radio" :aria-checked="form.kind === 'script'" :class="['auto-kind', { on: form.kind === 'script' }]" @click="setKind('script')">
            <Icon name="terminal" :size="16" /><span><strong>{{ t('Script') }}</strong><small>{{ t('Runs a shell command') }}</small></span>
          </button>
          <button type="button" role="radio" :aria-checked="form.kind === 'agent'" :class="['auto-kind', { on: form.kind === 'agent' }]" @click="setKind('agent')">
            <Icon name="sparkles" :size="16" /><span><strong>{{ t('Agent') }}</strong><small>{{ t('Starts a conversation with a prompt') }}</small></span>
          </button>
        </div>
        <label class="auto-field"><span>{{ t('Name') }}</span><input v-model="form.name" type="text" maxlength="120" required :placeholder="t('Nightly backup')" /></label>
        <label class="auto-field"><span>{{ t('Description') }}</span><input v-model="form.description" type="text" maxlength="2000" :placeholder="t('Optional')" /></label>
        <div class="auto-row">
          <label class="auto-field"><span>{{ t('Schedule') }}</span>
            <select v-model="preset">
              <option v-for="p in CRON_PRESETS" :key="p.cron" :value="p.cron">{{ t(p.label) }}</option>
              <option value="custom">{{ t('Custom (cron)') }}</option>
            </select>
          </label>
          <label class="auto-field"><span>{{ t('Cron') }}</span><input v-model="form.cron" class="mono" type="text" required spellcheck="false" placeholder="0 9 * * 1-5" /></label>
        </div>
        <p class="auto-hint">{{ t('Five fields: minute, hour, day of month, month, day of week. In the time zone {zone}, set in Settings → Addresses and time zone.', { zone: hubTimezone }) }}</p>
        <label class="auto-field"><span>{{ t('Runs in') }}</span>
          <select v-model="form.workspace_id">
            <option :value="null">{{ t('No project') }}</option>
            <option v-for="w in projects" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </label>
        <template v-if="form.kind === 'script'">
          <label class="auto-field"><span>{{ t('Command') }}</span><textarea v-model="form.command" class="mono" rows="4" spellcheck="false" required placeholder="git pull && npm test" /></label>
          <p class="auto-hint">{{ t('Runs with your login shell in the project folder (your home folder without a project), and stops after 10 minutes.') }}</p>
        </template>
        <template v-else>
          <label class="auto-field"><span>{{ t('Agent') }}</span>
            <select v-model="form.provider">
              <option value="claude_code">{{ providerLabel('claude_code') }}</option>
              <option value="codex">{{ providerLabel('codex') }}</option>
            </select>
          </label>
          <label class="auto-field"><span>{{ t('Prompt') }}</span><textarea v-model="form.prompt" rows="4" required :placeholder="t('Summarize what changed in this workspace today')" /></label>
        </template>
        <p v-if="formError" class="inline-error" role="alert">{{ formError }}</p>
        <div class="auto-form-actions">
          <button type="button" class="secondary-button" @click="editing = undefined">{{ t('Cancel') }}</button>
          <button type="submit" class="primary-button" :disabled="saving">{{ saving ? t('Saving…') : t('Save') }}</button>
        </div>
      </form>

      <p v-if="loadError" class="inline-error" role="alert">{{ loadError }}</p>
      <div v-if="loaded && !automations.length && !editing && !loadError" class="auto-empty">
        <Icon name="timer" :size="28" />
        <p>{{ t('No automations yet. Schedule a script or a routine for an agent, and its results show up here and in the bell.') }}</p>
        <button type="button" class="secondary-button" @click="startNew"><Icon name="plus" :size="14" />{{ t('New automation') }}</button>
      </div>

      <ul class="auto-list">
        <li v-for="a in automations" :key="a.id" :class="['auto-card', { off: !a.enabled }]">
          <div class="auto-main">
            <span :class="['auto-icon', a.kind]"><Icon :name="a.kind === 'agent' ? 'sparkles' : 'terminal'" :size="16" /></span>
            <div class="auto-text">
              <strong>{{ a.name }}</strong>
              <span v-if="a.description" class="auto-description">{{ a.description }}</span>
              <span class="auto-meta">
                <span><Icon name="timer" :size="12" /> {{ presetLabel(a.cron) ? t(presetLabel(a.cron)!) : '' }} <code>{{ a.cron }}</code></span>
                <span v-if="a.enabled && a.next_run">{{ t('next: {time}', { time: nextLabel(a.next_run) }) }}</span>
                <span v-else-if="!a.enabled">{{ t('Paused') }}</span>
                <span><template v-if="a.kind === 'agent' && a.provider"><ProviderIcon :provider="a.provider" :size="12" /> </template><Icon v-else name="folder" :size="12" /> {{ workspaceName(a.workspace_id) }}</span>
              </span>
            </div>
            <span :class="['auto-result', lastResult(a, t, now).tone]">{{ lastResult(a, t, now).text }}</span>
            <input type="checkbox" class="auto-switch" role="switch" :checked="a.enabled" :disabled="!!busy[a.id]" :aria-label="t('Enabled')" :title="a.enabled ? t('On') : t('Paused')" @change="toggle(a, ($event.target as HTMLInputElement).checked)" />
          </div>
          <div class="auto-actions">
            <button type="button" class="small-button" :disabled="!!busy[a.id] || a.running" @click="runNow(a)"><Icon name="play" :size="12" />{{ busy[a.id] === 'run' ? t('Starting…') : t('Run now') }}</button>
            <button type="button" :class="['small-button', { active: openLog === a.id }]" :aria-expanded="openLog === a.id" @click="toggleLog(a)"><Icon name="clock" :size="12" />{{ t('Log') }}</button>
            <button type="button" class="small-button" :disabled="!!busy[a.id]" @click="editWithChat(a)"><Icon name="chat" :size="12" />{{ t('Edit with chat') }}</button>
            <button type="button" class="small-button" @click="startEdit(a)"><Icon name="edit" :size="12" />{{ t('Edit') }}</button>
            <span class="flex-spacer" />
            <button type="button" class="link-button danger" :disabled="!!busy[a.id]" @click="remove(a)">{{ t('Delete') }}</button>
          </div>
          <p v-if="errors[a.id]" class="inline-error" role="alert">{{ errors[a.id] }}</p>
          <div v-if="openLog === a.id" class="auto-log">
            <p v-if="!logs[a.id]" class="auto-hint">{{ t('Loading…') }}</p>
            <p v-else-if="!logs[a.id]!.length" class="auto-hint">{{ t('It has not run yet.') }}</p>
            <ul v-else class="auto-runs">
              <li v-for="run in logs[a.id]" :key="run.id">
                <button type="button" class="auto-run" :aria-expanded="openOutput === run.id" @click="openOutput = openOutput === run.id ? undefined : run.id">
                  <i :class="['auto-dot', run.status]" />
                  <span class="auto-run-status">{{ statusLabel(run.status) }}</span>
                  <span>{{ runTime(run.started_at) }}</span>
                  <small>{{ run.trigger === 'manual' ? t('by hand') : t('on schedule') }}</small>
                  <small v-if="duration(run, t)">{{ duration(run, t) }}</small>
                  <small v-if="run.exit_code !== null">{{ t('exit {code}', { code: run.exit_code }) }}</small>
                  <span class="flex-spacer" />
                  <Icon name="chevron" :size="12" :class="['auto-chevron', { open: openOutput === run.id }]" />
                </button>
                <div v-if="openOutput === run.id" class="auto-output">
                  <button v-if="sessionOf(run.session_id)" type="button" class="secondary-button" @click="emit('openSession', sessionOf(run.session_id)!)"><Icon name="chat" :size="14" />{{ t('Open conversation') }}</button>
                  <p v-else-if="run.session_id" class="auto-hint">{{ t('The conversation is no longer available.') }}</p>
                  <pre v-if="run.output_tail">{{ run.output_tail }}</pre>
                  <p v-else-if="!run.session_id" class="auto-hint">{{ t('No output.') }}</p>
                </div>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </div>
  </PageShell>
</template>

<style scoped>
.auto-page { max-width: 900px; display: grid; gap: var(--space-3); }
.auto-form, .auto-card { background: var(--elevated); border: 1px solid var(--line); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); }
.auto-form { padding: var(--space-4); display: grid; gap: var(--space-3); }
.auto-form h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.auto-kinds { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.auto-kind { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) var(--space-3); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.auto-kind span { display: grid; }
.auto-kind small { color: var(--muted); font-size: var(--text-xs); }
.auto-kind:hover { border-color: var(--line-strong); }
.auto-kind.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.auto-row { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.auto-field { display: grid; gap: 4px; font-size: var(--text-sm); color: var(--muted); }
.auto-field input, .auto-field select, .auto-field textarea { font: inherit; font-size: var(--text-md); color: var(--ink); background: var(--surface); border: 1px solid var(--line-input); border-radius: var(--radius-sm); padding: 6px 10px; min-width: 0; }
.auto-field textarea { resize: vertical; }
.auto-field :is(input, select, textarea):focus { border-color: var(--accent); }
.mono, code, pre { font-family: var(--mono); }
.auto-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); }
.auto-form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
.auto-empty { display: grid; justify-items: center; gap: var(--space-2); padding: var(--space-6) var(--space-4); color: var(--muted); text-align: center; border: 1px dashed var(--line-strong); border-radius: var(--radius-lg); }
.auto-empty p { margin: 0; max-width: 460px; }
.auto-list { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
.auto-card { padding: var(--space-3) var(--space-4); display: grid; gap: var(--space-2); }
.auto-card.off .auto-main { opacity: .6; }
.auto-main { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
.auto-icon { width: 32px; height: 32px; flex: none; display: grid; place-items: center; border-radius: var(--radius-md); background: var(--fill); color: var(--ink); }
.auto-icon.agent { color: var(--accent); }
.auto-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.auto-text strong { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-description { color: var(--muted); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.auto-meta { display: flex; flex-wrap: wrap; gap: 4px var(--space-3); color: var(--faint); font-size: var(--text-xs); }
.auto-meta > span { display: inline-flex; align-items: center; gap: 4px; }
.auto-meta code { color: var(--muted); }
.auto-result { flex: none; padding: 2px 10px; border-radius: var(--radius-full); font-size: var(--text-xs); background: var(--fill); color: var(--muted); white-space: nowrap; }
.auto-result.ok { background: var(--ok-soft); color: var(--ok-ink); }
.auto-result.failed { background: var(--danger-soft); color: var(--danger-ink); }
.auto-result.running { background: var(--warn-soft); color: var(--warn-ink); }
.auto-switch { appearance: none; flex: none; position: relative; width: 38px; height: 22px; border-radius: var(--radius-full); background: var(--line-input); cursor: pointer; transition: background .15s; }
.auto-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); transition: transform .15s; }
.auto-switch:checked { background: var(--accent); }
.auto-switch:checked::after { transform: translateX(16px); }
.auto-switch:disabled { opacity: .6; cursor: default; }
.auto-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding-left: calc(32px + var(--space-3)); }
.small-button.active { border-color: var(--accent); }
.flex-spacer { flex: 1; }
.link-button { border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: var(--text-sm); padding: 4px 6px; border-radius: var(--radius-sm); }
.link-button.danger:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.auto-card .inline-error { margin: 0; }
.auto-log { margin-left: calc(32px + var(--space-3)); border-top: 1px solid var(--line); padding-top: var(--space-2); }
.auto-runs { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.auto-run { width: 100%; display: flex; align-items: center; gap: var(--space-2); padding: 6px 8px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--ink); font: inherit; font-size: var(--text-sm); text-align: left; cursor: pointer; }
.auto-run:hover { background: var(--fill-hover); }
.auto-run small { color: var(--muted); }
.auto-run-status { font-weight: 600; min-width: 80px; }
.auto-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--faint); }
.auto-dot.ok { background: var(--ok); }
.auto-dot.failed, .auto-dot.timeout { background: var(--danger); }
.auto-dot.running { background: var(--warn); }
.auto-chevron { opacity: .5; transition: transform .15s; }
.auto-chevron.open { transform: rotate(90deg); }
.auto-output { display: grid; gap: var(--space-2); justify-items: start; padding: 4px 8px var(--space-2) 24px; }
.auto-output pre { margin: 0; width: 100%; max-height: 360px; overflow: auto; padding: var(--space-2) var(--space-3); background: var(--sunken, var(--fill)); border: 1px solid var(--line); border-radius: var(--radius-sm); color: var(--ink); font-size: var(--text-xs); white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .auto-row, .auto-kinds { grid-template-columns: 1fr; }
  .auto-main { flex-wrap: wrap; }
  .auto-result { order: 3; }
  .auto-actions, .auto-log { padding-left: 0; margin-left: 0; }
}
</style>
