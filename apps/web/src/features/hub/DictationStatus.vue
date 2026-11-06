<script setup lang="ts">
import { useI18n } from "../../i18n";
import { DICTATION_ERRORS, type Dictation } from "./dictation";

/**
 * What dictation has to say under a composer: the one-time privacy notice,
 * "Listening…" with the words not yet final, or why it stopped.
 */
defineProps<{ dictation: Dictation }>();
const { t } = useI18n();
</script>

<template>
  <div v-if="dictation.supported" class="dictation-status">
    <span class="sr-only" role="status" aria-live="polite">{{ dictation.listening.value ? t('Listening…') : '' }}</span>
    <div v-if="dictation.notice.value" class="dictation-notice" role="note">
      <p>{{ t('Dictation uses your browser’s speech service: the audio is processed by it (Chrome sends it to Google). The text comes back here for you to edit before sending.') }}</p>
      <button type="button" class="small-button" @click="dictation.acknowledge()">{{ t('Got it') }}</button>
    </div>
    <p v-if="dictation.listening.value" class="dictation-live" aria-hidden="true"><strong>{{ t('Listening…') }}</strong><span v-if="dictation.interim.value" class="dictation-interim">{{ dictation.interim.value }}</span></p>
    <p v-if="dictation.error.value" class="dictation-error" role="alert">
      <span>{{ t(DICTATION_ERRORS[dictation.error.value]) }}</span>
      <button type="button" class="dictation-dismiss" :aria-label="t('Dismiss')" @click="dictation.dismissError()">×</button>
    </p>
  </div>
</template>

<style scoped>
.dictation-status { display: contents; }
.dictation-notice { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 10px; margin: 0 2px 6px; border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--fill); font-size: var(--text-xs); color: var(--ink-soft); }
.dictation-notice p { flex: 1; min-width: 200px; margin: 0; line-height: 1.5; }
.dictation-live { display: flex; gap: 8px; align-items: baseline; margin: 0 4px 6px; font-size: var(--text-sm); color: var(--muted); min-width: 0; }
.dictation-live strong { font-weight: 600; color: var(--danger-ink); flex-shrink: 0; font-size: var(--text-xs); }
.dictation-interim { opacity: .75; font-style: italic; overflow-wrap: anywhere; }
.dictation-error { display: flex; align-items: center; gap: 8px; margin: 0 2px 6px; padding: 6px 10px; border-radius: var(--radius-md); background: var(--danger-soft); color: var(--danger-ink); font-size: var(--text-xs); line-height: 1.5; }
.dictation-error span { flex: 1; }
.dictation-dismiss { border: 0; background: none; color: inherit; cursor: pointer; font-size: var(--text-md); line-height: 1; padding: 2px 6px; border-radius: var(--radius-sm); }
</style>
