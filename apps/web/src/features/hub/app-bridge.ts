/**
 * The Tendly side of the bridge between an app and Tendly.
 *
 * An app runs in a sandboxed frame with an origin of its own: it cannot call
 * the API. Its SDK posts a message to the page that frames it (`AppView.vue`),
 * and this file is what that page does about it: fetch the address the frame
 * loads from, know what the person allowed the app, and answer each call with
 * the page's own credentials, or refuse it with an error the app can show.
 *
 * What an app may read of Tendly is checked again by the server on every
 * call; the checks here are for what only the page can do (fill a composer,
 * open something on the Mesa, show a toast).
 */
import { ApiConnectionError, ApiError, json, request, routed, sessionPath } from "../api";
import { apps, type HubApp } from "./apps";

type AppId = Pick<HubApp, "workspace_id" | "slug">;
const appPath = (app: AppId) => `/hub/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}`;

// ---------------------------------------------------------------- the frame's address

/** Where a frame loads an app from, for now: a signed address that opens that app's files and nothing else. */
export interface AppFrame { base: string; url: string; token: string; expires_at: string; renew_after_seconds: number }
export function loadFrame(app: AppId): Promise<AppFrame> { return request<AppFrame>(`${appPath(app)}/frame`); }
/** Keeps the address of a frame that is still open. Rejects (410, 404) once it lapsed: the app is loaded again. */
export function renewFrame(app: AppId, token: string): Promise<{ expires_at: string; renew_after_seconds: number }> {
  return request(`${appPath(app)}/frame/renew`, json("POST", { token }));
}

// ---------------------------------------------------------------- permissions

export const PERMISSIONS = ["sessions:read", "files:read", "automations:read", "notify", "agent:draft"] as const;
export interface AppGrants {
  requested: string[]; granted: string[]; refused: string[];
  /** Asked for and not answered yet. */
  pending: string[];
  status: "none" | "ask" | "granted" | "partial" | "refused";
}
export function loadGrants(app: AppId): Promise<AppGrants> { return request<AppGrants>(`${appPath(app)}/grants`); }
/** The person's answer: `granted` is allowed, everything else the app asks is refused. */
export function decideGrants(app: AppId, granted: string[]): Promise<AppGrants> { return request<AppGrants>(`${appPath(app)}/grants`, json("PUT", { granted })); }

const PERMISSION_TEXT: Record<string, string> = {
  "sessions:read": "See your conversations: title, state and one line of the last reply (never the messages)",
  "files:read": "Read the files of the project it lives in (not hidden files)",
  "automations:read": "See your automations and when they ran",
  "notify": "Send you notifications (the bell and your devices)",
  "agent:draft": "Write a draft in a chat for you to read and send",
};
/** What a permission lets an app do, as an English key for `t()`. */
export function permissionText(permission: string): string { return PERMISSION_TEXT[permission] ?? permission; }

/** What the card offers: a new question is answered Allow / Refuse; an answered one can be changed as a whole. */
export function grantChoices(grants: AppGrants): { allow?: string[]; refuse?: string[]; asking: boolean } {
  if (grants.pending.length) return { asking: true, allow: grants.requested, refuse: grants.granted };
  return {
    asking: false,
    allow: grants.refused.length ? grants.requested : undefined,
    refuse: grants.granted.length ? [] : undefined,
  };
}

// ---------------------------------------------------------------- opening things on the Mesa

export type MesaTarget = { kind: "file"; workspaceId: string; path: string } | { kind: "app"; app: HubApp };
let opener: ((target: MesaTarget) => void) | undefined;
/** App.vue registers how a file or an app opens on the Mesa (it owns the canvas). */
export function onAppOpen(handler: (target: MesaTarget) => void) { opener = handler; }

// ---------------------------------------------------------------- answering a call

/**
 * A refusal the app is told: `status` when a request failed, `code` for what
 * kind ("permission", "rate", "unknown", "invalid", "conflict", "exists",
 * "full"), and on a conflict `current`, the record as it is now.
 */
export class BridgeError extends Error {
  readonly status?: number; readonly code?: string; readonly current?: unknown;
  constructor(message: string, code?: string, status?: number, current?: unknown) { super(message); this.name = "BridgeError"; this.code = code; this.status = status; this.current = current; }
}
const invalid = (message: string) => new BridgeError(message, "invalid", 400);

/** What the page that frames the app lends the bridge. */
export interface BridgeHost {
  app: HubApp;
  /** What the person allowed, as this view last heard it. */
  grants: () => AppGrants | undefined;
  openConversation: (id: string) => void;
  draft: (text: string, attach: { path: string; name: string }[]) => void;
  toast: (text: string) => void;
  openUrl: (url: string) => void;
  /** The app's page wants (or no longer wants) the changes of a collection passed on to it. */
  subscribe: (collection: string, on: boolean) => void;
}

/** So an app in a loop cannot bury the person in tabs, toasts or drafts: `max` of a kind per `ms`. */
export function createLimiter(now: () => number = Date.now) {
  const seen = new Map<string, number[]>();
  return (kind: string, max: number, ms: number): boolean => {
    const at = now(), recent = (seen.get(kind) ?? []).filter(time => at - time < ms);
    if (recent.length >= max) { seen.set(kind, recent); return false; }
    recent.push(at); seen.set(kind, recent);
    return true;
  };
}
export type Limiter = ReturnType<typeof createLimiter>;
const WINDOW = 10_000;
function limited(limiter: Limiter, kind: string, max: number) {
  if (!limiter(kind, max, WINDOW)) throw new BridgeError("This app is asking for that too often. Try again in a moment.", "rate", 429);
}

const text = (value: unknown, limit: number) => typeof value === "string" ? value.slice(0, limit) : "";
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
function key(args: Record<string, unknown>): string {
  const value = text(args.key, 80);
  if (!KEY.test(value)) throw invalid("Keys are letters, digits, _ and -, up to 64 characters");
  return value;
}

/** A path inside a workspace as an app may name it: relative, no `..`, no backslash. Undefined for anything else. */
export function workspacePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().replace(/^\.\//, "");
  if (!path || path.length > 500 || path.startsWith("/") || /[\\\0]/.test(path) || /^[A-Za-z]:/.test(path)) return undefined;
  if (path.split("/").some(part => part === ".." || part === ".")) return undefined;
  return path;
}

/** An http(s) address, whole. Undefined for anything else (`javascript:`, `file:`, a path). */
export function webAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2000) return undefined;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined; }
  catch { return undefined; }
}

function needs(host: BridgeHost, permission: string) {
  const grants = host.grants();
  if (grants?.granted.includes(permission)) return;
  throw new BridgeError(grants?.requested.includes(permission)
    ? `The "${permission}" permission was not allowed for this app. The person can allow it under Permissions, in the app's header.`
    : `This app has no "${permission}" permission. Add it to "permissions" in apps/${host.app.slug}/app.json; Tendly then asks the person to allow it.`, "permission", 403);
}

/** The largest file an app may hand over (`uploads.rs` checks again). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
function named(args: Record<string, unknown>, field: "collection" | "id"): string {
  const value = text(args[field], 80);
  if (!KEY.test(value)) throw invalid(field === "collection" ? "Collection names are letters, digits, _ and -, up to 64 characters" : "Record ids are letters, digits, _ and -, up to 64 characters");
  return value;
}
/** The object an app gave as JSON text (a record, or the fields to change). */
function recordOf(args: Record<string, unknown>): Record<string, unknown> {
  let value: unknown;
  try { value = typeof args.json === "string" ? JSON.parse(args.json) : undefined; } catch { value = undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("A record is an object");
  return value as Record<string, unknown>;
}
const revision = (value: unknown) => typeof value === "number" && Number.isInteger(value) ? value : undefined;
const isBytes = (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer || Object.prototype.toString.call(value) === "[object ArrayBuffer]";

/**
 * A request about an app's records or files. Like `request`, but a refusal
 * keeps what the server said besides the message: what kind it is and, on a
 * conflict, the record as it is now, which the app needs to merge and retry.
 */
export async function ask<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(`/api${routed(path)}`, { ...init, headers: { "X-Tendly-Client": "web", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  } catch { throw new ApiConnectionError(method); }
  if (response.ok) return (response.status === 204 ? undefined : await response.json()) as T;
  let body: { error?: unknown; code?: unknown; current?: unknown } = {};
  try { body = await response.json(); } catch { /* A refusal without a body keeps its status. */ }
  const message = typeof body.error === "string" && body.error ? body.error : `Request failed (${response.status})`;
  const code = typeof body.code === "string" ? body.code : response.status === 403 ? "permission" : undefined;
  throw new BridgeError(message, code, response.status, body.current);
}

const query = (values: Record<string, string | number | undefined>) => {
  const parts = Object.entries(values).filter(([, value]) => value !== undefined && value !== "").map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`);
  return parts.length ? `?${parts.join("&")}` : "";
};
const whole = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : undefined;

/**
 * Does what an app asked and resolves with the answer for it. Throws a
 * `BridgeError`, or the `ApiError` of the request it made (a refused
 * permission is the server's 403, said in its own words).
 */
export async function answerCall(call: { method: string; args: Record<string, unknown> }, host: BridgeHost, limiter: Limiter): Promise<unknown> {
  const { method, args } = call, base = appPath(host.app);
  switch (method) {
    // The app's own data.
    case "data.get": return request(`${base}/data/${key(args)}`);
    case "data.set": {
      if (typeof args.json !== "string") throw invalid("set() needs a value");
      return request(`${base}/data/${key(args)}`, { method: "PUT", body: args.json });
    }
    case "data.list": return (await request<{ keys: unknown[] }>(`${base}/data`)).keys;
    case "data.remove": await request(`${base}/data/${key(args)}`, json("DELETE")); return undefined;

    // Its records: collections kept in Tendly's database, one row per record with a revision.
    case "db.collections": return (await ask<{ collections: unknown[] }>(`${base}/db`)).collections;
    case "db.list": case "db.count": {
      const where = args.where === undefined || args.where === null ? undefined : args.where;
      if (where !== undefined && (typeof where !== "object" || Array.isArray(where))) throw invalid("where must be an object: { field: value }");
      const collection = `${base}/db/${named(args, "collection")}/query`;
      if (method === "db.count") return (await ask<{ total: number }>(collection, json("POST", { where, count: true }))).total;
      const order = args.order === undefined || args.order === null ? undefined : text(args.order, 80);
      return ask(collection, json("POST", { where, order, limit: whole(args.limit, 1, 5000), offset: whole(args.offset, 0, Number.MAX_SAFE_INTEGER) }));
    }
    case "db.get": return ask(`${base}/db/${named(args, "collection")}/r/${named(args, "id")}`);
    case "db.insert": {
      const id = args.id === undefined || args.id === null ? undefined : named(args, "id");
      return ask(`${base}/db/${named(args, "collection")}`, json("POST", { data: recordOf(args), id }));
    }
    case "db.update": {
      const one = `${base}/db/${named(args, "collection")}/r/${named(args, "id")}`, rev = revision(args.rev);
      return args.replace === true ? ask(one, json("PUT", { data: recordOf(args), rev })) : ask(one, json("PATCH", { patch: recordOf(args), rev }));
    }
    case "db.remove": {
      const rev = revision(args.rev);
      return (await ask<{ removed: boolean }>(`${base}/db/${named(args, "collection")}/r/${named(args, "id")}${query({ rev })}`, json("DELETE"))).removed;
    }
    case "db.subscribe": host.subscribe(named(args, "collection"), true); return undefined;
    case "db.unsubscribe": host.subscribe(named(args, "collection"), false); return undefined;

    // Files a person added to the app: images and PDF, kept in its files/ folder.
    case "files.list": return (await ask<{ files: unknown[] }>(`${base}/uploads`)).files;
    case "files.upload": {
      if (!isBytes(args.bytes)) throw invalid("upload() takes a File or a Blob");
      if (!args.bytes.byteLength) throw invalid("The file is empty");
      if (args.bytes.byteLength > MAX_UPLOAD_BYTES) throw new BridgeError("A file can be at most 20 MB", "invalid", 413);
      return ask(`${base}/uploads${query({ name: text(args.name, 200) })}`, { method: "POST", body: args.bytes, headers: { "Content-Type": "application/octet-stream" } });
    }
    case "files.remove": {
      const name = text(args.name, 120);
      if (!FILE_NAME.test(name) || name.includes("..")) throw invalid("remove() takes the path of an uploaded file");
      return (await ask<{ removed: boolean }>(`${base}/uploads/${encodeURIComponent(name)}`, json("DELETE"))).removed;
    }

    // Tendly's data, each behind its permission (the server checks).
    case "permissions.get": return loadGrants(host.app);
    case "sessions.list":
      return (await request<{ sessions: unknown[] }>(`${base}/tendly/sessions${query({ limit: whole(args.limit, 1, 300), archived: args.archived === true ? 1 : undefined })}`)).sessions;
    case "workspace.files": return (await request<{ entries: unknown[] }>(`${base}/tendly/files${query({ path: text(args.path, 500) })}`)).entries;
    case "workspace.read": return request(`${base}/tendly/file${query({ path: text(args.path, 500) })}`);
    case "automations.list": return (await request<{ automations: unknown[] }>(`${base}/tendly/automations${query({ runs: whole(args.runs, 1, 20) })}`)).automations;
    case "host.notify": await request(`${base}/notify`, json("POST", { title: text(args.title, 500), body: text(args.body, 2000) })); return undefined;

    // What only this page can do.
    case "host.toast": {
      const message = text(args.text, 200).trim();
      if (!message) throw invalid("toast() needs a text");
      limited(limiter, "toast", 5);
      host.toast(`${host.app.name}: ${message}`);
      return undefined;
    }
    case "host.openUrl": {
      const url = webAddress(args.url);
      if (!url) throw invalid("openUrl() takes an http or https address");
      limited(limiter, "open", 10);
      host.openUrl(url);
      return undefined;
    }
    case "host.openConversation": {
      const id = text(args.id, 80).trim();
      if (!UUID.test(id)) throw invalid("openConversation() takes a conversation id");
      limited(limiter, "open", 10);
      // Asked first, so an id that is not a conversation is told to the app instead of failing on the Mesa.
      await request(sessionPath(id));
      host.openConversation(id);
      return undefined;
    }
    case "host.openFile": {
      const path = workspacePath(args.path);
      if (!path) throw invalid("openFile() takes a path inside the app's workspace");
      limited(limiter, "open", 10);
      if (!opener) throw new BridgeError("Tendly cannot open a file from here");
      opener({ kind: "file", workspaceId: host.app.workspace_id, path });
      return undefined;
    }
    case "host.openApp": {
      const slug = text(args.slug, 80).trim();
      if (!SLUG.test(slug)) throw invalid("openApp() takes an app's folder name");
      // An app of the same project first; otherwise the only app with that name anywhere.
      const named = apps.list.filter(app => app.slug === slug);
      const target = named.find(app => app.workspace_id === host.app.workspace_id) ?? (named.length === 1 ? named[0] : undefined);
      if (!target) throw new BridgeError(`There is no app "${slug}"`, "invalid", 404);
      limited(limiter, "open", 10);
      if (!opener) throw new BridgeError("Tendly cannot open an app from here");
      opener({ kind: "app", app: target });
      return undefined;
    }
    case "host.draftChat": {
      needs(host, "agent:draft");
      const draft = text(args.text, 8000).trim();
      if (!draft) throw invalid("draftChat() needs a text");
      limited(limiter, "draft", 3);
      const attach = (Array.isArray(args.attach) ? args.attach : []).slice(0, 8).map(workspacePath)
        .filter((path): path is string => !!path)
        .map(path => ({ path, name: path.replace(/\/+$/, "").split("/").pop() || path }));
      host.draft(draft, attach);
      return undefined;
    }
    default: throw new BridgeError(`Tendly does not know "${method}"`, "unknown", 400);
  }
}

/** A failure as the app is told it: the message, what kind when that is known, and on a conflict the record as it is now. */
export function bridgeFailure(cause: unknown): { message: string; status?: number; code?: string; current?: unknown } {
  if (cause instanceof BridgeError) return { message: cause.message, status: cause.status, code: cause.code, ...(cause.current === undefined ? {} : { current: cause.current }) };
  if (cause instanceof ApiError) return { message: cause.message, status: cause.status || undefined, code: cause.status === 403 ? "permission" : undefined };
  return { message: cause instanceof Error ? cause.message : String(cause) };
}

/** What the page tells the frame, in the envelope the SDK listens for. */
export function hostMessage(body: Record<string, unknown>): Record<string, unknown> { return { ...body, source: "tendly-host", v: 2 }; }

/**
 * Tells the server what this window saw of the app since it loaded, so
 * `GET .../diagnostics` (an agent with curl, the catalog's error badge) can
 * say it without a browser. The whole list each time; an empty one says the
 * page loaded clean. Failures are ignored: this is a report, not a need.
 */
/** What the server knows of an app's health: its static problems and the errors the last window reported. */
export function fetchDiagnostics(app: AppId): Promise<{ ok: boolean; problems: { kind: string; message: string; file: string }[]; runtime: { page: string; reported_at: string; count: number; errors: { kind: string; message: string; file: string; line: number; column: number; count: number }[] } | null }> {
  return request(`${appPath(app)}/diagnostics`);
}

export async function reportDiagnostics(app: AppId, page: string, errors: readonly { kind: string; message: string; file?: string; line?: number; column?: number; count: number }[]): Promise<void> {
  const body = { page, errors: errors.slice(-50).map(error => ({ kind: error.kind, message: error.message, file: error.file ?? "", line: error.line ?? 0, column: error.column ?? 0, count: error.count })) };
  try { await request(`${appPath(app)}/diagnostics`, json("PUT", body)); } catch { /* Said nowhere: the header already shows the errors. */ }
}
