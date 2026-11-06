<script setup lang="ts">
/** Settings → Published: every file published from this machine, in one place. */
import { useI18n } from "../../i18n";
import PublicationsList from "./PublicationsList.vue";

const { t } = useI18n();
</script>

<template>
  <section class="published-page" :aria-label="t('Published files')">
    <div class="settings-lead"><p>{{ t('Files you published with the globe button. Each link keeps working until you unpublish it here or in the file.') }}</p></div>
    <PublicationsList />
    <p class="published-hint">{{ t('On this Mac the link opens only on this machine or your Tailscale network.') }}</p>
  </section>
</template>

<style scoped>
.published-page { display: grid; gap: var(--space-3); }
.published-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); }
</style>
