import { reactive } from "vue";
import { errorMessage, json, request } from "../api";
import { APP_COLORS, type AppColor } from "./app-tile";

/** A custom app: `<workspace>/apps/<slug>/`, served by the host and shown in a frame. */
export interface HubApp {
  workspace_id: string;
  workspace_name: string;
  slug: string;
  name: string;
  letter: string;
  color: AppColor;
  description: string;
  entry: string;
  /** What the app asks to be allowed (`app-bridge.ts`); what the person answered is asked of the server. */
  permissions?: string[];
  /** A stable address of the entry page. It redirects to where the app is served; a frame asks for that address instead (`loadFrame`). */
  url: string;
  /** The app's folder in its workspace, `apps/<slug>/`. */
  code_path: string;
  /** When a file of the app last changed (not `data/` or `files/`). */
  updated_at: string;
  /** How many errors the last Tendly window showing the app reported (`diagnostics`), and when; 0 and null when none did. */
  errors?: number;
  errors_at?: string | null;
}
/** An app folder the host could not read (a broken app.json, say). */
export interface HubAppError { workspace_id: string; slug: string; message: string }

/** Every app on this host, shared by the sidebar, Home, the Apps page and the app tabs. */
export const apps = reactive({
  list: [] as HubApp[], errors: [] as HubAppError[], loaded: false, loading: false, error: "",
  /** Someone pressed "+" beside Apps: the Apps page puts the cursor in its form when it sees this. */
  wantCreate: false,
});

let pending: Promise<void> | undefined;
/** Reads the list again; calls made while one is in flight share it. */
export function refreshApps(): Promise<void> {
  if (pending) return pending;
  apps.loading = true;
  pending = (async () => {
    try {
      const result = await request<{ apps: HubApp[]; errors?: HubAppError[] }>("/hub/apps");
      apps.list = result.apps ?? [];
      apps.errors = result.errors ?? [];
      apps.error = "";
    } catch (cause) { apps.error = errorMessage(cause); }
    finally { apps.loaded = true; apps.loading = false; pending = undefined; }
  })();
  return pending;
}

export function findApp(workspaceId: string | undefined, slug: string | undefined): HubApp | undefined {
  return apps.list.find(app => app.workspace_id === workspaceId && app.slug === slug);
}

/** The address of an app's full-screen view: `/apps/<workspace id>/<slug>`. */
export function appPagePath(app: Pick<HubApp, "workspace_id" | "slug">): string {
  return `/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}`;
}

/** A folder name for an app: lowercase letters, digits and hyphens. */
export function slugify(name: string): string {
  const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return slug || "app";
}

/** A slug not taken in that workspace: `name`, `name-2`, … */
export function freeSlug(name: string, workspaceId: string, list: readonly HubApp[] = apps.list): string {
  const base = slugify(name), taken = new Set(list.filter(app => app.workspace_id === workspaceId).map(app => app.slug));
  let slug = base, n = 1;
  while (taken.has(slug)) slug = `${base}-${++n}`;
  return slug;
}

/** A colour for a new app, picked from its name so it stays the same if asked again. */
export function colorFor(name: string): AppColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return APP_COLORS[hash % APP_COLORS.length];
}

/** The pages a new app can start from (`builder.ts` describes them); `issues` is the list "Report a problem" makes. */
export type ScaffoldTemplate = "blank" | "kanban" | "table" | "calendar" | "dashboard" | "form" | "document" | "issues";
/** A new app (app.json + index.html) made by the host from a template. */
export async function scaffoldApp(workspaceId: string, body: { slug: string; name: string; description?: string; color?: AppColor; letter?: string; template?: ScaffoldTemplate }): Promise<HubApp> {
  const app = await request<HubApp>(`/hub/apps/${encodeURIComponent(workspaceId)}/scaffold`, json("POST", body));
  apps.list = [...apps.list.filter(item => !(item.workspace_id === app.workspace_id && item.slug === app.slug)), app];
  return app;
}

/** The convention, said in full, so an agent can build an app without the `tendly-apps` skill. */
export function appConvention(slug: string): string {
  return [
    "How Tendly apps work (the `tendly-apps` skill has the details, if you have it):",
    `- An app lives in its own folder in this workspace: \`apps/${slug}/\`.`,
    `- \`apps/${slug}/app.json\` describes it: {"name": string, "letter"?: one character for its tile, "color"?: one of ${APP_COLORS.map(color => `"${color}"`).join(", ")}, "description": one sentence, "entry"?: the page to open, "index.html" by default}.`,
    `- \`apps/${slug}/index.html\` is the page. Static files only (HTML, CSS, JavaScript, images): no build step, no server of its own, no package installs. Relative links between its files work.`,
    "- Include `<script src=\"/api/hub/apps/sdk.js\"></script>` and keep whatever the app needs to remember with `await tendly.data.get(key, fallback)`, `await tendly.data.set(key, value)`, `await tendly.data.list()` and `await tendly.data.remove(key)` (JSON values). It is stored in `apps/" + slug + "/data/`; do not use localStorage for data that matters.",
    "- For a list of things that change one at a time (leads, cards, tasks), use a collection instead of one big value: `const leads = tendly.db.collection('leads')`, then `await leads.list({ where: { stage: 'new' }, order: '-created_at', limit })`, `leads.get(id)`, `leads.insert(doc)`, `leads.update(id, patch, { rev })`, `leads.remove(id)` and `leads.subscribe(change => ...)`. A record is `{ id, rev, created_at, updated_at, data }`. Pass the `rev` you read when updating: if another pane or an agent changed the record meanwhile, the call rejects with `error.code === 'conflict'` and `error.current` (the record as it is now) instead of overwriting it. `subscribe` is how two open panes of the app stay in step.",
    "- Files a person adds (images, PDF, up to 20 MB): `const file = await tendly.files.upload(input.files[0])` returns `{ path, url, ... }`; keep `path` in a record and show it with `<img src=${tendly.files.url(path)}>`.",
    "- It runs in a sandboxed frame inside Tendly, as a page of its own: it cannot call Tendly's API with `fetch`, and `localStorage` does not persist there. Everything goes through `window.tendly` (the comment at the top of `/api/hub/apps/sdk.js` lists it all).",
    "- Make it responsive down to about 360px wide, and follow light and dark mode: `prefers-color-scheme`, and `:root[data-tendly-theme=\"dark\"]` / `[data-tendly-theme=\"light\"]`, which the SDK keeps in step with Tendly's own theme.",
    "- To read Tendly's own data or reach the person, ask for it in `app.json`, for example `\"permissions\": [\"sessions:read\", \"notify\"]` (also `files:read`, `automations:read`, `agent:draft`); the person is asked once when the app opens. `tendly.host.setContext({ view, selection, summary })` tells the chat what is on screen.",
    "- Tendly reloads the open app by itself a moment after its files change (never for `data/`), so there is no reload to ask for. If the app holds input the person has not saved, call `tendly.host.holdReload(true)` while that is so and `tendly.host.holdReload(false)` once it is saved. Errors (uncaught, unhandled rejections, `console.error`) are shown to the person in the app's header: use `console.error` for real failures only.",
  ].join("\n");
}

/** What the agent is asked when someone describes a new app. */
export function createPrompt(input: { name: string; description: string; slug: string }): string {
  return [
    `Build a small custom app for me in this workspace, called "${input.name.trim()}".`,
    "",
    "What it should do:",
    input.description.trim() || "(Not described yet: ask me what it should do before building.)",
    "",
    appConvention(input.slug),
    "",
    `Create \`apps/${input.slug}/app.json\` and \`apps/${input.slug}/index.html\` (plus any other static files it needs), keep it simple and usable, and tell me when it is ready: it appears under Apps in Tendly and opens on the Mesa.`,
  ].join("\n");
}
