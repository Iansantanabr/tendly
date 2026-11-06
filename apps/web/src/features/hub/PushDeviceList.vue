<script setup lang="ts">
/** The subscribed devices, each with Remove (two clicks, confirmed in place). */
import { ref } from "vue";
import { useI18n } from "../../i18n";
import { serviceName, type PushDevice } from "./push";

const props = defineProps<{
  devices: readonly PushDevice[];
  /** This browser's own row, if it is subscribed. */
  ownId?: string;
  /** The device being removed right now. */
  busyId?: string;
}>();
const emit = defineEmits<{ remove: [device: PushDevice] }>();
const { t } = useI18n();

/** The device whose Remove is armed: the next click on it confirms. */
const removing = ref<string | null>(null);
function remove(device: PushDevice) {
  if (removing.value !== device.id) { removing.value = device.id; return; }
  removing.value = null;
  emit("remove", device);
}

const when = (at: string | null) => at ? new Date(at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const nameOf = (device: PushDevice) => device.label || t('Unnamed device');
</script>

<template>
  <ul class="notify-list">
    <li v-for="device in props.devices" :key="device.id">
      <div class="notify-device">
        <span class="notify-device-name">
          <strong>{{ nameOf(device) }}</strong>
          <span v-if="device.id === props.ownId" class="notify-pill">{{ t('This device') }}</span>
        </span>
        <span class="notify-device-meta">
          <span>{{ t('Through {service}', { service: serviceName(device.service) }) }}</span>
          <span>{{ t('Added {time}', { time: when(device.created_at) }) }}</span>
          <span v-if="device.last_ok_at">{{ t('Last delivered {time}', { time: when(device.last_ok_at) }) }}</span>
          <span v-else>{{ t('Nothing delivered yet') }}</span>
          <span v-if="device.failures" class="notify-warn">{{ t('{count} failed attempt(s) in a row', { count: device.failures }) }}</span>
        </span>
      </div>
      <div class="notify-actions">
        <button v-if="removing === device.id" type="button" class="small-button" @click="removing = null">{{ t('Cancel') }}</button>
        <button type="button" class="small-button danger" :disabled="!!props.busyId" :aria-label="removing === device.id ? undefined : t('Remove {name}', { name: nameOf(device) })" @click="remove(device)">{{ t(props.busyId === device.id ? 'Removing…' : removing === device.id ? 'Confirm removal' : 'Remove') }}</button>
      </div>
      <p v-if="removing === device.id" class="notify-confirm" role="alert">{{ t('Remove {name}? It stops receiving notifications until it is turned on again there.', { name: nameOf(device) }) }}</p>
    </li>
  </ul>
</template>

<style scoped>
.notify-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-md); overflow: hidden; }
.notify-list li { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); padding: 10px 12px; min-width: 0; background: var(--elevated); }
.notify-list li + li { border-top: 1px solid var(--line); }
.notify-device { flex: 1 1 220px; min-width: 0; display: grid; gap: 2px; }
.notify-device-name { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--ink); }
.notify-device-meta { display: flex; flex-wrap: wrap; gap: 2px var(--space-3); color: var(--muted); font-size: var(--text-xs); }
.notify-pill { padding: 1px 8px; border-radius: var(--radius-full); background: var(--ok-soft); color: var(--ok-ink); font-size: var(--text-xs); font-weight: 600; }
.notify-warn { color: var(--warn-ink); }
.notify-actions { display: flex; gap: var(--space-2); }
.notify-confirm { flex-basis: 100%; margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; }
@media (pointer: coarse) { .notify-actions .small-button { min-height: 44px; padding: 0 16px; } }
</style>
