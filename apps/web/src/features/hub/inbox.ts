import { reactive } from "vue";
import { json, request } from "../api";

/** One entry of the bell. Its text comes from `kind`, in the person's language. */
export interface InboxItem {
  id: number;
  kind: "turn_completed" | "turn_failed" | "waiting" | "automation_failed" | "automation_done" | string;
  session_id: string | null;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}
export interface SessionActivity {
  session_id: string;
  last_turn_at: string | null;
  last_turn_status: string | null;
  seen_at: string | null;
  unread: boolean;
}

/** Shared by the bell, the conversation bar and the home page; refreshed by App's poll. */
export const inbox = reactive({
  items: [] as InboxItem[],
  unread: 0,
  activity: {} as Record<string, SessionActivity>,
  /** False until the backend answered once: an old backend has none of this. */
  available: false,
});

export async function refreshInbox() {
  try {
    const [list, activity] = await Promise.all([
      request<{ items: InboxItem[]; unread: number }>("/hub/inbox"),
      request<{ sessions: SessionActivity[] }>("/hub/activity"),
    ]);
    inbox.items = list.items;
    inbox.unread = list.unread;
    inbox.activity = Object.fromEntries(activity.sessions.map(row => [row.session_id, row]));
    inbox.available = true;
  } catch {
    // An older backend, or offline: the views simply show nothing new.
  }
}

export function isUnread(sessionId: string) {
  return inbox.activity[sessionId]?.unread === true;
}

/** The person has looked at this conversation now. */
export async function markSeen(sessionId: string) {
  const row = inbox.activity[sessionId];
  const pending = inbox.items.some(item => item.session_id === sessionId && !item.read_at);
  if (!row?.unread && !pending) return;
  if (row) row.unread = false;
  for (const item of inbox.items) if (item.session_id === sessionId && !item.read_at) { item.read_at = new Date().toISOString(); inbox.unread = Math.max(0, inbox.unread - 1); }
  try { await request(`/hub/sessions/${encodeURIComponent(sessionId)}/seen`, json("POST")); } catch { /* Next poll settles it. */ }
}

export async function markAllSeen() {
  for (const row of Object.values(inbox.activity)) row.unread = false;
  try { await request("/hub/activity/seen-all", json("POST")); } catch { /* Next poll settles it. */ }
  await refreshInbox();
}

export async function markInboxRead(ids?: number[]) {
  try { await request("/hub/inbox/read", json("POST", ids ? { ids } : { all: true })); } catch { /* Next poll settles it. */ }
  await refreshInbox();
}

/** What an inbox entry says, as an English key for `t()`. */
export function inboxMessage(kind: string): string {
  switch (kind) {
    case "turn_completed": return "Finished replying";
    case "turn_failed": return "Stopped with an error";
    case "waiting": return "Is waiting for you";
    case "automation_done": return "Routine finished";
    case "automation_failed": return "Routine failed";
    default: return "Update";
  }
}

/** "agora", "12 min", "3 h", "2 d". */
export function shortAgo(iso: string | null | undefined, t: (s: string, v?: Record<string, string | number>) => string): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("now");
  if (seconds < 3600) return t("{count} min", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{count} h", { count: Math.floor(seconds / 3600) });
  return t("{count} d", { count: Math.floor(seconds / 86400) });
}
