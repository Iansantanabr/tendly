<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import PageShell from "../PageShell.vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { shortAgo } from "./inbox";
import EnvKeysSection from "./EnvKeysSection.vue";
import IntegrationRow from "./IntegrationRow.vue";
import { groupBy, loadIntegrations, splitByUse, type Integration, type IntegrationList } from "./catalog";

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
/** Servers by where they come from, in page order. */
function grouped(servers: Integration[]) {
  const sorted = [...servers].sort((a, b) =>
    ORDER.indexOf(a.source) - ORDER.indexOf(b.source)
    || Number(Boolean(a.plugin)) - Number(Boolean(b.plugin))
    || (a.plugin ?? "").localeCompare(b.plugin ?? "")
    || a.name.localeCompare(b.name));
  return groupBy(sorted, server => {
    if (server.source === "claude_account") return { key: "account", label: "Your Claude account" };
    if (server.source === "claude_user") return { key: "user", label: "Installed by you" };
    if (server.source === "codex") return { key: "codex", label: "Codex" };
    const name = workspaceName(server);
    return { key: `workspace:${server.workspace_id}`, label: "From the project {name}", values: { name } };
  });
}
const byUse = computed(() => splitByUse(list.value?.servers ?? []));
const groups = computed(() => grouped(byUse.value.inUse));
/** Turned off or never set up: listed apart, closed until asked for. */
const unusedGroups = computed(() => grouped(byUse.value.unused));
const rowKey = (server: Integration) => `${server.source}:${server.workspace_id ?? ""}:${server.plugin ?? ""}:${server.name}`;

const checkedAgo = computed(() => {
  if (!list.value?.checked_at) return "";
  void now.value;
  const seconds = (Date.now() - new Date(list.value.checked_at).getTime()) / 1000;
  return seconds < 60 ? t("Checked just now") : t("Checked {time} ago", { time: shortAgo(list.value.checked_at, t) });
});
</script>

<template>
  <PageShell :title="t('Integrations')" :subtitle="list ? t('{count} integrations', { count: byUse.inUse.length }) : undefined" @back="emit('back')">
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
      <p v-else-if="list && !byUse.inUse.length" class="catalog-muted">{{ t('No integration is in use. The ones below are turned off or were never set up.') }}</p>

      <section v-for="group in groups" :key="group.key" class="catalog-group">
        <h2>{{ t(group.label, group.values) }}</h2>
        <ul class="catalog-list">
          <IntegrationRow v-for="server in group.items" :key="rowKey(server)" :server="server" />
        </ul>
      </section>

      <details v-if="byUse.unused.length" class="catalog-unused">
        <summary>
          <Icon name="chevron" :size="14" class="catalog-chevron" />
          <span>{{ t('Not in use') }}</span>
          <span class="catalog-count">{{ byUse.unused.length }}</span>
        </summary>
        <p class="catalog-muted catalog-unused-note">{{ t('Configured, but turned off or never set up. Agents can not reach these until you turn them on or finish their setup.') }}</p>
        <section v-for="group in unusedGroups" :key="group.key" class="catalog-group">
          <h2>{{ t(group.label, group.values) }}</h2>
          <ul class="catalog-list">
            <IntegrationRow v-for="server in group.items" :key="rowKey(server)" :server="server" />
          </ul>
        </section>
      </details>

      <EnvKeysSection :workspaces="workspaces" />
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
.catalog-unused { display: grid; gap: 8px; }
.catalog-unused summary { display: flex; align-items: center; gap: 8px; width: fit-content; min-height: 28px; padding: 2px 8px 2px 4px; border-radius: var(--radius-sm); color: var(--muted); font-size: var(--text-sm); font-weight: 600; cursor: pointer; list-style: none; }
.catalog-unused summary::-webkit-details-marker { display: none; }
.catalog-unused summary:hover { background: var(--fill-hover); color: var(--ink); }
.catalog-chevron { flex: none; transition: transform var(--duration-fast) var(--ease-out); }
.catalog-unused[open] .catalog-chevron { transform: rotate(90deg); }
.catalog-count { padding: 0 7px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); font-weight: 600; }
.catalog-unused-note { margin: 0; font-size: var(--text-sm); }
.catalog-unused .catalog-group { margin-top: 6px; }
@media (pointer: coarse) { .catalog-unused summary { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .catalog-chevron { transition: none; } }
</style>
