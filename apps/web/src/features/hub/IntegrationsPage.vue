<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { shortAgo } from "./inbox";
import { CLAUDE_CONNECTORS_URL, authorizeInClaudeAi, groupBy, loadIntegrations, type Integration, type IntegrationList } from "./catalog";

/** MCP servers the agents on this machine can reach. Read only. */
const props = defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ back: [] }>();
const { t } = useI18n();

const list = ref<IntegrationList>();
const loading = ref(false);
const failure = ref("");
// Re-renders "checked X ago" as time passes.
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;

async function load(refresh = false) {
  loading.value = true;
  failure.value = "";
  try { list.value = await loadIntegrations(refresh); }
  catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
  finally { loading.value = false; now.value = Date.now(); }
}
onMounted(() => { void load(); clock = setInterval(() => { now.value = Date.now(); }, 30_000); });
onBeforeUnmount(() => clearInterval(clock));

const ORDER = ["claude_account", "claude_user", "claude_project", "workspace", "codex"];
function workspaceName(server: Integration) {
  return props.workspaces.find(w => w.id === server.workspace_id)?.name ?? server.workspace_name ?? server.workspace_id ?? "";
}
const groups = computed(() => {
  const servers = [...(list.value?.servers ?? [])].sort((a, b) =>
    ORDER.indexOf(a.source) - ORDER.indexOf(b.source)
    || Number(Boolean(a.plugin)) - Number(Boolean(b.plugin))
    || (a.plugin ?? "").localeCompare(b.plugin ?? "")
    || a.name.localeCompare(b.name));
  return groupBy(servers, server => {
    if (server.source === "claude_account") return { key: "account", label: "Your Claude account" };
    if (server.source === "claude_user") return { key: "user", label: "Installed by you" };
    if (server.source === "codex") return { key: "codex", label: "Codex" };
    const name = workspaceName(server);
    return { key: `workspace:${server.workspace_id}`, label: "From the project {name}", values: { name } };
  });
});

const checkedAgo = computed(() => {
  if (!list.value?.checked_at) return "";
  void now.value;
  const seconds = (Date.now() - new Date(list.value.checked_at).getTime()) / 1000;
  return seconds < 60 ? t("Checked just now") : t("Checked {time} ago", { time: shortAgo(list.value.checked_at, t) });
});

function statusLabel(server: Integration) {
  if (server.status === "connected") return t("Connected");
  if (server.status === "needs_auth") return t("Needs authorization");
  if (server.status === "failed") return t("Failed");
  return t(server.detail || "Not checked");
}
function transportLabel(server: Integration) {
  return server.transport === "unknown" ? "" : server.transport.toUpperCase();
}
</script>

<template>
  <PageShell :title="t('Integrations')" :subtitle="list ? t('{count} integrations', { count: list.servers.length }) : undefined" @back="emit('back')">
    <div class="catalog-page">
      <div class="catalog-actions">
        <small v-if="checkedAgo" class="catalog-muted">{{ checkedAgo }}</small>
        <button type="button" class="secondary-button" :disabled="loading" @click="load(true)">
          <Icon name="refresh" :size="14" :class="{ 'catalog-spin': loading }" />{{ loading ? t('Checking…') : t('Check again') }}
        </button>
      </div>
      <p v-if="failure" class="inline-error">{{ failure }}</p>
      <p v-for="(error, index) in list?.errors ?? []" :key="index" class="inline-notice">{{ t(error.message, { path: error.path ?? '' }) }}</p>
      <p v-if="!list && loading" class="catalog-muted">{{ t('Checking your integrations… This can take a few seconds.') }}</p>
      <p v-else-if="list && !list.servers.length" class="catalog-muted">{{ t('No integrations found on this computer.') }}</p>

      <section v-for="group in groups" :key="group.key" class="catalog-group">
        <h2>{{ t(group.label, group.values) }}</h2>
        <ul class="catalog-list">
          <li v-for="server in group.items" :key="`${server.source}:${server.plugin ?? ''}:${server.name}`" class="catalog-row">
            <Icon name="plug" :size="16" class="catalog-icon" />
            <div class="catalog-text">
              <div class="catalog-title">
                <strong>{{ server.name }}</strong>
                <span v-if="server.plugin" class="catalog-tag">{{ t('plugin {name}', { name: server.plugin }) }}</span>
              </div>
              <span v-if="server.target || transportLabel(server)" class="catalog-target" :title="server.target">
                <template v-if="transportLabel(server)">{{ transportLabel(server) }}</template><template v-if="transportLabel(server) && server.target"> · </template>{{ server.target }}
              </span>
              <span v-if="server.status === 'needs_auth'" class="catalog-hint">
                {{ t('Authorize it in claude.ai or run /mcp in Claude Code') }}
                <a v-if="authorizeInClaudeAi(server)" class="catalog-authorize" :href="CLAUDE_CONNECTORS_URL" target="_blank" rel="noopener" :aria-label="t('Authorize {name} in claude.ai (opens in a new tab)', { name: server.name })">{{ t('Authorize in claude.ai') }} <span aria-hidden="true">↗</span></a>
              </span>
              <span v-else-if="server.status === 'failed' && server.detail" class="catalog-failure">{{ server.detail }}</span>
            </div>
            <span :class="['catalog-pill', server.status]">{{ statusLabel(server) }}</span>
          </li>
        </ul>
      </section>
    </div>
  </PageShell>
</template>

<style scoped>
.catalog-page { max-width: 820px; display: grid; gap: 14px; }
.catalog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.catalog-actions .inline-error, .catalog-page > .inline-notice, .catalog-page > .inline-error { margin: 0; }
.catalog-muted { color: var(--muted); }
.catalog-spin { animation: catalog-spin 1s linear infinite; }
@keyframes catalog-spin { to { transform: rotate(360deg); } }
.catalog-group { display: grid; gap: 6px; }
.catalog-group h2 { margin: 6px 0 0; font-size: var(--text-sm); font-weight: 600; color: var(--muted); }
.catalog-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.catalog-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; min-width: 0; }
.catalog-row + .catalog-row { border-top: 1px solid var(--line); }
.catalog-icon { flex: none; margin-top: 2px; color: var(--muted); }
.catalog-text { flex: 1; min-width: 0; display: grid; gap: 2px; }
.catalog-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.catalog-title strong { color: var(--ink); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-tag { flex: none; padding: 0 6px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); }
.catalog-target { color: var(--faint); font-size: var(--text-xs); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.catalog-hint { color: var(--warn-ink); font-size: var(--text-xs); }
.catalog-authorize { margin-left: 6px; color: var(--accent); font-weight: 600; white-space: nowrap; text-decoration: underline; text-underline-offset: 2px; }
.catalog-authorize:hover { color: var(--accent-hover); }
.catalog-failure { color: var(--danger); font-size: var(--text-xs); overflow-wrap: anywhere; }
.catalog-pill { flex: none; padding: 2px 10px; border-radius: var(--radius-full); font-size: var(--text-xs); font-weight: 550; background: var(--fill); color: var(--muted); white-space: nowrap; }
.catalog-pill.connected { background: var(--ok-soft); color: var(--ok); }
.catalog-pill.needs_auth { background: var(--warn-soft); color: var(--warn-ink); box-shadow: inset 0 0 0 1px var(--warn); }
.catalog-pill.failed { background: var(--danger-soft); color: var(--danger); }
</style>
