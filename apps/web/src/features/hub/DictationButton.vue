<script setup lang="ts">
import { onMounted, watch } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import type { Dictation } from "./dictation";
import { dictationAllowed, loadHubSettings } from "./settings";

/**
 * The microphone toggle of a composer. Hidden where the browser has no speech
 * recognition, and when dictation is switched off in Settings → Addresses and
 * time zone (it stays hidden until that setting has been read).
 */
const props = defineProps<{ dictation: Dictation; disabled?: boolean }>();
const { t } = useI18n();
// On mount, not during render: drawing a composer never makes a request by itself.
onMounted(() => { void loadHubSettings(); });
// Switched off while listening (in another window, say): stop sending audio.
watch(dictationAllowed, allowed => { if (!allowed && props.dictation.listening.value) props.dictation.stop(); });
function escape(event: KeyboardEvent) {
  if (!props.dictation.listening.value) return;
  event.preventDefault(); event.stopPropagation();
  props.dictation.stop();
}
</script>

<template>
  <button
    v-if="dictation.supported && dictationAllowed"
    type="button"
    :class="['dictation-button', { listening: dictation.listening.value }]"
    :aria-pressed="dictation.listening.value"
    :aria-label="t(dictation.listening.value ? 'Stop dictation' : 'Dictate')"
    :title="t(dictation.listening.value ? 'Stop dictation (Esc)' : 'Dictate: speak and the words go into the message')"
    :disabled="disabled && !dictation.listening.value"
    @click="dictation.toggle()"
    @keydown.esc="escape"
  ><Icon name="mic" :size="17" /></button>
</template>

<style scoped>
.dictation-button { flex-shrink: 0; display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: var(--radius-full); background: none; color: var(--muted); cursor: pointer; transition: background var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out); }
.dictation-button:hover:not(:disabled) { background: var(--fill-hover); color: var(--ink); }
.dictation-button:disabled { opacity: .5; cursor: not-allowed; }
.dictation-button.listening { --icon-color: currentColor; background: var(--danger-soft); color: var(--danger-ink); animation: dictation-pulse 1.4s var(--ease-out) infinite; }
@keyframes dictation-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 45%, transparent); }
  100% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--danger) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .dictation-button.listening { animation: none; box-shadow: 0 0 0 2px color-mix(in srgb, var(--danger) 45%, transparent); }
}
@media (pointer: coarse) { .dictation-button { width: 44px; height: 44px; } }
</style>
