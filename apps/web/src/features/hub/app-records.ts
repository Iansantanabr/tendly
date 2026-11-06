/**
 * An app's collections, as the Tendly page around the app deals with them.
 *
 * Records live in Tendly's database (`hub/apps/records.rs`), one row each with
 * a revision. The app reads and writes them through the bridge
 * (`app-bridge.ts`); this file is the two things the page itself does:
 *
 * - **Live.** The server tells every open window about each write, over the
 *   socket that already carries "an app's files changed" (`app-live.ts`). A
 *   view of that app passes it on to the app's frame when the app subscribed
 *   to that collection (`collection.subscribe` in the SDK), which is how two
 *   panes of one app keep up with each other, and with an agent.
 * - **Out and back in.** The "…" of the app's header exports a collection as
 *   JSON or CSV and imports one (`AppDataPanel.vue`).
 */
import { ApiConnectionError, routed } from "../api";
import { ask } from "./app-bridge";
import type { RecordEvent } from "./app-live";

type AppId = { workspace_id: string; slug: string };
const base = (app: AppId) => `/hub/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}/db`;

export interface AppRecord { id: string; rev: number; created_at: string; updated_at: string; data: Record<string, unknown> }
export interface AppCollection { name: string; count: number; updated_at: string }

// ---------------------------------------------------------------- live

/** What an app's subscriber is called with. `reset`: many records changed at once, read the list again. */
export interface RecordChange { type: "insert" | "update" | "remove" | "reset"; id: string | null; rev: number | null; record: AppRecord | null }

/** The collections one frame asked to hear about. They last as long as the page in the frame does. */
export function createSubscriptions() {
  const wanted = new Set<string>();
  return {
    set(collection: string, on: boolean) { if (on) wanted.add(collection); else wanted.delete(collection); },
    has: (collection: string) => wanted.has(collection),
    /** A new page loaded in the frame: it subscribes again if it wants to. */
    clear() { wanted.clear(); },
    list: () => [...wanted],
    get size() { return wanted.size; },
  };
}
export type Subscriptions = ReturnType<typeof createSubscriptions>;

/**
 * What to tell the app about a change the server announced, or undefined when
 * the app did not ask about that collection. A record too large to travel with
 * the announcement is read first; if that fails (it was removed meanwhile, the
 * connection dropped) the app is told to read the list again instead.
 */
export async function changeFor(event: RecordEvent, subscriptions: Pick<Subscriptions, "has">, read: (collection: string, id: string) => Promise<AppRecord>): Promise<RecordChange | undefined> {
  if (!subscriptions.has(event.collection)) return undefined;
  if (event.op === "reset" || !event.id) return { type: "reset", id: null, rev: null, record: null };
  if (event.op === "remove") return { type: "remove", id: event.id, rev: null, record: null };
  let record = event.record;
  if (!record && event.large) {
    try { record = await read(event.collection, event.id); }
    catch { return { type: "reset", id: null, rev: null, record: null }; }
    // The app may have stopped listening while the record was read.
    if (!subscriptions.has(event.collection)) return undefined;
  }
  if (!record) return { type: "reset", id: null, rev: null, record: null };
  return { type: event.op, id: event.id, rev: record.rev, record };
}

export function readRecord(app: AppId, collection: string, id: string): Promise<AppRecord> {
  return ask<AppRecord>(`${base(app)}/${encodeURIComponent(collection)}/r/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------- export and import

export type TransferFormat = "json" | "csv";
export type ImportMode = "merge" | "replace";
export interface ImportResult { inserted: number; updated: number; removed: number; total: number }

export async function listCollections(app: AppId): Promise<AppCollection[]> {
  return (await ask<{ collections: AppCollection[] }>(base(app))).collections ?? [];
}

/** Letters, digits, `_` and `-`, up to 64: what a collection may be called. */
export function validCollection(name: string): boolean { return /^[A-Za-z0-9_-]{1,64}$/.test(name); }

/** The format a file to import is in, from its name: `.csv` is CSV, anything else is read as JSON. */
export function formatOf(fileName: string): TransferFormat { return /\.(csv|tsv)$/i.test(fileName.trim()) ? "csv" : "json"; }

/** The name an exported collection is saved under. */
export function exportName(app: AppId, collection: string, format: TransferFormat): string { return `${app.slug}-${collection}.${format}`; }

/** A collection as a file: every record, as JSON (everything) or CSV (one column per field). */
export async function exportCollection(app: AppId, collection: string, format: TransferFormat): Promise<{ blob: Blob; filename: string }> {
  let response: Response;
  try {
    response = await fetch(`/api${routed(`${base(app)}/${encodeURIComponent(collection)}/export?format=${format}`)}`, { headers: { "X-Tendly-Client": "web" } });
  } catch { throw new ApiConnectionError("GET"); }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json(); if (typeof body.error === "string" && body.error) message = body.error; } catch { /* The status says it. */ }
    throw new Error(message);
  }
  return { blob: await response.blob(), filename: exportName(app, collection, format) };
}

/** Writes the records of a file into a collection: added to what is there (same id replaces), or instead of it. All or nothing. */
export function importCollection(app: AppId, collection: string, file: Blob, options: { format: TransferFormat; mode: ImportMode }): Promise<ImportResult> {
  return ask<ImportResult>(`${base(app)}/${encodeURIComponent(collection)}/import?format=${options.format}&mode=${options.mode}`, {
    method: "POST", body: file, headers: { "Content-Type": options.format === "csv" ? "text/csv" : "application/json" },
  });
}

/** Hands a file to the browser to save. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.rel = "noopener";
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** What an import did, as a sentence for `t()` with its numbers. */
export function importSummary(result: ImportResult): { text: string; values: Record<string, number> } {
  const values = { inserted: result.inserted, updated: result.updated, removed: result.removed, total: result.total };
  if (result.removed) return { text: "Replaced {removed} records with {inserted}.", values };
  if (result.updated && result.inserted) return { text: "Added {inserted} records and updated {updated}.", values };
  if (result.updated) return { text: "Updated {updated} records.", values };
  return { text: "Added {inserted} records.", values };
}
