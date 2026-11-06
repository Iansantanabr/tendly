<script setup lang="ts">
/**
 * "Install app": a small hint on phones and tablets while Tendly runs in a
 * browser tab. Chrome on Android gets a button that opens its own dialog;
 * an iPhone gets the two steps (Share, Add to Home Screen), because Safari
 * has no dialog to open and only an installed app can receive notifications.
 */
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { installHint, promptInstall, readInstallEnv } from "./pwa";

/** `dismissible` (the home page) remembers a "Not now" on this device. */
const props = defineProps<{ dismissible?: boolean }>();
const { t } = useI18n();

const DISMISSED_KEY = "tendly.hub.install-hint";
function wasDismissed() {
  try { return localStorage.getItem(DISMISSED_KEY) === "dismissed"; } catch { return false; }
}
const dismissed = ref(props.dismissible === true && wasDismissed());
function dismiss() {
  dismissed.value = true;
  try { localStorage.setItem(DISMISSED_KEY, "dismissed"); } catch { /* For this visit only. */ }
}

// readInstallEnv reads the reactive `install`, so this follows the browser's prompt arriving and the app being installed.
const kind = computed(() => installHint(readInstallEnv()));
const busy = ref(false);
async function installNow() {
  busy.value = true;
  try { await promptInstall(); } finally { busy.value = false; }
}
</script>

<template>
  <aside v-if="kind !== 'none' && !dismissed" class="install-hint" :aria-label="t('Install app')">
    <span class="install-hint-icon" aria-hidden="true"><Icon name="download" :size="16" /></span>
    <div class="install-hint-text">
      <strong>{{ t('Install app') }}</strong>
      <p v-if="kind === 'prompt'">{{ t('Tendly opens from your home screen, full screen, like any other app.') }}</p>
      <p v-else-if="kind === 'ios'">{{ t('In Safari, tap Share and then “Add to Home Screen”. Tendly opens full screen and can send notifications.') }}</p>
      <p v-else>{{ t('Open the browser menu and choose “Install app” or “Add to Home screen”.') }}</p>
    </div>
    <div class="install-hint-actions">
      <button v-if="kind === 'prompt'" type="button" class="small-button primary" :disabled="busy" @click="installNow">{{ t('Install') }}</button>
      <button v-if="props.dismissible" type="button" class="small-button" @click="dismiss">{{ t('Not now') }}</button>
    </div>
  </aside>
</template>

<style scoped>
.install-hint { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--elevated); box-shadow: var(--shadow-sm); min-width: 0; }
.install-hint-icon { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--radius-full); background: var(--accent-soft); color: var(--accent-ink); }
.install-hint-text { flex: 1 1 200px; min-width: 0; display: grid; gap: 2px; }
.install-hint-text strong { font-size: var(--text-sm); color: var(--ink); }
.install-hint-text p { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
.install-hint-actions { display: flex; gap: var(--space-2); }
@media (pointer: coarse) { .install-hint-actions .small-button { min-height: 44px; padding: 0 16px; } }
</style>
