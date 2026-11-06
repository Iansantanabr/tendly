import { reactive } from "vue";

/**
 * Another conversation taken as context: pasting a Tendly link to one (or its
 * bare id) into a composer adds a chip instead of the raw URL, and the message
 * sent asks the agent to read it with `tendly_read_conversation`. The
 * transcript itself never travels in the message.
 */
export interface ConversationRef { id: string; title: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The conversation a pasted text points at: a same-origin URL containing
 * `/session/<id>` or `?chat=<id>`, or a bare id (`bare`, which only counts when
 * a session with that id exists). Anything else, other origins included, is
 * an ordinary paste.
 */
export function parseConversationLink(text: string, origin: string): { id: string; bare: boolean } | undefined {
  const value = text.trim();
  if (!value || /\s/.test(value)) return undefined;
  if (UUID.test(value)) return { id: value.toLowerCase(), bare: true };
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.origin !== origin) return undefined;
  const fromPath = /\/session\/([^/?#]+)/.exec(url.pathname)?.[1];
  const candidate = fromPath ?? url.searchParams.get("chat") ?? undefined;
  if (!candidate || !UUID.test(candidate)) return undefined;
  return { id: candidate.toLowerCase(), bare: false };
}

/** The link "Copy link" puts on the clipboard. */
export function conversationLink(id: string, origin: string): string {
  return `${origin}/session/${id}`;
}

/** The lines added to a message for the conversations attached to it. */
export function withConversations(message: string, refs: readonly ConversationRef[]): string {
  if (!refs.length) return message;
  const lines = refs.map(ref => `Context: read the Tendly conversation “${ref.title.replace(/\s+/g, " ").trim() || ref.id}” (session id ${ref.id}) with the tendly_read_conversation tool before answering.`);
  const body = message.trim();
  return body ? `${body}\n\n${lines.join("\n")}` : lines.join("\n");
}

/** Chips per composer (a session id, or "home"), kept while the pane is closed like a draft. */
const chips = reactive(new Map<string, ConversationRef[]>());

export function conversationChips(key: string): ConversationRef[] {
  return chips.get(key) ?? [];
}

/** Adds a chip once. `self` is the composer's own conversation, which cannot be its own context. */
export function addConversationChip(key: string, ref: ConversationRef, self?: string): "added" | "self" | "present" {
  if (self && ref.id === self.toLowerCase()) return "self";
  const list = conversationChips(key);
  if (list.some(item => item.id === ref.id)) return "present";
  chips.set(key, [...list, ref]);
  return "added";
}

export function removeConversationChip(key: string, id: string) {
  const list = conversationChips(key).filter(item => item.id !== id);
  if (list.length) chips.set(key, list); else chips.delete(key);
}

/** The chips going out with a message, cleared from the composer. */
export function takeConversationChips(key: string): ConversationRef[] {
  const list = conversationChips(key);
  chips.delete(key);
  return list;
}

/** Puts chips back, when a send failed before anything went out. */
export function restoreConversationChips(key: string, refs: readonly ConversationRef[]) {
  for (const ref of refs) addConversationChip(key, ref);
}

/** `insert` placed between `start` and `end` of `value`, with a space before it when it would run into a word. */
export function insertAt(value: string, start: number, end: number, insert: string): { value: string; caret: number } {
  const before = value.slice(0, start), after = value.slice(end);
  const text = before && !/\s$/.test(before) && !/^\s/.test(insert) ? ` ${insert}` : insert;
  return { value: before + text + after, caret: before.length + text.length };
}

export type PasteOutcome = { kind: "none" } | { kind: "self" } | { kind: "added" | "present"; ref: ConversationRef } | { kind: "unknown"; text: string };

/**
 * What a paste into a composer does with a conversation link. `lookup` gives a
 * session's title, or undefined when there is no such session; a link that
 * names none is pasted as it was (`unknown`).
 */
export async function pastedConversation(
  text: string,
  options: { origin: string; key: string; self?: string; lookup: (id: string) => Promise<string | undefined> },
): Promise<PasteOutcome> {
  const link = parseConversationLink(text, options.origin);
  if (!link) return { kind: "none" };
  if (options.self && link.id === options.self.toLowerCase()) return { kind: "self" };
  let title: string | undefined;
  try { title = await options.lookup(link.id); } catch { title = undefined; }
  if (title === undefined) return { kind: "unknown", text };
  const ref = { id: link.id, title };
  const outcome = addConversationChip(options.key, ref, options.self);
  return outcome === "self" ? { kind: "self" } : { kind: outcome, ref };
}
