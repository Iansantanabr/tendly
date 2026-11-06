/**
 * Apps that reload on their own. The server watches each app's files and,
 * once they have been quiet for a moment, tells every open window over the
 * agent-activity socket (`AgentActivity.vue` hands each message to
 * `liveMessage`). A pane or the full-screen view showing that app reloads its
 * frame and offers to undo the change.
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

const key = (app: AppId) => `${app.workspace_id}/${app.slug}`;
const listeners = new Map<string, Set<(change: AppChange) => void>>();
const reconnected = new Set<() => void>();

/** Hears every change of one app until the returned function is called. */
export function watchApp(app: AppId, listener: (change: AppChange) => void): () => void {
  const id = key(app);
  let set = listeners.get(id);
  if (!set) { set = new Set(); listeners.set(id, set); }
  set.add(listener);
  return () => { set.delete(listener); if (!set.size && listeners.get(id) === set) listeners.delete(id); };
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

/**
 * A message from the agent-activity socket. Only two concern apps: the
 * snapshot the server sends on every (re)connection, and an app that changed.
 * A listener that throws does not stop the others, nor the socket's own work.
 */
export function liveMessage(message: unknown): void {
  const data = message as { type?: unknown; event?: unknown; workspace_id?: unknown; slug?: unknown; change?: unknown } | null;
  if (!data || typeof data !== "object") return;
  if (data.type === "snapshot") { for (const listener of [...reconnected]) { try { listener(); } catch { /* The next one still hears. */ } } return; }
  if (data.type !== "hub" || data.event !== "app-changed" || typeof data.workspace_id !== "string" || typeof data.slug !== "string") return;
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
