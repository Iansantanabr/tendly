<script setup lang="ts">
/**
 * An app on the whole page (`/apps/<workspace>/<slug>`): the icon rail stays
 * on the left (App.vue), the app takes the rest, and "Chat" opens a
 * conversation in a column on the right, about this app.
 *
 * The column is an ordinary conversation of the app's project, started the
 * way the sidebar's "+" starts one. Its composer gets the app as a context
 * chip (and, from "Ask for a fix", the errors as text); nothing is sent until
 * the person sends it. Each app remembers its conversation in this browser, so
 * coming back to the app comes back to the same talk.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { EndpointProfile, Session, Workspace } from "@tendly/protocol";
import Icon from "../Icon.vue";
import SessionPane from "../SessionPane.vue";
import { errorMessage } from "../api";
import { useI18n } from "../../i18n";
import AppView from "./AppView.vue";
import { findApp, type HubApp } from "./apps";
import { APP_MIN, CHAT_MIN, appAttachment, clampChatWidth, fillComposer, maxChatWidth, readSideChats, sideChatSession, writeSideChats } from "./app-chat";
import { setPageContext } from "./open-context";

const props = defineProps<{
  workspaceId: string;
  slug: string;
  workspaces: Workspace[];
  sessions: Session[];
  profiles: EndpointProfile[];
  /** Starts a conversation in that project without putting it on the Mesa; undefined when it could not be started here. */
  startChat: (workspaceId: string) => Promise<Session | undefined>;
}>();
const emit = defineEmits<{
  openOnMesa: [app: HubApp];
  /** Show the app's folder in the file panel. */
  revealCode: [app: HubApp];
  catalog: [];
  sessionChanged: [];
  /** A conversation to open on the Mesa. */
  openSession: [session: Session];
  renameRequest: [id: string];
  sessionEnvironment: [id: string];
  profiles: [];
  revealSession: [id: string];
  keepSession: [id: string];
  openReference: [workspaceId: string, reference: { path: string; line?: number; checkout?: string | null }];
}>();
const { t } = useI18n();

const app = computed(() => findApp(props.workspaceId, props.slug));
const workspace = computed(() => props.workspaces.find(item => item.id === props.workspaceId));
const key = computed(() => `${props.workspaceId}/${props.slug}`);

// A conversation about the app is offered the app as context, like one beside its pane on the Mesa.
watch(app, value => setPageContext(value ? [{ workspaceId: value.workspace_id, ...appAttachment(value) }] : []), { immediate: true });
onBeforeUnmount(() => setPageContext([]));

// ---------------------------------------------------------------- the chat column

const side = reactive(readSideChats());
watch(side, value => writeSideChats(value), { deep: true });
const chatOpen = computed(() => !!side.open[key.value]);
const chatSession = computed(() => { const id = side.chats[key.value]; return id ? props.sessions.find(session => session.id === id && !session.archived_at) : undefined; });
const choices = computed(() => props.sessions.filter(session => session.workspace_id === props.workspaceId));
const starting = ref(false), chatProblem = ref("");
const root = ref<HTMLElement>(), column = ref<HTMLElement>();
// The conversation on screen here is in front of the person, as a focused tab of the Mesa is.
watch([chatOpen, chatSession], () => { sideChatSession.value = chatOpen.value ? chatSession.value?.id : undefined; }, { immediate: true });
onBeforeUnmount(() => { sideChatSession.value = undefined; });

async function focusComposer() {
  // The conversation draws its input a frame or a few after it mounts.
  for (let tries = 0; tries < 30; tries++) {
    await nextTick();
    const input = column.value?.querySelector<HTMLElement>("[data-pane-input]:not([disabled])");
    if (input) { input.focus({ preventScroll: true }); return; }
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!chatOpen.value) return;
  }
}
/** A new conversation for this app, with the app attached. Returns its id. */
async function newChat(): Promise<string | undefined> {
  if (starting.value) return undefined;
  starting.value = true; chatProblem.value = "";
  const forApp = key.value;
  try {
    const session = await props.startChat(props.workspaceId);
    if (!session) { chatProblem.value = t('The conversation could not be started here. Open the app on the Mesa and use Chat there.'); return undefined; }
    side.chats[forApp] = session.id;
    if (app.value) fillComposer(session.id, { attach: appAttachment(app.value) });
    return session.id;
  } catch (cause) { chatProblem.value = errorMessage(cause); return undefined; }
  finally { starting.value = false; }
}
function closeChat(refocus = true) {
  if (!chatOpen.value) return;
  delete side.open[key.value];
  if (refocus) void nextTick(() => root.value?.querySelector<HTMLElement>(".app-view-chat")?.focus());
}
/** "Chat": shows the column with the app's conversation, starting one the first time; pressed again, it closes. */
async function toggleChat() {
  if (chatOpen.value) { closeChat(); return; }
  side.open[key.value] = true;
  if (!chatSession.value && !(await newChat())) return;
  void focusComposer();
}
async function anotherChat() { if (await newChat()) void focusComposer(); }
/**
 * "Ask for a fix", and a draft the app wrote (`tendly.host.draftChat`): the
 * text goes into the composer of the conversation beside the app (a new one if
 * there is none), with the app attached. Never sent from here.
 */
async function fix(text: string, files?: { path: string; name: string }[]) {
  side.open[key.value] = true;
  const id = chatSession.value?.id ?? await newChat();
  if (!id) return;
  fillComposer(id, { attach: app.value ? appAttachment(app.value) : undefined, files, text });
  void focusComposer();
}
function moveToMesa() { const session = chatSession.value; if (!session) return; closeChat(false); emit("openSession", session); }

// Esc closes the column, unless something inside it (a menu, the composer) used the key first.
function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || event.defaultPrevented || !chatOpen.value) return;
  if (document.querySelector(".modal-backdrop, .bottom-sheet-backdrop, details[open].chat-menu")) return;
  event.preventDefault();
  closeChat();
}

// ---------------------------------------------------------------- its width

const pageWidth = ref(0), dragging = ref(false);
const width = computed(() => clampChatWidth(side.width, pageWidth.value || 1280));
/** Too narrow for both: the conversation covers the app, and closing it shows the app again. */
const stacked = computed(() => pageWidth.value > 0 && pageWidth.value < CHAT_MIN + APP_MIN);
let observer: ResizeObserver | undefined;
onMounted(() => {
  document.addEventListener("keydown", onKey);
  if (root.value && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(entries => { pageWidth.value = Math.round(entries[0]?.contentRect.width ?? 0); });
    observer.observe(root.value);
  }
});
onBeforeUnmount(() => { document.removeEventListener("keydown", onKey); observer?.disconnect(); });
function resize(event: PointerEvent) {
  const handle = event.currentTarget as HTMLElement, page = root.value;
  if (!page) return;
  handle.setPointerCapture?.(event.pointerId);
  dragging.value = true;
  const move = (moved: PointerEvent) => { const box = page.getBoundingClientRect(); side.width = clampChatWidth(box.right - moved.clientX, box.width); };
  const stop = () => { dragging.value = false; handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", stop); handle.removeEventListener("pointercancel", stop); };
  handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", stop); handle.addEventListener("pointercancel", stop);
}
function resizeKey(event: KeyboardEvent) {
  const total = pageWidth.value || 1280;
  const next = event.key === "ArrowLeft" ? width.value + 24 : event.key === "ArrowRight" ? width.value - 24 : event.key === "Home" ? total : event.key === "End" ? CHAT_MIN : undefined;
  if (next === undefined) return;
  event.preventDefault();
  side.width = clampChatWidth(next, total);
}
</script>

<template>
  <section ref="root" :class="['app-page', { 'chat-open': chatOpen, stacked, dragging }]" :aria-label="app?.name ?? slug">
    <div class="app-page-main">
      <AppView mode="page" :workspace-id="workspaceId" :workspace-name="workspace?.name ?? ''" :slug="slug" :chat-open="chatOpen" @chat="toggleChat" @fix="fix" @draft="fix" @mesa="app && emit('openOnMesa', app)" @code="app && emit('revealCode', app)" @catalog="emit('catalog')" />
    </div>
    <template v-if="chatOpen">
      <div v-if="!stacked" class="app-page-resizer" role="separator" aria-orientation="vertical" tabindex="0" :aria-label="t('Resize the chat')" :aria-valuenow="width" :aria-valuemin="CHAT_MIN" :aria-valuemax="maxChatWidth(pageWidth || 1280)" :title="t('Drag to resize · arrow keys also work')" @pointerdown.prevent="resize" @keydown="resizeKey" />
      <aside ref="column" class="app-page-chat" :style="stacked ? undefined : { width: `${width}px` }" :aria-label="t('Chat about {app}', { app: app?.name ?? slug })">
        <header class="app-page-chat-bar">
          <Icon name="chat" :size="14" />
          <strong :title="chatSession?.title">{{ chatSession?.title || t('Chat') }}</strong>
          <span class="flex-spacer" />
          <button type="button" class="icon-button" :disabled="starting" :aria-label="t('New conversation about this app')" :title="t('New conversation about this app')" @click="anotherChat"><Icon name="plus" :size="14" /></button>
          <button type="button" class="icon-button" :disabled="!chatSession" :aria-label="t('Move this conversation to the Mesa')" :title="t('Move this conversation to the Mesa')" @click="moveToMesa"><Icon name="grid" :size="14" /></button>
          <button type="button" class="icon-button" :aria-label="t('Close the chat')" :title="t('Close the chat') + ' · Esc'" @click="closeChat()"><Icon name="close" :size="14" /></button>
        </header>
        <p v-if="chatProblem" class="inline-error app-page-chat-problem" role="alert">{{ chatProblem }}</p>
        <SessionPane v-if="chatSession" :key="chatSession.id" :session="chatSession" :sessions="choices" :profiles="profiles" @changed="emit('sessionChanged')" @rename-request="emit('renameRequest', $event)" @environment="emit('sessionEnvironment', $event)" @profiles="emit('profiles')" @create="anotherChat" @select="emit('openSession', $event)" @reveal="emit('revealSession', $event)" @keep="emit('keepSession', $event)" @open-file="emit('openReference', workspaceId, $event)" />
        <div v-else class="pane-empty app-page-chat-empty">
          <Icon name="chat" :size="26" />
          <h3>{{ starting ? t('Starting…') : t('Talk to an agent about this app') }}</h3>
          <p>{{ t('The app goes along as context. You write what you want changed and send it yourself.') }}</p>
          <button type="button" class="small-button primary" :disabled="starting" @click="anotherChat">{{ t('New conversation') }}</button>
        </div>
      </aside>
    </template>
  </section>
</template>

<style scoped>
.app-page { position: absolute; inset: 0; z-index: 20; display: flex; min-width: 0; min-height: 0; background: var(--bg); }
.app-page-main { display: flex; flex: 1 1 0; min-width: 0; min-height: 0; }
.app-page-resizer { position: relative; flex: none; width: 7px; margin: 0 -3px; z-index: 3; cursor: col-resize; touch-action: none; }
.app-page-resizer::before { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 1px; background: var(--border); }
.app-page-resizer:hover::before, .app-page-resizer:focus-visible::before, .app-page.dragging .app-page-resizer::before { left: 2px; width: 3px; background: var(--line-strong); }
/* While the column is dragged the app's frame must not swallow the pointer. */
.app-page.dragging .app-page-main { pointer-events: none; }
.app-page.dragging { user-select: none; cursor: col-resize; }
.app-page-chat { display: flex; flex-direction: column; flex: none; min-width: 0; min-height: 0; max-width: 100%; background: var(--surface); }
.app-page.stacked .app-page-chat { position: absolute; inset: 0; z-index: 4; width: auto; }
.app-page-chat-bar { display: flex; align-items: center; gap: 6px; flex: none; min-height: 44px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border); background: var(--sunken); color: var(--muted); min-width: 0; }
.app-page-chat-bar strong { color: var(--ink); font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.flex-spacer { flex: 1; }
.app-page-chat-problem { flex: none; margin: 8px 10px 0; }
.app-page-chat-empty { flex: 1; }
@media (pointer: coarse) { .app-page-chat-bar .icon-button { width: 44px; height: 44px; } .app-page-chat-empty .small-button { min-height: 44px; } .app-page-resizer { width: 15px; margin: 0 -7px; } .app-page-resizer::before { left: 7px; } }
</style>
