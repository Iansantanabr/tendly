<script setup lang="ts">
/** What the machine itself runs on a schedule, outside Tendly: crontab,
 * LaunchAgents, systemd timers. Read only; asked for when the section opens. */
import { computed, ref } from "vue";
import Icon from "../Icon.vue";
import { useI18n } from "../../i18n";
import { errorMessage } from "../api";
import { JOB_SOURCE_LABEL, groupJobs, loadServerJobs, type ServerJobList } from "./automations";

const { t } = useI18n();
const list = ref<ServerJobList>();
const loading = ref(false);
const failure = ref("");

async function load() {
  loading.value = true;
  failure.value = "";
  try { list.value = await loadServerJobs(); }
  catch (cause) { failure.value = errorMessage(cause); }
  finally { loading.value = false; }
}
/** The first time the section opens, look; afterwards only "Check again" does. */
function opened(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !list.value && !loading.value) void load();
}

const groups = computed(() => groupJobs(list.value?.jobs ?? []));
const looked = computed(() => (list.value?.sources ?? []).map(source => JOB_SOURCE_LABEL[source] ?? source).join(", "));
</script>

<template>
  <details class="jobs" @toggle="opened">
    <summary>
      <Icon name="chevron" :size="14" class="jobs-chevron" />
      <span>{{ t('Server jobs') }}</span>
      <span v-if="list" class="jobs-count">{{ list.jobs.length }}</span>
    </summary>
    <div class="jobs-body">
      <div class="jobs-top">
        <p class="jobs-hint">{{ t('What this machine runs on a schedule outside Tendly. Read only: to change one, edit it where it lives. Keys and passwords in commands are hidden.') }}</p>
        <button type="button" class="small-button" :disabled="loading" @click="load">{{ loading ? t('Checking…') : t('Check again') }}</button>
      </div>
      <p v-if="failure" class="inline-error" role="alert">{{ failure }}</p>
      <p v-else-if="!list" class="jobs-hint">{{ t('Looking at the scheduled jobs of this machine…') }}</p>
      <template v-else>
        <p v-if="!list.jobs.length" class="jobs-hint">{{ looked ? t('Nothing scheduled was found in: {places}.', { places: looked }) : t('No scheduler could be read on this machine.') }}</p>
        <section v-for="group in groups" :key="group.source" class="jobs-group">
          <h3>{{ JOB_SOURCE_LABEL[group.source] ?? group.source }} <span class="jobs-count">{{ group.jobs.length }}</span></h3>
          <ul class="jobs-list">
            <li v-for="(job, index) in group.jobs" :key="`${job.name}:${index}`" class="jobs-row">
              <div class="jobs-title">
                <strong>{{ job.name }}</strong>
                <span v-if="job.disabled" class="jobs-tag">{{ t('Turned off') }}</span>
              </div>
              <span class="jobs-line">
                <span class="jobs-label">{{ t('Schedule') }}</span>
                <code v-if="job.schedule">{{ job.schedule }}</code>
                <span v-else-if="job.next">{{ t('next run {time}', { time: job.next }) }}</span>
                <span v-else>{{ t('none (starts on demand)') }}</span>
              </span>
              <span v-if="job.schedule && job.next" class="jobs-line"><span class="jobs-label">{{ t('Next run') }}</span><span>{{ job.next }}</span></span>
              <span v-if="job.command" class="jobs-line"><span class="jobs-label">{{ t('Command') }}</span><code>{{ job.command }}</code></span>
            </li>
          </ul>
        </section>
        <p v-if="list.truncated" class="jobs-hint">{{ t('There are more jobs than are shown here.') }}</p>
      </template>
    </div>
  </details>
</template>

<style scoped>
.jobs { display: grid; gap: var(--space-2); }
.jobs summary { display: flex; align-items: center; gap: 8px; width: fit-content; min-height: 28px; padding: 2px 8px 2px 4px; border-radius: var(--radius-sm); color: var(--muted); font-size: var(--text-sm); font-weight: 600; cursor: pointer; list-style: none; }
.jobs summary::-webkit-details-marker { display: none; }
.jobs summary:hover { background: var(--fill-hover); color: var(--ink); }
.jobs-chevron { flex: none; transition: transform var(--duration-fast) var(--ease-out); }
.jobs[open] .jobs-chevron { transform: rotate(90deg); }
.jobs-count { padding: 0 7px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); font-weight: 600; }
.jobs-body { display: grid; gap: var(--space-2); margin-top: var(--space-2); }
.jobs-top { display: flex; align-items: flex-start; gap: var(--space-3); }
.jobs-top .jobs-hint { flex: 1; }
.jobs-hint { margin: 0; color: var(--muted); font-size: var(--text-sm); }
.jobs-body > .inline-error { margin: 0; }
.jobs-group { display: grid; gap: 6px; }
.jobs-group h3 { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; color: var(--muted); font-size: var(--text-xs); font-weight: 600; }
.jobs-list { list-style: none; margin: 0; padding: 0; display: grid; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); overflow: hidden; }
.jobs-row { display: grid; gap: 3px; padding: 10px 14px; min-width: 0; }
.jobs-row + .jobs-row { border-top: 1px solid var(--line); }
.jobs-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.jobs-title strong { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
.jobs-tag { flex: none; padding: 0 6px; border-radius: var(--radius-full); background: var(--fill); color: var(--muted); font-size: var(--text-xs); }
.jobs-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; color: var(--muted); font-size: var(--text-xs); }
.jobs-label { flex: none; min-width: 5.5em; color: var(--muted); }
.jobs-line code { min-width: 0; color: var(--ink); font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
@media (pointer: coarse) { .jobs summary, .jobs .small-button { min-height: 44px; } }
@media (prefers-reduced-motion: reduce) { .jobs-chevron { transition: none; } }
</style>
