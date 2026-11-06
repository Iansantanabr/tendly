<script setup lang="ts">
/** The slim bar at the top of a conversation showing the message the person
 * pinned there, with "Unpin". Nothing is drawn when nothing is pinned. */
import { computed, onMounted, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { errorMessage } from "../api";
import { loadPin, pinHasMore, pinPreview, pins, unpinMessage } from "./pins";

const props = defineProps<{ sessionId: string }>();
const { t } = useI18n();
const open = ref(false);
const busy = ref(false);
const failure = ref("");

const pin = computed(() => pins[props.sessionId] ?? null);
const more = computed(() => !!pin.value && pinHasMore(pin.value.text));

// Asked for once the pane is on screen, never while it renders.
onMounted(() => {
  watch(() => props.sessionId, id => { open.value = false; failure.value = ""; void loadPin(id).catch(() => { /* No bar is better than an error about a bar. */ }); }, { immediate: true });
});

async function unpin() {
  busy.value = true;
  failure.value = "";
  try { await unpinMessage(props.sessionId); open.value = false; }
  catch (cause) { failure.value = errorMessage(cause); }
  finally { busy.value = false; }
}
</script>

<template>
  <aside v-if="pin" class="pinned-bar" :aria-label="t('Pinned message')">
    <div class="pinned-row">
      <Icon name="pin" :size="14" class="pinned-icon" />
      <button v-if="more" type="button" class="pinned-text" :aria-expanded="open" :title="t(open ? 'Show less' : 'Show the whole message')" @click="open = !open">{{ pinPreview(pin.text) }}</button>
      <span v-else class="pinned-text">{{ pinPreview(pin.text) }}</span>
      <button type="button" class="pinned-unpin" :disabled="busy" @click="unpin">{{ busy ? t('Unpinning…') : t('Unpin') }}</button>
    </div>
    <p v-if="open && more" class="pinned-whole" tabindex="0">{{ pin.text }}</p>
    <p v-if="failure" class="pinned-error" role="alert">{{ failure }}</p>
  </aside>
</template>

<style scoped>
.pinned-bar { flex-shrink: 0; border-bottom: 1px solid var(--line); background: var(--elevated); color: var(--ink); font-size: var(--text-sm); }
.pinned-row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 3px 10px 3px 14px; }
/* Where the conversation's own menu floats in the corner, leave it room. */
.chat-pane:not(.has-tab-menu) .pinned-row { padding-right: 56px; }
.pinned-icon { flex: none; color: var(--accent); }
.pinned-text { flex: 1; min-width: 0; padding: 2px 4px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--ink); font: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.pinned-text { cursor: pointer; }
button.pinned-text:hover { background: var(--fill-hover); }
.pinned-unpin { flex: none; min-height: 26px; padding: 0 9px; border: 1px solid var(--line); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink-soft); font-size: var(--text-xs); font-weight: 550; cursor: pointer; }
.pinned-unpin:hover:not(:disabled) { background: var(--fill-hover); color: var(--ink); }
.pinned-unpin:disabled { opacity: .6; cursor: not-allowed; }
.pinned-whole { margin: 0; max-height: min(30vh, 220px); overflow: auto; padding: 4px 14px 10px 36px; color: var(--ink); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.pinned-error { margin: 0; padding: 0 14px 6px 36px; color: var(--danger); font-size: var(--text-xs); }
@media (pointer: coarse) { .pinned-row { min-height: 48px; } .pinned-unpin, button.pinned-text { min-height: 44px; } }
</style>
