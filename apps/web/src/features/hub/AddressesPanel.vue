<script setup lang="ts">
/**
 * Settings → Addresses and time zone: what changes when Tendly moves from this
 * Mac to a server. The time zone automations run in (a VPS clock is in UTC),
 * the public address published links are shown with, and whether the
 * microphone button exists at all. It also holds the one layout choice kept
 * with these settings: how the sidebar looks on the Mesa.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import {
  DEFAULT_SETTINGS, baseUrlProblem, filterZones, hubSettings, loadHubSettings, loadZones, sampleLink, saveHubSettings, tidyBaseUrl,
  timeInZone, zoneLabel, zoneList, zoneOffset, type HubSettings, type MesaSidebar,
} from "./settings";
import { mesaSidebar, setMesaSidebar } from "./rail";

const { t, locale } = useI18n();

const loadError = ref("");
const zone = ref(hubSettings.value?.timezone ?? ""), zoneQuery = ref("");
const base = ref(hubSettings.value?.public_base_url ?? "");
const saving = ref<"" | keyof HubSettings>(""), saved = ref<"" | keyof HubSettings>("");
const zoneError = ref(""), baseError = ref(""), dictationError = ref(""), sidebarError = ref("");
let savedTimer: ReturnType<typeof setTimeout> | undefined;

const ready = computed(() => !!hubSettings.value);
const current = computed(() => hubSettings.value ?? DEFAULT_SETTINGS);
/** The list the server accepts; until it arrives, at least the zone in use. */
const zones = computed(() => zoneList.value?.zones ?? (zone.value ? [zone.value] : []));
const offsets = computed(() => { const at = new Date(); return new Map(zones.value.map(name => [name, zoneOffset(name, at)])); });
const matching = computed(() => filterZones(zones.value, zoneQuery.value, zone.value));
/** How many zones the search itself finds (the chosen one stays listed either way). */
const found = computed(() => filterZones(zones.value, zoneQuery.value).length);
const optionText = (name: string) => { const offset = offsets.value.get(name); return offset ? `${zoneLabel(name)} (${offset})` : zoneLabel(name); };
const zoneNow = computed(() => zone.value ? timeInZone(zone.value, new Date(), locale.value) : "");
const serverZone = computed(() => zoneList.value?.server ?? "");
const zoneDirty = computed(() => ready.value && !!zone.value && zone.value !== current.value.timezone);

const baseProblem = computed(() => baseUrlProblem(base.value, t));
const baseDirty = computed(() => ready.value && tidyBaseUrl(base.value) !== current.value.public_base_url);
const origin = typeof location === "undefined" ? "" : location.origin;
const sample = computed(() => sampleLink(baseProblem.value ? "" : base.value, origin));
const dictationOn = computed(() => current.value.dictation !== "off");

function fill(settings: HubSettings) { zone.value = settings.timezone; base.value = settings.public_base_url; }

async function load() {
  loadError.value = "";
  try {
    await loadHubSettings();
    if (!hubSettings.value) throw new Error(t("The settings could not be read. Check that the server is running and reload."));
    fill(hubSettings.value);
    await loadZones();
  } catch (cause) { loadError.value = errorMessage(cause); }
}
onMounted(load);

const zoneSelect = ref<HTMLSelectElement>();
/** A list box opens at its top: bring the zone in use into view (Sao Paulo is
 * row 200). Runs when the list arrives, after Vue has set the selection. */
function showChosenZone(tries = 20) {
  const box = zoneSelect.value, option = box?.selectedOptions[0];
  // While the page slides in the list has no size yet: try again next frame.
  if (!box || !option || !box.clientHeight) { if (tries > 0 && box) setTimeout(() => showChosenZone(tries - 1), 50); return; }
  box.scrollTop = option.offsetTop - box.offsetTop - box.clientHeight / 2 + option.offsetHeight / 2;
}
watch(() => [zoneList.value, ready.value], () => { void nextTick(() => showChosenZone()); }, { flush: "post", immediate: true });

function flash(key: keyof HubSettings) {
  saved.value = key;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { saved.value = ""; }, 2500);
}

async function save(key: keyof HubSettings, value: string, error: { value: string }) {
  error.value = ""; saved.value = "";
  saving.value = key;
  try {
    const now = await saveHubSettings({ [key]: value });
    // Only the field that was saved: a draft in the other one stays as typed.
    if (key === "timezone") zone.value = now.timezone;
    if (key === "public_base_url") base.value = now.public_base_url;
    flash(key);
  }
  catch (cause) { error.value = errorMessage(cause); }
  finally { saving.value = ""; }
}
const saveZone = () => { if (zoneDirty.value) void save("timezone", zone.value, zoneError); };
const saveBase = () => { if (baseDirty.value && !baseProblem.value) void save("public_base_url", tidyBaseUrl(base.value), baseError); };

async function toggleDictation(input: HTMLInputElement) {
  await save("dictation", input.checked ? "browser" : "off", dictationError);
  // The click moved the switch; it shows what is saved, also when saving failed.
  input.checked = dictationOn.value;
}

const SIDEBAR_CHOICES: { value: MesaSidebar; label: string; hint: string }[] = [
  { value: "icons", label: "Icons", hint: "A narrow rail with the pages, your apps and the bell. Workspaces and conversations get a panel of their own beside it." },
  { value: "expanded", label: "Expanded", hint: "The full sidebar with names, on every page." },
];
async function chooseSidebar(value: MesaSidebar, input: HTMLInputElement) {
  if (value === mesaSidebar.value) return;
  sidebarError.value = ""; saved.value = "";
  saving.value = "mesa_sidebar";
  const problem = await setMesaSidebar(value);
  saving.value = "";
  if (problem) sidebarError.value = problem; else flash("mesa_sidebar");
  // The radios show what is saved, also when saving failed.
  input.checked = mesaSidebar.value === value;
}
</script>

<template>
  <section class="addr-page" :aria-label="t('Addresses and time zone')">
    <div class="settings-lead"><p>{{ t('What changes when Tendly moves from this Mac to a server: the time zone your automations follow, the address of the links you publish, and dictation.') }}</p></div>
    <p v-if="loadError" class="inline-error" role="alert">{{ loadError }} <button type="button" class="small-button" @click="load">{{ t('Try again') }}</button></p>
    <p v-else-if="!ready" class="addr-hint">{{ t('Loading…') }}</p>

    <form class="addr-card" :aria-busy="saving === 'timezone'" @submit.prevent="saveZone">
      <h2>{{ t('Time zone') }}</h2>
      <p class="addr-hint">{{ t('Automations that have no time zone of their own run in this one. It does not follow the clock of the machine: a server usually runs in UTC, and “every day at 9” should stay 9 where you are.') }}</p>
      <label class="addr-field">
        <span>{{ t('Search') }}</span>
        <input v-model="zoneQuery" type="search" autocomplete="off" spellcheck="false" :placeholder="t('City or region, for example Sao Paulo')" :disabled="!ready" />
      </label>
      <label class="addr-field">
        <span>{{ t('Time zone') }}</span>
        <select ref="zoneSelect" v-model="zone" size="7" class="addr-zones" :disabled="!ready || saving === 'timezone'">
          <option v-for="name in matching" :key="name" :value="name">{{ optionText(name) }}</option>
        </select>
      </label>
      <p class="addr-hint" role="status">
        <template v-if="zoneQuery.trim() && !found">{{ t('No time zone matches “{query}”. Try the name of a large city nearby.', { query: zoneQuery.trim() }) }}</template>
        <template v-else-if="zoneQuery.trim()">{{ t('{count} time zone(s) found.', { count: found }) }}</template>
        <template v-else-if="zone">{{ t('Chosen: {zone}.', { zone: zoneLabel(zone) }) }}</template>
        <template v-if="zone && zoneNow"> {{ t('It is {time} there now ({offset}).', { time: zoneNow, offset: offsets.get(zone) || zone }) }}</template>
      </p>
      <p v-if="serverZone && serverZone !== zone" class="addr-hint">{{ t('The clock of the machine running Tendly is in {zone}; automations ignore it.', { zone: zoneLabel(serverZone) }) }}</p>
      <p v-if="zoneError" class="inline-error" role="alert">{{ zoneError }}</p>
      <div class="addr-actions">
        <button type="submit" class="primary-button" :disabled="!zoneDirty || saving === 'timezone'">{{ t(saving === 'timezone' ? 'Saving…' : 'Save time zone') }}</button>
        <span v-if="saved === 'timezone'" class="addr-saved" role="status">{{ t('Saved. Automations follow it from the next run.') }}</span>
      </div>
    </form>

    <form class="addr-card" novalidate :aria-busy="saving === 'public_base_url'" @submit.prevent="saveBase">
      <h2>{{ t('Address of published links') }}</h2>
      <p class="addr-hint">{{ t('When set, the links of the files you publish use this address instead of the one in your browser. On a server it is the domain that shows only the published pages. Leave it empty to use Tendly’s own address.') }}</p>
      <label class="addr-field">
        <span>{{ t('Public address') }}</span>
        <input v-model="base" type="url" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200" placeholder="https://pub.example.com" :disabled="!ready || saving === 'public_base_url'" :aria-invalid="!!baseProblem" aria-describedby="addr-base-note" />
      </label>
      <p v-if="baseProblem" id="addr-base-note" class="inline-error" role="alert">{{ baseProblem }}</p>
      <p v-else id="addr-base-note" class="addr-hint">{{ t('A link will look like this:') }} <code class="addr-sample">{{ sample }}</code></p>
      <p class="addr-hint">{{ t('Links marked “Only the team” keep Tendly’s own address, because the sign-in lives there. Through the public address the server delivers only published pages (/p/…), never the app or its API.') }}</p>
      <p v-if="baseError" class="inline-error" role="alert">{{ baseError }}</p>
      <div class="addr-actions">
        <button type="submit" class="primary-button" :disabled="!baseDirty || !!baseProblem || saving === 'public_base_url'">{{ t(saving === 'public_base_url' ? 'Saving…' : 'Save address') }}</button>
        <span v-if="saved === 'public_base_url'" class="addr-saved" role="status">{{ t(current.public_base_url ? 'Saved. Published links now use this address.' : 'Saved. Published links use Tendly’s own address again.') }}</span>
      </div>
    </form>

    <div class="addr-card">
      <h2>{{ t('Dictation') }}</h2>
      <label :class="['addr-switch-row', { disabled: !ready || saving === 'dictation' }]">
        <input type="checkbox" class="addr-switch" role="switch" :checked="dictationOn" :disabled="!ready || saving === 'dictation'" @change="toggleDictation($event.target as HTMLInputElement)" />
        <span class="addr-switch-text">
          <strong>{{ t('Microphone button in the message box') }}</strong>
          <small v-if="saving === 'dictation'" role="status">{{ t('Saving…') }}</small>
          <small v-else-if="dictationOn" role="status">{{ t('On. Speech becomes text through the browser’s own service (Chrome sends the audio to Google).') }}</small>
          <small v-else role="status">{{ t('Off. The microphone button is hidden in every message box.') }}</small>
        </span>
      </label>
      <p v-if="dictationError" class="inline-error" role="alert">{{ dictationError }}</p>
    </div>

    <div class="addr-card" role="radiogroup" aria-labelledby="addr-sidebar-title" :aria-busy="saving === 'mesa_sidebar'">
      <h2 id="addr-sidebar-title">{{ t('Sidebar') }}</h2>
      <p class="addr-hint">{{ t('How the sidebar looks on every page, on a computer. On a phone it stays a drawer.') }}</p>
      <label v-for="choice in SIDEBAR_CHOICES" :key="choice.value" :class="['addr-radio-row', { disabled: !ready || saving === 'mesa_sidebar' }]">
        <input type="radio" name="mesa-sidebar" :value="choice.value" :checked="mesaSidebar === choice.value" :disabled="!ready || saving === 'mesa_sidebar'" @change="chooseSidebar(choice.value, $event.target as HTMLInputElement)" />
        <span class="addr-switch-text"><strong>{{ t(choice.label) }}</strong><small>{{ t(choice.hint) }}</small></span>
      </label>
      <p v-if="sidebarError" class="inline-error" role="alert">{{ sidebarError }}</p>
      <span v-if="saving === 'mesa_sidebar'" class="addr-hint" role="status">{{ t('Saving…') }}</span>
      <span v-else-if="saved === 'mesa_sidebar'" class="addr-saved" role="status">{{ t('Saved. The Mesa shows it right away.') }}</span>
    </div>
  </section>
</template>

<style scoped>
.addr-page { display: grid; gap: var(--space-3); min-width: 0; }
.addr-card { display: grid; gap: var(--space-3); padding: 16px; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--surface); min-width: 0; }
.addr-card h2 { margin: 0; font-size: var(--text-md); color: var(--ink); }
.addr-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); line-height: 1.5; overflow-wrap: anywhere; }
.addr-field { display: grid; gap: var(--space-1); min-width: 0; }
.addr-field > span { font-size: var(--text-xs); font-weight: 600; color: var(--muted); }
.addr-field input, .addr-zones { font: inherit; font-size: var(--input-text); color: var(--ink); background: var(--surface); border: 1px solid var(--line-input); border-radius: var(--radius-sm); padding: 7px 10px; min-width: 0; width: 100%; }
.addr-field input[type="url"] { font-family: var(--mono); }
.addr-field input[aria-invalid="true"] { border-color: var(--danger); }
.addr-zones { padding: 4px; }
.addr-zones option { padding: 4px 6px; border-radius: var(--radius-sm); }
.addr-sample { font-family: var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.addr-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); }
.addr-saved { color: var(--ok-ink); font-size: var(--text-xs); }
.addr-switch-row { display: flex; align-items: center; gap: var(--space-3); min-height: 44px; cursor: pointer; }
.addr-switch-row.disabled { cursor: default; }
.addr-switch-text { display: grid; gap: 2px; min-width: 0; }
.addr-switch-text strong { font-size: var(--text-sm); color: var(--ink); font-weight: 600; }
.addr-switch-text small { font-size: var(--text-xs); color: var(--muted); }
.addr-switch { appearance: none; flex: none; position: relative; width: 38px; height: 22px; margin: 0; border-radius: var(--radius-full); background: var(--line-input); cursor: pointer; transition: background var(--duration-fast) var(--ease-out); }
.addr-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); transition: transform var(--duration-fast) var(--ease-out); }
.addr-switch:checked { background: var(--accent); }
.addr-switch:checked::after { transform: translateX(16px); }
.addr-switch:disabled { opacity: .6; cursor: not-allowed; }
.addr-radio-row { display: flex; align-items: flex-start; gap: var(--space-3); min-height: 44px; padding: 4px 0; cursor: pointer; }
.addr-radio-row > input { flex: none; width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); cursor: pointer; }
.addr-radio-row.disabled, .addr-radio-row.disabled > input { cursor: default; }
@media (pointer: coarse) {
  .addr-field input, .addr-zones { min-height: 44px; }
  .addr-actions .primary-button { min-height: 44px; padding: 0 16px; }
  .addr-switch { width: 46px; height: 26px; }
  .addr-switch::after { width: 22px; height: 22px; }
  .addr-switch:checked::after { transform: translateX(20px); }
}
</style>
