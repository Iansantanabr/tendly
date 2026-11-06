/**
 * Talking to an agent about an app. In the full-screen view "Chat" opens a
 * column beside the app; on the Mesa it opens (or reuses) a conversation in a
 * pane beside the app's. Either way the composer is only filled: the app as a
 * context chip, and for "Ask for a fix" the errors as text. Sending is always
 * the person's click.
 */
import { reactive, ref } from "vue";
import type { PaneNode, Session } from "@tendly/protocol";
import { chatDrafts } from "../chat-model";

/** The narrowest the chat column gets, what it starts at, and what the app always keeps. */
export const CHAT_MIN = 320, CHAT_DEFAULT = 420, APP_MIN = 360;

/** The widest the chat column gets in a page this wide: the app always keeps `APP_MIN`. */
export function maxChatWidth(pageWidth: number): number {
  return Math.max(CHAT_MIN, Math.round(pageWidth - APP_MIN));
}
/** A width for the chat column that leaves the app at least `APP_MIN`, in a page this wide. */
export function clampChatWidth(width: number, pageWidth: number): number {
  const wanted = Number.isFinite(width) ? width : CHAT_DEFAULT;
  return Math.round(Math.min(Math.max(wanted, CHAT_MIN), maxChatWidth(pageWidth)));
}

/** What this browser remembers of the chat column: its width, and per app the conversation and whether it was open. */
export interface SideChats { width: number; chats: Record<string, string>; open: Record<string, boolean> }
const STORAGE = "tendly.hub.app-chat.v1";
type Store = Pick<Storage, "getItem" | "setItem"> | undefined;
const local = (): Store => { try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; } };
const strings = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1]));
const flags = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(entry => entry[1] === true).map(([name]) => [name, true]));

export function readSideChats(storage: Store = local()): SideChats {
  let saved: Partial<SideChats> = {};
  try { saved = JSON.parse(storage?.getItem(STORAGE) ?? "{}") ?? {}; } catch { /* Starts from nothing. */ }
  const width = typeof saved.width === "number" && Number.isFinite(saved.width) ? Math.max(CHAT_MIN, Math.round(saved.width)) : CHAT_DEFAULT;
  return { width, chats: strings(saved.chats), open: flags(saved.open) };
}
export function writeSideChats(state: SideChats, storage: Store = local()): void {
  try { storage?.setItem(STORAGE, JSON.stringify({ width: state.width, chats: state.chats, open: state.open })); } catch { /* Fine without it. */ }
}

/**
 * The conversation showing in the chat column of the full-screen view, if any.
 * App.vue reads it to know which conversation is in front of the person: that
 * one is read, and does not ring a phone, like the focused tab of the Mesa.
 */
export const sideChatSession = ref<string>();

/** The app as the chip a composer attaches: its folder, named like the app. */
export function appAttachment(app: { slug: string; name: string }): { path: string; name: string } {
  return { path: `apps/${app.slug}/`, name: app.name };
}

/**
 * Puts something in a conversation's composer without sending it: a chip
 * (once), and text after whatever is already written there.
 */
export function fillComposer(sessionId: string, fill: { attach?: { path: string; name: string }; text?: string }): void {
  // The same reactive object the composer reads, so one that is on screen shows it at once.
  const draft = reactive(chatDrafts.get(sessionId));
  if (fill.attach && !(draft.attachments ?? []).some(file => file.path === fill.attach!.path)) {
    draft.attachments = [...(draft.attachments ?? []), { path: fill.attach.path, name: fill.attach.name, bytes: 0 }];
  }
  const text = fill.text?.trim();
  if (text) draft.text = draft.text.trim() ? `${draft.text.replace(/\s+$/, "")}\n\n${text}` : text;
}

/**
 * The conversation "open beside" an app on the Mesa: a chat tab of the app's
 * workspace, the one in focus if it is one, else the one used last.
 */
export function chatPaneFor(panes: readonly PaneNode[], sessions: readonly Session[], workspaceId: string, focusedPaneId?: string): { pane: PaneNode; session: Session } | undefined {
  const found = panes.flatMap(pane => {
    if (pane.kind !== "agent_chat") return [];
    const id = pane.metadata?.session_id;
    const session = typeof id === "string" ? sessions.find(item => item.id === id) : undefined;
    return session && session.workspace_id === workspaceId && session.provider !== "terminal" && !session.archived_at ? [{ pane, session }] : [];
  });
  return found.find(item => item.pane.id === focusedPaneId) ?? [...found].sort((a, b) => String(b.session.updated_at).localeCompare(String(a.session.updated_at)))[0];
}

/** A request, from an app pane, for a conversation beside it with its composer filled. */
export interface AppChatRequest { workspaceId: string; slug: string; name: string; paneId: string; text?: string }
let handler: ((request: AppChatRequest) => Promise<void> | void) | undefined;
/** App.vue registers how the Mesa answers (it owns the canvas and the sessions). */
export function onAppChatRequest(next: (request: AppChatRequest) => Promise<void> | void) { handler = next; }
export async function requestAppChat(request: AppChatRequest): Promise<void> { await handler?.(request); }
