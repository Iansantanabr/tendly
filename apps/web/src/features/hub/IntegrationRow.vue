<script setup lang="ts">
/** One MCP server in a list of integrations: name, where it runs, its state. */
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { CLAUDE_CONNECTORS_URL, authorizeInClaudeAi, type Integration } from "./catalog";

defineProps<{ server: Integration }>();
const { t } = useI18n();

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
  <li class="catalog-row">
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
</template>

<style scoped>
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
