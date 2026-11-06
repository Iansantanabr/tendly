/** The message pinned to the top of a conversation: one per conversation,
 * always something the person wrote. Kept on the server (`hub.db`), so it is
 * the same in every window and after a restart. */
import { reactive } from "vue";
import { json, request } from "../api";

export interface Pin {
  message_id: string;
  /** What the message says, as the server read it from the conversation. */
  text: string;
  pinned_at: string;
}

/** The pin of each conversation asked about so far: `null` is "none", a missing key is "not asked yet". */
export const pins = reactive<Record<string, Pin | null>>({});

const pinPath = (sessionId: string) => `/hub/sessions/${encodeURIComponent(sessionId)}/pin`;

export async function loadPin(sessionId: string): Promise<void> {
  pins[sessionId] = (await request<{ pin: Pin | null }>(pinPath(sessionId))).pin;
}

/** Pins this message; whatever was pinned in the conversation before gives way. */
export async function pinMessage(sessionId: string, messageId: string): Promise<void> {
  pins[sessionId] = (await request<{ pin: Pin | null }>(pinPath(sessionId), json("PUT", { message_id: messageId }))).pin;
}

export async function unpinMessage(sessionId: string): Promise<void> {
  await request<void>(pinPath(sessionId), json("DELETE"));
  pins[sessionId] = null;
}

export const isPinned = (sessionId: string, messageId: string) => pins[sessionId]?.message_id === messageId;

/** The pinned text on one line, for the slim bar: whitespace folded, cut at `limit` characters. */
export function pinPreview(text: string, limit = 160): string {
  const folded = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(folded);
  return chars.length <= limit ? folded : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Whether the whole message says more than the one line shows. */
export const pinHasMore = (text: string, limit = 160) => text.trim() !== pinPreview(text, limit);
