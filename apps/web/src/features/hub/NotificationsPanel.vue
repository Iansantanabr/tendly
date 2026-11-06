<script setup lang="ts">
/**
 * Settings → Notifications: "This device". One switch asks the browser for
 * permission and subscribes it; below, every subscribed device with Remove,
 * and "Send a test". When the switch cannot work here, the panel says why and
 * what to do: no HTTPS, an iPhone that has not installed the app, a browser
 * without push, or notifications blocked for the site.
 */
import { computed, onMounted, ref } from "vue";
import { errorMessage } from "../api";
import { backendCapabilities } from "../backend-capabilities";
import { useI18n } from "../../i18n";
import InstallHint from "./InstallHint.vue";
import PushDeviceList from "./PushDeviceList.vue";
import {
  PUSH_ERROR_TEXT, PushError, disablePush, enablePush, listDevices, ownEndpointHash, pushSupport, readPushEnv, removeDevice, sendTestPush,
  type PushDevice, type PushSupport, type PushTestReport,
} from "./push";

const emit = defineEmits<{ remote: [] }>();
const { t } = useI18n();

const support = ref<PushSupport>(pushSupport(readPushEnv()));
const devices = ref<PushDevice[]>();
/** The hash of this browser's own endpoint, when it has a subscription. */
const ownHash = ref<string | null>(null);
const loadError = ref(""), switchError = ref(""), testError = ref("");
const switching = ref(false), testing = ref(false), busyId = ref("");
const testReport = ref<PushTestReport>();

const ownDevice = computed(() => devices.value?.find(device => device.endpoint_sha256 === ownHash.value));
const subscribed = computed(() => Boolean(ownDevice.value));
const canSwitch = computed(() => support.value === "ready" && !switching.value && devices.value !== undefined);

async function load() {
  loadError.value = "";
  support.value = pushSupport(readPushEnv());
  try {
    const [list, hash] = await Promise.all([listDevices(), ownEndpointHash().catch(() => null)]);
    devices.value = list;
    ownHash.value = hash;
  } catch (cause) { loadError.value = errorMessage(cause); }
}
onMounted(load);

async function toggle(input: HTMLInputElement) {
  switchError.value = ""; testReport.value = undefined;
  switching.value = true;
  try {
    if (input.checked) await enablePush();
    else await disablePush(devices.value ?? []);
  } catch (cause) {
    switchError.value = cause instanceof PushError ? t(PUSH_ERROR_TEXT[cause.reason]) + (cause.detail ? ` (${cause.detail})` : "") : errorMessage(cause);
  } finally {
    switching.value = false;
    await load();
    // The click moved the switch; it shows what is true now, also when turning it on failed.
    input.checked = subscribed.value;
  }
}

/** Confirmed in the list (PushDeviceList arms on the first click). */
async function remove(device: PushDevice) {
  busyId.value = device.id; loadError.value = "";
  try {
    // This browser's own row goes the way the switch does, so the browser forgets it too.
    if (device.id === ownDevice.value?.id) await disablePush(devices.value ?? []);
    else await removeDevice(device.id);
  } catch (cause) { loadError.value = errorMessage(cause); }
  finally { busyId.value = ""; await load(); }
}

async function test() {
  testError.value = ""; testReport.value = undefined;
  testing.value = true;
  try { testReport.value = await sendTestPush(); }
  catch (cause) { testError.value = errorMessage(cause); }
  finally { testing.value = false; await load(); }
}

</script>

<template>
  <section class="notify-page" :aria-label="t('Notifications')">
    <div class="settings-lead"><p>{{ t('Get a notification on your phone when a conversation finishes, stops with an error or is waiting for you, and when a routine ends.') }}</p></div>

    <InstallHint />

    <div class="notify-card">
      <h2>{{ t('This device') }}</h2>
      <label :class="['notify-switch-row', { disabled: !canSwitch }]">
        <input type="checkbox" class="notify-switch" role="switch" :checked="subscribed" :disabled="!canSwitch" @change="toggle($event.target as HTMLInputElement)" />
        <span class="notify-switch-text">
          <strong>{{ t('Receive notifications on this device') }}</strong>
          <small v-if="switching" role="status">{{ t('Working…') }}</small>
          <small v-else-if="support === 'ready' && subscribed" role="status">{{ t('On. This device is subscribed.') }}</small>
          <small v-else-if="support === 'ready'">{{ t('Off. Turning it on asks the browser for permission.') }}</small>
          <small v-else>{{ t('Not available here yet. See why below.') }}</small>
        </span>
      </label>

      <div v-if="support === 'insecure'" class="inline-notice notify-note">
        <strong>{{ t('This page is not on HTTPS') }}</strong>
        <p>{{ t('Browsers only allow notifications on a secure address. A phone needs to open Tendly over HTTPS: on this Mac, turn on Tailscale (tailscale serve), which Tendly already integrates, and open the https address it gives you on the phone. On a VPS it will be HTTPS from the start.') }}</p>
        <button v-if="backendCapabilities.tailnet" type="button" class="small-button" @click="emit('remote')">{{ t('Open Remote access') }}</button>
      </div>
      <div v-else-if="support === 'needs-install'" class="inline-notice notify-note">
        <strong>{{ t('Add Tendly to the Home Screen first') }}</strong>
        <p>{{ t('An iPhone or iPad only delivers notifications to an installed app. In Safari, tap Share and then “Add to Home Screen”, open Tendly from the new icon and come back to this page.') }}</p>
      </div>
      <div v-else-if="support === 'unsupported'" class="inline-notice notify-note">
        <strong>{{ t('This browser cannot receive notifications') }}</strong>
        <p>{{ t('Try Chrome, Edge, Firefox or Safari in a regular (not private) window.') }}</p>
      </div>
      <div v-else-if="support === 'denied'" class="inline-notice notify-note">
        <strong>{{ t('Notifications are blocked for this site') }}</strong>
        <p>{{ t('Allow them in the site settings of the browser (the icon beside the address), then reload this page and turn the switch on.') }}</p>
      </div>
      <p v-if="switchError" class="inline-error notify-note" role="alert">{{ switchError }}</p>
    </div>

    <div class="notify-card">
      <header class="notify-card-head">
        <h2>{{ t('Devices') }}</h2>
        <button type="button" class="small-button" :disabled="testing || !devices?.length" @click="test">{{ t(testing ? 'Sending…' : 'Send a test') }}</button>
      </header>
      <p v-if="loadError" class="inline-error notify-note" role="alert">{{ loadError }}</p>
      <p v-if="testError" class="inline-error notify-note" role="alert">{{ testError }}</p>
      <p v-if="testReport" class="notify-hint" role="status">
        <template v-if="testReport.sent && !testReport.failed">{{ t('Test sent to {count} device(s). It should arrive in a few seconds.', { count: testReport.sent }) }}</template>
        <template v-else-if="testReport.sent">{{ t('Test sent to {sent} device(s); {failed} could not be reached.', { sent: testReport.sent, failed: testReport.failed }) }}</template>
        <template v-else-if="testReport.waiting">{{ t('The push service asked to wait a little. Try again in a minute.') }}</template>
        <template v-else>{{ t('The test could not be delivered. Check the internet connection of the machine running Tendly and try again.') }}</template>
        <template v-if="testReport.removed"> {{ t('{count} device(s) no longer exist and were removed.', { count: testReport.removed }) }}</template>
      </p>
      <p v-if="!devices && !loadError" class="notify-hint">{{ t('Loading…') }}</p>
      <p v-else-if="devices && !devices.length" class="notify-hint">{{ t('No device is subscribed yet. Turn the switch on, on each device that should be notified.') }}</p>
      <PushDeviceList v-else-if="devices" :devices="devices" :own-id="ownDevice?.id" :busy-id="busyId" @remove="remove" />
      <p class="notify-hint">{{ t('A device that stops answering (the app was removed, the browser data cleared) leaves this list by itself.') }}</p>
    </div>
  </section>
</template>

<style scoped>
.notify-page { display: grid; gap: var(--space-3); min-width: 0; }
.notify-card { display: grid; gap: var(--space-3); padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); min-width: 0; }
.notify-card h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.notify-card-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.notify-switch-row { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; cursor: pointer; }
.notify-switch-row.disabled { cursor: default; }
.notify-switch-text { display: grid; gap: 2px; min-width: 0; }
.notify-switch-text strong { font-size: var(--text-sm); color: var(--ink); font-weight: 600; }
.notify-switch-text small { font-size: var(--text-xs); color: var(--muted); }
.notify-switch { appearance: none; flex: none; position: relative; width: 38px; height: 22px; margin: 0; border-radius: var(--radius-full); background: var(--line-input); cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
.notify-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); transition: transform var(--duration-fast) var(--ease-out); }
.notify-switch:checked { background: var(--accent); }
.notify-switch:checked::after { transform: translateX(16px); }
.notify-switch:disabled { opacity: .6; cursor: not-allowed; }
.notify-note { margin: 0; display: grid; gap: var(--space-2); justify-items: start; }
.notify-note p { margin: 0; }
.notify-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
@media (pointer: coarse) {
  .notify-card-head .small-button, .notify-note .small-button { min-height: 44px; padding: 0 16px; }
  .notify-switch { width: 46px; height: 26px; }
  .notify-switch::after { width: 22px; height: 22px; }
  .notify-switch:checked::after { transform: translateX(20px); }
}
</style>
