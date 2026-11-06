/**
 * What an app tells the page that frames it (through `sdk.js`): its errors,
 * which of its pages is showing, and whether it wants reloads held back.
 * This file reads those messages, keeps the list behind "2 errors" and writes
 * the message "Ask for a fix" puts in a chat. `AppView.vue` draws it.
 */

/** An app as these helpers need it. */
export interface AppRef { workspace_id: string; slug: string; name: string }

export type AppErrorKind = "error" | "unhandledrejection" | "console" | "load";
export interface AppError {
  kind: AppErrorKind;
  message: string;
  /** Inside the app's folder when it could be told: `apps/<slug>/app.js`. */
  file: string;
  line: number;
  column: number;
  stack: string;
  /** The page of the app that was showing, inside its folder. */
  page: string;
  at: number;
  /** How many times in a row it was reported. */
  count: number;
}
export type AppMessage =
  | { type: "error"; error: AppError }
  /** `fresh`: a page of the app has just loaded (not a move inside one). */
  | { type: "location"; page: string; fresh: boolean }
  | { type: "hold-reload"; on: boolean };

export const MAX_ERRORS = 50;
const KINDS: readonly AppErrorKind[] = ["error", "unhandledrejection", "console", "load"];
const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/** Where an app's files are served from. */
export function appFilesPrefix(app: Pick<AppRef, "workspace_id" | "slug">): string {
  return `/api/hub/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}/files/`;
}

/**
 * An address inside the app (absolute, or a path) as the file an agent would
 * open: `apps/<slug>/js/app.js`. Anything else (a CDN script, the SDK) is
 * returned as it came, without its query.
 */
export function appFilePath(address: string, app: Pick<AppRef, "workspace_id" | "slug">): string {
  if (!address) return "";
  let path = address;
  try { path = new URL(address, "http://app.invalid").pathname; } catch { /* Kept as it came. */ }
  const prefix = appFilesPrefix(app);
  if (path.startsWith(prefix)) {
    let inside = path.slice(prefix.length);
    try { inside = decodeURIComponent(inside); } catch { /* Kept encoded. */ }
    return `apps/${app.slug}/${inside}`;
  }
  return address.split(/[?#]/)[0];
}

/** The page of the app in view, inside its folder, with its hash: `index.html#/board`. */
export function appScreen(page: string, app: Pick<AppRef, "workspace_id" | "slug">): string {
  if (!page) return "";
  const prefix = appFilesPrefix(app);
  if (!page.startsWith(prefix)) return "";
  const inside = page.slice(prefix.length);
  try { return decodeURIComponent(inside); } catch { return inside; }
}

/**
 * A message from an app's frame, or undefined for anything else. `origin` must
 * be this page's own and the sender the frame itself: a message from any other
 * window, or shaped otherwise, is ignored.
 */
export function readAppMessage(event: { data: unknown; origin: string; source: unknown }, expected: { origin: string; frame: unknown }, app: Pick<AppRef, "workspace_id" | "slug">): AppMessage | undefined {
  if (event.origin !== expected.origin || !expected.frame || event.source !== expected.frame) return undefined;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object" || data.source !== "tendly-app" || data.v !== 1) return undefined;
  if (data.type === "hold-reload") return { type: "hold-reload", on: data.on === true };
  if (data.type === "location") return typeof data.page === "string" ? { type: "location", page: data.page.slice(0, 2000), fresh: data.fresh === true } : undefined;
  if (data.type !== "error") return undefined;
  const kind = KINDS.find(known => known === data.kind);
  const message = text(data.message, 2000).trim();
  if (!kind || !message) return undefined;
  return { type: "error", error: {
    kind, message, file: appFilePath(text(data.file, 500), app), line: count(data.line), column: count(data.column),
    stack: text(data.stack, 4000), page: appScreen(text(data.page, 2000), app), at: count(data.at) || Date.now(), count: 1,
  } };
}

const same = (a: AppError, b: AppError) => a.kind === b.kind && a.message === b.message && a.file === b.file && a.line === b.line;

/** The list with one more error: a repeat is counted on the one already there, and the list never outgrows `MAX_ERRORS`. */
export function withError(list: readonly AppError[], error: AppError): AppError[] {
  const index = list.findIndex(known => same(known, error));
  if (index >= 0) return list.map((known, at) => at === index ? { ...known, count: known.count + 1, at: error.at } : known);
  return list.length >= MAX_ERRORS ? [...list] : [...list, error];
}

/** `apps/crm/app.js:12:4`, as much of it as is known. */
export function errorPlace(error: Pick<AppError, "file" | "line" | "column">): string {
  if (!error.file) return "";
  if (!error.line) return error.file;
  return error.column ? `${error.file}:${error.line}:${error.column}` : `${error.file}:${error.line}`;
}

/** The first lines of a stack that say something the message and the place do not. */
export function stackLines(error: Pick<AppError, "stack" | "message">, app: Pick<AppRef, "workspace_id" | "slug">, limit = 3): string[] {
  const origin = /https?:\/\/[^/\s)]+/g, prefix = appFilesPrefix(app);
  return error.stack.split("\n").map(line => line.trim())
    .filter(line => line && !line.includes(error.message) && /:\d+/.test(line))
    .map(line => line.replace(origin, "").split(prefix).join(`apps/${app.slug}/`))
    .slice(0, limit);
}

type Translate = (key: string, values?: Record<string, string | number>) => string;
const KIND_LABEL: Record<AppErrorKind, string> = { error: "Error", unhandledrejection: "Unhandled promise rejection", console: "console.error", load: "File not loaded" };
export function kindLabel(kind: AppErrorKind): string { return KIND_LABEL[kind]; }

/** How many errors the message for the agent spells out. */
export const FIX_ERRORS = 5;

/**
 * What "Ask for a fix" writes in the chat: the app, the screen it was on, and
 * each error with its file and line. It is put in the composer for the person
 * to read and send; nothing here sends it.
 */
export function fixRequest(app: AppRef, errors: readonly AppError[], screen: string, t: Translate): string {
  const lines = [t('The app "{app}" (in apps/{slug}/) is showing errors. Find the cause and fix it, please.', { app: app.name, slug: app.slug }), ""];
  const page = screen || errors.find(error => error.page)?.page || "";
  if (page) lines.push(t('Screen open: {screen}', { screen: `apps/${app.slug}/${page}` }), "");
  const shown = errors.slice(-FIX_ERRORS);
  shown.forEach((error, index) => {
    const place = errorPlace(error), times = error.count > 1 ? ` (×${error.count})` : "";
    lines.push(`${index + 1}. [${t(kindLabel(error.kind))}] ${error.message.split("\n")[0]}${place ? ` — ${place}` : ""}${times}`);
    for (const line of stackLines(error, app)) lines.push(`   ${line}`);
  });
  if (errors.length > shown.length) lines.push("", t('({count} earlier errors left out.)', { count: errors.length - shown.length }));
  return lines.join("\n");
}
