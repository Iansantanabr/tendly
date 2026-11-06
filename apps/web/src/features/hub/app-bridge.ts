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
import { ApiError, json, request, sessionPath } from "../api";
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

/** A refusal the app is told: `status` when a request failed, `code` for what kind ("permission", "rate", "unknown", "invalid"). */
export class BridgeError extends Error {
  readonly status?: number; readonly code?: string;
  constructor(message: string, code?: string, status?: number) { super(message); this.name = "BridgeError"; this.code = code; this.status = status; }
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

/** A failure as the app is told it: the message, and what kind when that is known. */
export function bridgeFailure(cause: unknown): { message: string; status?: number; code?: string } {
  if (cause instanceof BridgeError) return { message: cause.message, status: cause.status, code: cause.code };
  if (cause instanceof ApiError) return { message: cause.message, status: cause.status || undefined, code: cause.status === 403 ? "permission" : undefined };
  return { message: cause instanceof Error ? cause.message : String(cause) };
}

/** What the page tells the frame, in the envelope the SDK listens for. */
export function hostMessage(body: Record<string, unknown>): Record<string, unknown> { return { ...body, source: "tendly-host", v: 2 }; }
