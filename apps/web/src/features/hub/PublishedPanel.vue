<script setup lang="ts">
/** Settings → Published: every file published from this machine, in one place. */
import { onMounted } from "vue";
import { useI18n } from "../../i18n";
import PublicationsList from "./PublicationsList.vue";
import { reachNote } from "./publish";
import { loadHubSettings, publicBaseUrl } from "./settings";

const { t } = useI18n();
onMounted(() => { void loadHubSettings(); });
</script>

<template>
  <section class="published-page" :aria-label="t('Published files')">
    <div class="settings-lead"><p>{{ t('Files you published with the globe button. Each link keeps working until you unpublish it here or in the file.') }}</p></div>
    <PublicationsList />
    <p class="published-hint">{{ reachNote(publicBaseUrl, t) }}</p>
  </section>
</template>

<style scoped>
.published-page { display: grid; gap: var(--space-3); }
.published-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); }
</style>
