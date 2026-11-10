<script setup lang="ts">
/** The sidebar's footer: open the list of problems, making its app
 * (`apps/reportes/` in the first project) the first time it is asked for.
 * On the Mesa, with the full sidebar chosen, it also offers the way back to
 * the icon rail. */
import { ref } from "vue";
import type { Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { errorMessage } from "../api";
import type { HubApp } from "./apps";
import { openReportApp } from "./report";
import { setMesaSidebar } from "./rail";

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
const shrinking = ref(false);
async function onlyIcons() {
  if (shrinking.value) return;
  shrinking.value = true;
  failure.value = "";
  const problem = await setMesaSidebar("icons");
  if (problem) failure.value = t('Could not save that choice: {reason}', { reason: problem });
  shrinking.value = false;
}
</script>

<template>
  <footer class="report-foot">
    <button type="button" class="nav-item report-button only-icons" :disabled="shrinking" :title="t('Shows the navigation as a narrow rail of icons on every page and gives the lists the whole panel.')" @click="onlyIcons">
      <Icon name="panelLeft" :size="16" /><span>{{ shrinking ? t('Saving…') : t('Show only icons here') }}</span>
    </button>
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
/* In a phone's drawer there is no rail to go back to. */
@media (max-width: 760px) { .only-icons { display: none; } }
</style>
