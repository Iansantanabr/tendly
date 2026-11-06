<script setup lang="ts">
/** Publish one file at /p/{slug}: who sees it and when it updates. */
import { computed, reactive, ref, watch } from "vue";
import Icon from "../Icon.vue";
import { errorMessage } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../../i18n";
import {
  MODES, VISIBILITIES, changes, listPublications, problem, publicLink, publicationFor, publish, refreshPublication,
  tidySlug, unpublish, updatePublication, type Publication, type PublishMode, type Visibility,
} from "./publish";

const props = defineProps<{ workspaceId: string; path: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const current = ref<Publication | null>(null);
const loading = ref(true), busy = ref(""), error = ref(""), copied = ref(false);
const form = reactive<{ visibility: Visibility; password: string; mode: PublishMode; slug: string }>({ visibility: "team", password: "", mode: "frozen", slug: "" });
const others = ref<Publication[]>([]), othersOpen = ref(false), othersError = ref("");

const origin = typeof location === "undefined" ? "" : location.origin;
const link = computed(() => current.value ? publicLink(current.value, origin) : "");
const invalid = computed(() => problem(form, current.value?.has_password ?? false, t));
const dirty = computed(() => !!current.value && Object.keys(changes(current.value, form)).length > 0);
const frozenAt = computed(() => current.value?.frozen_at ? new Date(current.value.frozen_at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
const fileName = (path: string) => path.split("/").pop() || path;

function fill(publication: Publication | null) {
  current.value = publication;
  form.visibility = publication?.visibility ?? "team";
  form.mode = publication?.mode ?? "frozen";
  form.slug = publication?.slug ?? "";
  form.password = "";
}

async function load() {
  loading.value = true; error.value = "";
  try { fill(await publicationFor(props.workspaceId, props.path)); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { loading.value = false; }
}
watch(() => [props.workspaceId, props.path], () => { copied.value = false; void load(); }, { immediate: true });

async function act(label: string, work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = label; error.value = "";
  try { await work(); if (othersOpen.value) await loadOthers(); }
  catch (cause) { error.value = errorMessage(cause); }
  finally { busy.value = ""; }
}

function submit() {
  if (invalid.value) { error.value = invalid.value; return; }
  const slug = form.slug.replace(/-+$/, "");
  if (!current.value) {
    void act("publish", async () => fill(await publish(props.workspaceId, props.path, {
      visibility: form.visibility, mode: form.mode,
      ...(form.visibility === "password" ? { password: form.password } : {}),
      ...(slug ? { slug } : {}),
    })));
  } else if (dirty.value) {
    const publication = current.value;
    void act("save", async () => fill(await updatePublication(publication.slug, changes(publication, form))));
  }
}
const refresh = () => current.value && void act("refresh", async () => fill(await refreshPublication(current.value!.slug)));
function remove(publication: Publication) {
  if (!window.confirm(t("Unpublish {name}? The link stops working.", { name: fileName(publication.path) }))) return;
  void act(`remove:${publication.slug}`, async () => {
    await unpublish(publication.slug);
    if (current.value?.slug === publication.slug) fill(null);
  });
}
async function copy() {
  await copyText(link.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
const open = () => window.open(link.value, "_blank", "noopener");

async function loadOthers() {
  othersError.value = "";
  try { others.value = await listPublications(); }
  catch (cause) { othersError.value = errorMessage(cause); }
}
function toggleOthers(event: Event) {
  othersOpen.value = (event.target as HTMLDetailsElement).open;
  if (othersOpen.value) void loadOthers();
}
</script>

<template>
  <section class="publish-panel" :aria-label="t('Publish')">
    <header class="publish-head">
      <Icon name="globe" :size="14" />
      <strong>{{ current ? t('Published') : t('Publish this file') }}</strong>
      <span class="publish-spacer" />
      <button type="button" class="icon-button" :aria-label="t('Close')" :title="t('Close')" @click="emit('close')"><Icon name="close" :size="14" /></button>
    </header>

    <p v-if="loading" class="publish-hint">{{ t('Loading…') }}</p>
    <form v-else class="publish-form" @submit.prevent="submit">
      <div v-if="current" class="publish-link">
        <input :value="link" readonly :aria-label="t('Link')" @focus="($event.target as HTMLInputElement).select()">
        <button type="button" class="small-button" @click="copy"><Icon :name="copied ? 'check' : 'clipboard'" :size="13" />{{ t(copied ? 'Copied' : 'Copy') }}</button>
        <button type="button" class="small-button" @click="open">{{ t('Open') }}</button>
      </div>

      <fieldset class="publish-group">
        <legend>{{ t('Who can see it') }}</legend>
        <label v-for="choice in VISIBILITIES" :key="choice.value" class="publish-choice">
          <input v-model="form.visibility" type="radio" name="publish-visibility" :value="choice.value">{{ t(choice.label) }}
        </label>
        <input
          v-if="form.visibility === 'password'" v-model="form.password" class="publish-input" type="password" autocomplete="new-password"
          :aria-label="t('Password')" :placeholder="current?.has_password ? t('New password (empty keeps the current one)') : t('Password')"
        >
      </fieldset>

      <fieldset class="publish-group">
        <legend>{{ t('When it updates') }}</legend>
        <label v-for="choice in MODES" :key="choice.value" class="publish-choice">
          <input v-model="form.mode" type="radio" name="publish-mode" :value="choice.value">{{ t(choice.label) }}
        </label>
      </fieldset>

      <label class="publish-field">
        <span>{{ t('Link name (optional)') }}</span>
        <span class="publish-slug"><span class="publish-prefix">/p/</span><input v-model="form.slug" class="publish-input" :placeholder="t('made from the file name')" spellcheck="false" @input="form.slug = tidySlug(form.slug)"></span>
      </label>

      <p v-if="error" class="inline-error" role="alert">{{ error }}</p>

      <div class="publish-actions">
        <template v-if="current">
          <span v-if="current.mode === 'frozen' && frozenAt" class="publish-hint">{{ t('Frozen at {time}', { time: frozenAt }) }}</span>
          <button v-if="current.mode === 'frozen'" type="button" class="small-button" :disabled="!!busy || dirty" @click="refresh"><Icon name="refresh" :size="13" />{{ t(busy === 'refresh' ? 'Updating…' : 'Update now') }}</button>
          <span class="publish-spacer" />
          <button type="button" class="small-button danger" :disabled="!!busy" @click="remove(current)">{{ t('Unpublish') }}</button>
          <button type="submit" class="small-button primary" :disabled="!!busy || !dirty">{{ t(busy === 'save' ? 'Saving…' : 'Save') }}</button>
        </template>
        <template v-else>
          <span class="publish-spacer" />
          <button type="submit" class="small-button primary" :disabled="!!busy"><Icon name="globe" :size="13" />{{ t(busy === 'publish' ? 'Publishing…' : 'Publish') }}</button>
        </template>
      </div>
      <p class="publish-hint">{{ t('On this Mac the link opens only on this machine or your Tailscale network.') }}</p>
    </form>

    <details class="publish-others" @toggle="toggleOthers">
      <summary>{{ t('All published files') }}</summary>
      <p v-if="othersError" class="inline-error" role="alert">{{ othersError }}</p>
      <p v-else-if="!others.length" class="publish-hint">{{ t('Nothing is published yet.') }}</p>
      <ul v-else class="publish-list">
        <li v-for="item in others" :key="item.slug">
          <a :href="item.url" target="_blank" rel="noopener" :title="item.path">{{ fileName(item.path) }}</a>
          <code>{{ item.url }}</code>
          <span class="publish-spacer" />
          <button type="button" class="link-button danger" :disabled="!!busy" @click="remove(item)">{{ t('Unpublish') }}</button>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.publish-panel { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--elevated); border-bottom: 1px solid var(--line); box-shadow: var(--shadow-sm); font-size: var(--text-sm); color: var(--ink); }
.publish-head { display: flex; align-items: center; gap: var(--space-2); }
.publish-head strong { font-size: var(--text-md); }
.publish-spacer { flex: 1; }
.publish-form { display: grid; gap: var(--space-3); }
.publish-link { display: flex; gap: var(--space-2); align-items: center; }
.publish-link input { flex: 1; min-width: 0; }
.publish-link input, .publish-input { font: inherit; font-size: var(--text-sm); color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 6px 10px; min-width: 0; }
.publish-link input { font-family: var(--mono); }
.publish-input:focus, .publish-link input:focus { outline: none; border-color: var(--accent); }
.publish-group { display: grid; gap: 4px; margin: 0; padding: 0; border: 0; min-width: 0; }
.publish-group legend { padding: 0; margin-bottom: 4px; color: var(--muted); font-size: var(--text-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.publish-choice { display: flex; align-items: center; gap: var(--space-2); cursor: pointer; }
.publish-choice input { accent-color: var(--accent); margin: 0; }
.publish-group .publish-input { max-width: 320px; margin-top: 4px; }
.publish-field { display: grid; gap: 4px; color: var(--muted); font-size: var(--text-xs); }
.publish-slug { display: flex; align-items: center; gap: 4px; max-width: 420px; }
.publish-slug .publish-input { flex: 1; font-family: var(--mono); }
.publish-prefix { font-family: var(--mono); color: var(--faint); font-size: var(--text-sm); }
.publish-actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.small-button.danger { color: var(--danger); border-color: var(--line); background: var(--surface); }
.small-button.danger:hover:not(:disabled) { border-color: var(--danger); }
.publish-hint { margin: 0; color: var(--muted); font-size: var(--text-xs); }
.publish-form .inline-error, .publish-others .inline-error { margin: 0; }
.publish-others { border-top: 1px solid var(--line); padding-top: var(--space-2); }
.publish-others summary { cursor: pointer; color: var(--muted); font-size: var(--text-xs); }
.publish-others summary:hover { color: var(--ink); }
.publish-list { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: grid; gap: 2px; max-height: 220px; overflow: auto; }
.publish-list li { display: flex; align-items: center; gap: var(--space-2); padding: 4px 6px; border-radius: var(--radius-sm); min-width: 0; }
.publish-list li:hover { background: var(--fill-hover); }
.publish-list a { color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.publish-list a:hover { color: var(--accent); }
.publish-list code { font-family: var(--mono); color: var(--faint); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-button { border: 0; background: none; color: var(--muted); cursor: pointer; font: inherit; font-size: var(--text-xs); padding: 2px 6px; border-radius: var(--radius-sm); }
.link-button.danger:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
@media (max-width: 600px) { .publish-link { flex-wrap: wrap; } .publish-link input { flex-basis: 100%; } }
</style>
