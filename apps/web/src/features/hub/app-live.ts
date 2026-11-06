/**
 * Apps that reload on their own. The server watches each app's files and,
 * once they have been quiet for a moment, tells every open window over the
 * agent-activity socket (`AgentActivity.vue` hands each message to
 * `liveMessage`). A pane or the full-screen view showing that app reloads its
 * frame and offers to undo the change.
 *
 * The same socket carries the writes to an app's collections (records kept
 * in Tendly's database): a view of that app passes them on to the app's frame
 * (`app-records.ts`), so two panes of one app keep up with each other.
 *
 * This file is the listening, the two calls to the server and the small
 * decisions; `AppView.vue` draws the notice.
 */
import { json, request } from "../api";

/** One burst of changes to an app's files, as the server tells it. */
export interface AppChange {
  id: string;
  at: string;
  /** Up to twenty of the files, relative to the workspace. */
  paths: string[];
  count: number;
  undoable: boolean;
  /** The change this one took back, when it is an undo. */
  undo_of: string | null;
  /** An undo of an undo: the files are back as the first change left them. */
  redo?: boolean;
}
export interface UndoResult { undone: boolean; restored: string[]; removed: string[]; skipped: { path: string; reason: string }[] }
type AppId = { workspace_id: string; slug: string };

/** How long "Updated just now" stays up. */
export const NOTICE_MS = 60_000;

/** One write to a collection of an app, as the server tells it (`hub/apps/records.rs::announce`). */
export interface RecordEvent {
  collection: string;
  /** `reset`: many records at once (an import, the collection emptied). */
  op: "insert" | "update" | "remove" | "reset";
  id: string | null;
  rev: number | null;
  /** The record after the write; null for a removal, a reset, or a record too large to send along (`large`). */
  record: { id: string; rev: number; created_at: string; updated_at: string; data: Record<string, unknown> } | null;
  large: boolean;
}

const key = (app: AppId) => `${app.workspace_id}/${app.slug}`;
const listeners = new Map<string, Set<(change: AppChange) => void>>();
const recordListeners = new Map<string, Set<(event: RecordEvent) => void>>();
const reconnected = new Set<() => void>();

function listen<T>(all: Map<string, Set<(value: T) => void>>, id: string, listener: (value: T) => void): () => void {
  let set = all.get(id);
  if (!set) { set = new Set(); all.set(id, set); }
  const mine = set;
  mine.add(listener);
  return () => { mine.delete(listener); if (!mine.size && all.get(id) === mine) all.delete(id); };
}

/** Hears every write to the collections of one app until the returned function is called. */
export function watchRecords(app: AppId, listener: (event: RecordEvent) => void): () => void {
  return listen(recordListeners, key(app), listener);
}

/** Hears every change of one app until the returned function is called. */
export function watchApp(app: AppId, listener: (change: AppChange) => void): () => void {
  return listen(listeners, key(app), listener);
}

/** Called each time the socket (re)connects: whatever was said meanwhile was missed. */
export function onLiveReconnect(listener: () => void): () => void {
  reconnected.add(listener);
  return () => { reconnected.delete(listener); };
}

function asChange(value: unknown): AppChange | undefined {
  const change = value as Partial<AppChange> | null;
  if (!change || typeof change !== "object" || typeof change.id !== "string" || !change.id) return undefined;
  return {
    id: change.id, at: typeof change.at === "string" ? change.at : "",
    paths: Array.isArray(change.paths) ? change.paths.filter((path): path is string => typeof path === "string") : [],
    count: typeof change.count === "number" ? change.count : 0,
    undoable: change.undoable === true, undo_of: typeof change.undo_of === "string" ? change.undo_of : null, redo: change.redo === true,
  };
}

const OPS: readonly RecordEvent["op"][] = ["insert", "update", "remove", "reset"];
function asRecordEvent(collection: unknown, value: unknown): RecordEvent | undefined {
  const change = value as Record<string, unknown> | null;
  if (typeof collection !== "string" || !collection || !change || typeof change !== "object") return undefined;
  const op = OPS.find(known => known === change.op);
  if (!op) return undefined;
  const record = change.record as RecordEvent["record"];
  const whole = !!record && typeof record === "object" && typeof record.id === "string" && typeof record.rev === "number" && !!record.data && typeof record.data === "object";
  return {
    collection, op, id: typeof change.id === "string" ? change.id : null, rev: typeof change.rev === "number" ? change.rev : null,
    record: whole ? record : null, large: change.large === true,
  };
}

/**
 * A message from the agent-activity socket. Three concern apps: the snapshot
 * the server sends on every (re)connection, an app whose files changed, and a
 * write to one of an app's collections. A listener that throws does not stop
 * the others, nor the socket's own work.
 */
export function liveMessage(message: unknown): void {
  const data = message as { type?: unknown; event?: unknown; workspace_id?: unknown; slug?: unknown; change?: unknown; collection?: unknown } | null;
  if (!data || typeof data !== "object") return;
  if (data.type === "snapshot") { for (const listener of [...reconnected]) { try { listener(); } catch { /* The next one still hears. */ } } return; }
  if (data.type !== "hub" || typeof data.workspace_id !== "string" || typeof data.slug !== "string") return;
  if (data.event === "app-records") {
    const event = asRecordEvent(data.collection, data.change);
    if (!event) return;
    for (const listener of [...(recordListeners.get(`${data.workspace_id}/${data.slug}`) ?? [])]) { try { listener(event); } catch { /* The next one still hears. */ } }
    return;
  }
  if (data.event !== "app-changed") return;
  const change = asChange(data.change);
  if (!change) return;
  for (const listener of [...(listeners.get(`${data.workspace_id}/${data.slug}`) ?? [])]) { try { listener(change); } catch { /* The next one still hears. */ } }
}

const base = (app: AppId) => `/hub/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}/changes`;

/** The app's latest change, or null when it has not changed since the server started. */
export async function latestChange(app: AppId): Promise<AppChange | null> {
  const result = await request<{ latest: unknown }>(base(app));
  return asChange(result.latest) ?? null;
}

/** Puts the app's files back as they were before that change. */
export function undoChange(app: AppId, id: string): Promise<UndoResult> {
  return request<UndoResult>(`${base(app)}/${encodeURIComponent(id)}/undo`, json("POST"));
}

/** What the frame does with a change it has just heard of. */
export type ChangeOutcome = "ignore" | "reload" | "wait";
/**
 * `seen`: the last change this frame already shows. `held`: the app asked
 * (tendly.host.holdReload) not to be reloaded while it has unsaved input.
 */
export function onChange(state: { seen?: string; held: boolean }, change: AppChange): ChangeOutcome {
  if (change.id === state.seen) return "ignore";
  return state.held ? "wait" : "reload";
}

/** What the notice says about a change that was just applied. */
export function changeNotice(change: AppChange): { text: "Updated just now" | "Change undone"; action?: "Undo" | "Redo" } {
  if (change.undo_of && !change.redo) return { text: "Change undone", action: change.undoable ? "Redo" : undefined };
  return { text: "Updated just now", action: change.undoable ? "Undo" : undefined };
}

/** The files of a change, inside the app's folder, for the notice's tooltip. */
export function changedFiles(change: AppChange, slug: string, limit = 6): string {
  const prefix = `apps/${slug}/`;
  const names = change.paths.map(path => path.startsWith(prefix) ? path.slice(prefix.length) : path);
  const shown = names.slice(0, limit), more = Math.max(change.count, names.length) - shown.length;
  return more > 0 ? `${shown.join(", ")} +${more}` : shown.join(", ");
}
