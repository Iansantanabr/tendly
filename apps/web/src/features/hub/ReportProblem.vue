<script setup lang="ts">
/** The sidebar's footer action: open the list of problems, making its app
 * (`apps/reportes/` in the first project) the first time it is asked for. */
import { ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { errorMessage } from "../api";
import type { HubApp } from "./apps";
import { openReportApp } from "./report";

const props = defineProps<{ workspaces: Workspace[] }>();
const emit = defineEmits<{ openApp: [app: HubApp] }>();
const { t } = useI18n();
const busy = ref(false);
const failure = ref("");

async function report() {
  if (busy.value) return;
  busy.value = true;
  failure.value = "";
  try { emit("openApp", await openReportApp(props.workspaces.map(workspace => workspace.id), t)); }
  catch (cause) { failure.value = errorMessage(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <footer class="report-foot">
    <button type="button" class="nav-item report-button" :disabled="busy" :title="t('Opens your list of problems. The first time, it creates the app apps/reportes in your first project.')" @click="report">
      <Icon name="info" :size="16" /><span>{{ busy ? t('Opening…') : t('Report a problem') }}</span>
    </button>
    <p v-if="failure" class="report-error" role="alert">{{ failure }}</p>
  </footer>
</template>

<style scoped>
.report-foot { flex-shrink: 0; margin-top: auto; padding-top: 6px; border-top: 1px solid var(--fill-hover); }
.report-button { color: var(--muted); cursor: pointer; }
.report-button:hover:not(:disabled) { background: var(--fill-hover); color: var(--ink); }
.report-button:disabled { opacity: .6; cursor: not-allowed; }
.report-error { margin: 2px 0 0; padding: 0 10px 4px; color: var(--danger); font-size: var(--text-xs); overflow-wrap: anywhere; }
@media (pointer: coarse) { .report-button { min-height: 44px; } }
</style>
