<script setup lang="ts">
/** Under one of the person's own messages: pin it to the top of the
 * conversation, or unpin it when it is the one pinned. */
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { isPinned, pinMessage, unpinMessage } from "./pins";

const props = defineProps<{ sessionId: string; messageId: string }>();
const { t } = useI18n();
const busy = ref(false);
const failed = ref(false);
const pinned = computed(() => isPinned(props.sessionId, props.messageId));
const label = computed(() => failed.value ? t("Could not pin this message") : pinned.value ? t("Unpin") : t("Pin to the top of the conversation"));

async function toggle() {
  busy.value = true;
  failed.value = false;
  try { await (pinned.value ? unpinMessage(props.sessionId) : pinMessage(props.sessionId, props.messageId)); }
  catch { failed.value = true; }
  finally { busy.value = false; }
}
</script>

<template>
  <button type="button" :class="['pin-icon-button', { pinned, failed }]" :disabled="busy" :aria-pressed="pinned" :aria-label="label" :title="label" @click.stop="toggle"><Icon name="pin" :size="14" /></button>
</template>

<style scoped>
.pin-icon-button { display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: var(--radius-sm); background: none; color: var(--muted); cursor: pointer; }
.pin-icon-button:hover { background: var(--fill); color: var(--ink-soft); }
.pin-icon-button.pinned { color: var(--accent); }
.pin-icon-button.failed { color: var(--danger); }
.pin-icon-button:disabled { opacity: .5; }
@media (any-pointer: coarse) { .pin-icon-button { width: 32px; height: 32px; } }
</style>
