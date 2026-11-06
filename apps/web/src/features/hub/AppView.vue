<script setup lang="ts">
/**
 * An app on screen: a slim header with what it is and what can be done with
 * it, and the app itself in a frame below. A pane of the Mesa and the
 * full-screen view (`/apps/<workspace>/<slug>`) both draw this.
 *
 * The frame reloads on its own when the app's files change (`app-live.ts`),
 * says so in a small notice with Undo, and waits while the app holds reloads
 * back for unsaved input. Errors the app reports (`app-errors.ts`) are counted
 * in the header, listed, and turned into a message for an agent by "Ask for a
 * fix", which only ever fills a composer.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import Icon from "../Icon.vue";
import { errorMessage, routedUrl } from "../api";
import { copyText } from "../clipboard";
import { useI18n } from "../../i18n";
import AppTile from "./AppTile.vue";
import { appPagePath, apps, findApp, refreshApps } from "./apps";
import { appFilesPrefix, appScreen, errorPlace, fixRequest, kindLabel, readAppMessage, withError, type AppError } from "./app-errors";
import { NOTICE_MS, changeNotice, changedFiles, latestChange, onChange, onLiveReconnect, undoChange, watchApp, type AppChange } from "./app-live";

const props = defineProps<{
  workspaceId: string;
  workspaceName: string;
  slug?: string;
  /** What to show before the list of apps has been read (a tab remembers its app's name and tile). */
  fallback?: { name?: string; letter?: string; color?: string };
  /** `pane`: a tab of the Mesa. `page`: the full-screen view, which also offers "Open on the Mesa" and the code folder. */
  mode: "pane" | "page";
  /** Full screen: whether the chat column is showing. */
  chatOpen?: boolean;
}>();
const emit = defineEmits<{
  chat: [];
  /** "Ask for a fix": the message for a composer. */
  fix: [text: string];
  mesa: [];
  /** Show the app's folder in the file panel. */
  code: [];
  /** The app is gone: close this tab. */
  remove: [];
  /** The app is gone: back to the list of apps. */
  catalog: [];
}>();
const { t } = useI18n();

const app = computed(() => findApp(props.workspaceId, props.slug));
const name = computed(() => app.value?.name ?? props.fallback?.name ?? props.slug ?? "");
const letter = computed(() => app.value?.letter ?? props.fallback?.letter);
const color = computed(() => app.value?.color ?? props.fallback?.color);
const codePath = computed(() => app.value?.code_path ?? (props.slug ? `apps/${props.slug}/` : ""));
const src = computed(() => app.value ? routedUrl(app.value.url) : undefined);
const brokenReason = computed(() => apps.errors.find(error => error.workspace_id === props.workspaceId && error.slug === props.slug)?.message);
/** Gone once the list has been read without it; an unreadable list is not "gone". */
const missing = computed(() => apps.loaded && !apps.loading && !apps.error && !app.value);

// ---------------------------------------------------------------- the frame

const frame = ref<HTMLIFrameElement>();
const frameSrc = ref<string>(), reloads = ref(0), framing = ref(true);
/** The page of the app that is showing (its address inside the frame), as the SDK reports it. */
const place = ref("");
const screen = computed(() => app.value ? appScreen(place.value, app.value) : "");
watch(src, value => { frameSrc.value = value; place.value = ""; errors.value = []; held.value = false; pending.value = undefined; framing.value = true; });
/** Loads the app again where it was: the page it had open, when that is still one of its own. */
function reload() {
  const current = app.value;
  if (current && src.value) {
    frameSrc.value = place.value.startsWith(appFilesPrefix(current)) ? place.value : src.value;
    framing.value = true; reloads.value++;
    held.value = false; pending.value = undefined;
    if (notice.value?.kind === "waiting") notice.value = undefined;
  }
  void refreshApps();
}
function openTab() { if (src.value) window.open(src.value, "_blank", "noopener"); }

const copied = ref(false), copyProblem = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyLink() {
  if (!props.slug) return;
  clearTimeout(copiedTimer); copyProblem.value = "";
  try {
    await copyText(new URL(appPagePath({ workspace_id: props.workspaceId, slug: props.slug }), window.location.origin).href);
    copied.value = true;
  } catch { copied.value = false; copyProblem.value = t('Could not copy to the clipboard in this browser.'); }
  copiedTimer = setTimeout(() => { copied.value = false; copyProblem.value = ""; }, 2500);
}

// ---------------------------------------------------------------- what the app says

const errors = ref<AppError[]>([]), errorsOpen = ref(false);
const errorsButton = ref<HTMLButtonElement>();
/** The app asked not to be reloaded while it has unsaved input. */
const held = ref(false);
watch(() => errors.value.length, count => { if (!count) errorsOpen.value = false; });
function onMessage(event: MessageEvent) {
  const current = app.value;
  if (!current) return;
  const message = readAppMessage(event, { origin: window.location.origin, frame: frame.value?.contentWindow }, current);
  if (!message) return;
  if (message.type === "error") errors.value = withError(errors.value, message.error);
  else if (message.type === "location") {
    place.value = message.page;
    if (!message.fresh) return;
    // A page that has just loaded starts clean, and already has the newest files.
    errors.value = []; held.value = false;
    if (pending.value) { const waited = pending.value; pending.value = undefined; seen.value = waited.id; show({ kind: "change", change: waited }); }
  } else {
    held.value = message.on;
    if (!message.on && pending.value) apply(pending.value);
  }
}
function askForFix() {
  const current = app.value;
  if (!current || !errors.value.length) return;
  errorsOpen.value = false;
  emit("fix", fixRequest(current, errors.value, screen.value, t));
}
function clearErrors() { errors.value = []; errorsButton.value?.focus(); }
function closeErrors(event?: KeyboardEvent) {
  if (!errorsOpen.value) return;
  event?.preventDefault(); event?.stopPropagation();
  errorsOpen.value = false;
  errorsButton.value?.focus();
}

// ---------------------------------------------------------------- reload on its own

type Notice = { kind: "change"; change: AppChange; busy?: boolean; problem?: string } | { kind: "waiting" };
// Each notice is a new object, never changed in place: the timers below tell them apart by identity.
const notice = shallowRef<Notice>();
/** The last change this frame already shows; undefined until the server said which is the latest. */
const seen = ref<string>();
/** A change that arrived while the app held reloads back. */
const pending = ref<AppChange>();
/** Files an undo could not put back, said once beside "Change undone". */
const leftOver = ref("");
let noticeTimer: ReturnType<typeof setTimeout> | undefined, echoTimer: ReturnType<typeof setTimeout> | undefined;
function show(next: Notice | undefined) {
  clearTimeout(noticeTimer);
  notice.value = next;
  if (next?.kind === "change" && !next.busy) noticeTimer = setTimeout(() => { if (notice.value === next) notice.value = undefined; }, NOTICE_MS);
}
function apply(change: AppChange) {
  clearTimeout(echoTimer);
  seen.value = change.id;
  if (!change.undo_of) leftOver.value = "";
  reload();
  show({ kind: "change", change });
}
function heard(change: AppChange) {
  const outcome = onChange({ seen: seen.value, held: held.value }, change);
  if (outcome === "ignore") return;
  if (outcome === "wait") { pending.value = change; show({ kind: "waiting" }); return; }
  apply(change);
}
function reloadNow() { if (pending.value) apply(pending.value); else reload(); }
async function undo() {
  const current = notice.value, target = app.value;
  if (!current || current.kind !== "change" || current.busy || !target) return;
  const busy: Notice = { kind: "change", change: current.change, busy: true };
  show(busy);
  try {
    const result = await undoChange(target, current.change.id);
    leftOver.value = result.skipped.map(file => file.path.slice(target.code_path.length) || file.path).join(", ");
    // The files moving back is a change of its own, and its notice replaces this
    // one. Should the socket be down, ask for it.
    echoTimer = setTimeout(async () => {
      if (notice.value !== busy) return;
      try { const latest = await latestChange(target); if (latest && latest.id !== seen.value) heard(latest); else show(undefined); }
      catch { show(undefined); }
    }, 4000);
  } catch (cause) { show({ kind: "change", change: current.change, problem: errorMessage(cause) }); }
}
const noticeView = computed(() => notice.value?.kind === "change" ? changeNotice(notice.value.change) : undefined);

let stopWatching: (() => void) | undefined, stopReconnect: (() => void) | undefined;
const liveKey = computed(() => app.value ? `${app.value.workspace_id}/${app.value.slug}` : "");
function follow() {
  stopWatching?.(); stopWatching = undefined;
  seen.value = undefined; pending.value = undefined; show(undefined);
  const target = app.value;
  if (!target) return;
  stopWatching = watchApp(target, heard);
  // Which change the files just loaded already hold. Asking also has the server index the app, so its next change can be undone.
  latestChange(target).then(latest => { if (seen.value === undefined && liveKey.value === `${target.workspace_id}/${target.slug}`) seen.value = latest?.id ?? ""; }).catch(() => { /* Reloading by hand still works. */ });
}
async function resync() {
  const target = app.value;
  if (!target) return;
  try {
    const latest = await latestChange(target);
    if (seen.value === undefined) seen.value = latest?.id ?? "";
    else if (latest && latest.id !== seen.value) heard(latest);
  } catch { /* The next reconnection asks again. */ }
}
watch(liveKey, follow);
onMounted(() => {
  void refreshApps();
  frameSrc.value = src.value;
  window.addEventListener("message", onMessage);
  stopReconnect = onLiveReconnect(() => void resync());
  follow();
});
onBeforeUnmount(() => {
  window.removeEventListener("message", onMessage);
  stopWatching?.(); stopReconnect?.();
  clearTimeout(noticeTimer); clearTimeout(echoTimer); clearTimeout(copiedTimer);
});
</script>

<template>
  <section :class="['app-view', `is-${mode}`]" :aria-label="name">
    <header class="app-view-bar">
      <div class="app-view-id">
        <AppTile :name="name" :letter="letter" :color="color" :size="mode === 'page' ? 24 : 20" />
        <strong class="app-view-name" :title="app?.description || name">{{ name }}</strong>
        <button v-if="mode === 'page' && codePath" type="button" class="app-view-code" :title="t('Show {path} in the file panel', { path: codePath })" :aria-label="t('Show {path} in the file panel', { path: codePath })" @click="emit('code')"><Icon name="folder" :size="13" /><span>{{ t('code in {path}', { path: codePath }) }}</span></button>
        <code v-else-if="codePath" class="app-view-path" :title="`${workspaceName} · ${codePath}`">{{ codePath }}</code>
      </div>
      <div class="app-view-actions">
        <button v-if="errors.length" ref="errorsButton" type="button" class="small-button danger app-view-errors-button" :aria-expanded="errorsOpen" :title="t('Errors this app reported since it loaded')" @click="errorsOpen = !errorsOpen"><Icon name="info" :size="13" /><span>{{ t(errors.length === 1 ? '{count} error' : '{count} errors', { count: errors.length }) }}</span></button>
        <button type="button" :class="['small-button', 'app-view-chat', { primary: mode === 'page' && chatOpen }]" :aria-pressed="mode === 'page' ? !!chatOpen : undefined" :aria-label="t('Chat')" :title="t('Talk to an agent about this app')" @click="emit('chat')"><Icon name="chat" :size="13" /><span class="app-view-label">{{ t('Chat') }}</span></button>
        <button v-if="mode === 'page'" type="button" class="small-button app-view-mesa" :disabled="!app" :aria-label="t('Open on the Mesa')" :title="t('Open this app in a tab on the Mesa')" @click="emit('mesa')"><Icon name="grid" :size="13" /><span class="app-view-label">{{ t('Open on the Mesa') }}</span></button>
        <button type="button" class="icon-button" :aria-label="t('Reload')" :title="t('Reload')" :disabled="!src" @click="reload"><Icon name="refresh" :size="14" /></button>
        <button type="button" class="icon-button" :aria-label="t('Copy link')" :title="copied ? t('Link copied') : t('Copy a link to this app')" :disabled="!slug" @click="copyLink"><Icon :name="copied ? 'check' : 'clipboard'" :size="14" /></button>
        <button type="button" class="icon-button" :aria-label="t('Open in new tab')" :title="t('Open in new tab')" :disabled="!src" @click="openTab"><Icon name="arrow" :size="14" /></button>
      </div>
      <span class="sr-only" role="status">{{ copied ? t('Link copied') : copyProblem }}</span>
    </header>
    <p v-if="copyProblem" class="app-view-problem" role="alert">{{ copyProblem }}</p>
    <div v-if="errorsOpen && errors.length" class="app-view-errors" role="region" :aria-label="t('Errors in this app')" @keydown.esc="closeErrors">
      <ol>
        <li v-for="(error, index) in errors" :key="index">
          <span class="app-view-error-kind">{{ t(kindLabel(error.kind)) }}<template v-if="error.count > 1"> ×{{ error.count }}</template></span>
          <span class="app-view-error-text">{{ error.message }}</span>
          <code v-if="errorPlace(error)" class="app-view-error-place">{{ errorPlace(error) }}</code>
        </li>
      </ol>
      <footer>
        <small>{{ t('Nothing is sent until you press send in the chat.') }}</small>
        <span class="flex-spacer" />
        <button type="button" class="small-button" @click="clearErrors">{{ t('Clear') }}</button>
        <button type="button" class="small-button primary" @click="askForFix">{{ t('Ask for a fix') }}</button>
        <button type="button" class="icon-button" :aria-label="t('Close')" :title="t('Close')" @click="closeErrors()"><Icon name="close" :size="13" /></button>
      </footer>
    </div>
    <div class="app-view-body">
      <iframe v-if="frameSrc" ref="frame" :key="`${frameSrc}#${reloads}`" class="app-view-frame" :src="frameSrc" :title="name" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups" @load="framing = false" />
      <div v-if="frameSrc && framing" class="app-view-loading" role="status">{{ t('Loading…') }}</div>
      <div v-else-if="!frameSrc && missing" class="pane-empty">
        <Icon name="apps" :size="28" />
        <h3>{{ t('This app is not here anymore') }}</h3>
        <p>{{ brokenReason ? t('Tendly could not read {path}: {reason}', { path: codePath, reason: brokenReason }) : t('No app was found in {path} of {workspace}.', { path: codePath, workspace: workspaceName }) }}</p>
        <div class="app-view-empty-actions">
          <button v-if="mode === 'pane'" type="button" class="secondary-button" @click="emit('remove')">{{ t('Remove tab') }}</button>
          <button v-else type="button" class="secondary-button" @click="emit('catalog')">{{ t('See all apps') }}</button>
          <button type="button" class="small-button" @click="reload">{{ t('Try again') }}</button>
        </div>
      </div>
      <div v-else-if="!frameSrc && apps.error" class="pane-empty">
        <Icon name="info" :size="26" />
        <h3>{{ t('Could not load the apps') }}</h3>
        <p>{{ apps.error }}</p>
        <button type="button" class="small-button" @click="reload">{{ t('Try again') }}</button>
      </div>
      <div v-else-if="!frameSrc" class="app-view-loading" role="status">{{ t('Loading…') }}</div>
      <div v-if="notice" class="app-view-notice" role="status" aria-live="polite">
        <template v-if="notice.kind === 'waiting'">
          <Icon name="refresh" :size="13" />
          <span :title="t('This app asked to wait because it has something you have not saved.')">{{ t('A new version is ready') }}</span>
          <button type="button" class="text-button" @click="reloadNow">{{ t('Reload now') }}</button>
        </template>
        <template v-else-if="noticeView">
          <Icon :name="notice.busy ? 'refresh' : 'check'" :size="13" />
          <span v-if="notice.busy">{{ t('Putting the files back…') }}</span>
          <span v-else-if="notice.problem" class="app-view-notice-problem">{{ notice.problem }}</span>
          <span v-else :title="changedFiles(notice.change, slug ?? '')">{{ t(noticeView.text) }}<template v-if="leftOver && notice.change.undo_of"> · <span :title="leftOver">{{ t('some files were left as they are') }}</span></template></span>
          <button v-if="noticeView.action && !notice.busy" type="button" class="text-button" :title="noticeView.action === 'Undo' ? t('Put the files of this app back as they were before this change') : t('Apply the change again')" @click="undo">{{ t(noticeView.action) }}</button>
        </template>
        <button type="button" class="icon-button" :aria-label="t('Dismiss')" @click="show(undefined)"><Icon name="close" :size="12" /></button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.app-view { container: app-view / inline-size; display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; height: 100%; }
.app-view-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; flex: none; min-height: 34px; padding: 4px 6px 4px 10px; border-bottom: 1px solid var(--border); background: var(--sunken); min-width: 0; }
.app-view.is-page .app-view-bar { min-height: 44px; padding: 6px 10px 6px 14px; }
.app-view-id { display: flex; align-items: center; gap: 8px; flex: 1 1 140px; min-width: 0; }
.app-view-name { color: var(--ink); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.app-view.is-page .app-view-name { font-size: var(--text-md); }
.app-view-path { color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.app-view-code { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; padding: 3px 7px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); cursor: pointer; }
.app-view-code > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-view-code:hover { background: var(--fill); color: var(--ink); }
.app-view-actions { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex: none; max-width: 100%; margin-left: auto; }
.app-view-chat, .app-view-mesa, .app-view-errors-button { display: inline-flex; align-items: center; gap: 5px; }
.app-view-problem { flex: none; margin: 0; padding: 4px 12px; border-bottom: 1px solid var(--danger-line); background: var(--danger-soft); color: var(--danger-ink); font-size: var(--text-xs); }
.app-view-errors { flex: none; display: flex; flex-direction: column; max-height: 45%; min-height: 0; border-bottom: 1px solid var(--danger-line); background: var(--surface); }
.app-view-errors ol { flex: 1; min-height: 0; margin: 0; padding: 6px 12px; overflow: auto; list-style: none; display: grid; gap: 6px; }
.app-view-errors li { display: grid; gap: 2px; padding: 6px 8px; border: 1px solid var(--danger-line); border-radius: var(--radius-sm); background: var(--danger-soft); min-width: 0; }
.app-view-error-kind { color: var(--danger-ink); font-size: var(--text-xs); font-weight: 600; }
.app-view-error-text { color: var(--ink); font-size: var(--text-sm); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 6.5em; overflow: auto; }
.app-view-error-place { color: var(--muted); font-family: var(--mono); font-size: var(--text-xs); overflow-wrap: anywhere; }
.app-view-errors footer { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: none; padding: 6px 8px 6px 12px; border-top: 1px solid var(--border); }
.app-view-errors footer small { color: var(--muted); font-size: var(--text-xs); }
.flex-spacer { flex: 1; }
.app-view-body { position: relative; flex: 1; min-height: 0; display: flex; background: var(--surface); }
.app-view-frame { flex: 1; width: 100%; height: 100%; border: 0; background: var(--surface); }
.app-view-loading { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); font-size: var(--text-sm); background: var(--surface); pointer-events: none; }
.app-view-empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; align-items: center; }
.app-view-notice { position: absolute; left: 12px; bottom: 12px; z-index: 2; display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px); padding: 4px 6px 4px 12px; border: 1px solid var(--line); border-radius: var(--radius-full); background: var(--elevated); color: var(--ink); box-shadow: var(--shadow-md); font-size: var(--text-sm); animation: app-notice-in var(--duration-normal) var(--ease-out); }
.app-view-notice > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.app-view-notice > svg { flex: none; color: var(--muted); }
.app-view-notice .text-button { flex: none; font-size: var(--text-sm); }
.app-view-notice-problem { color: var(--danger-ink); white-space: normal; }
@keyframes app-notice-in { from { opacity: 0; transform: translateY(4px); } }
@media (prefers-reduced-motion: reduce) { .app-view-notice { animation: none; } }
/* Narrow (a slim pane, a phone, or the app squeezed by the chat column): icons keep their names in `aria-label` and `title`. */
@container app-view (max-width: 620px) { .app-view-label, .app-view-code > span { display: none; } }
@container app-view (max-width: 420px) { .app-view-path { display: none; } }
@media (pointer: coarse) {
  .app-view-bar .icon-button, .app-view-errors .icon-button, .app-view-notice .icon-button { width: 44px; height: 44px; }
  .app-view-bar .small-button, .app-view-errors .small-button, .app-view-code { min-height: 44px; min-width: 44px; }
  .app-view-notice .text-button { min-height: 44px; padding: 0 6px; }
}
</style>
