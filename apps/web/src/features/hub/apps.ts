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
  /** The page a frame loads: `/api/hub/apps/<ws>/<slug>/files/<entry>`. */
  url: string;
  /** The app's folder in its workspace, `apps/<slug>/`. */
  code_path: string;
  updated_at: string;
}
/** An app folder the host could not read (a broken app.json, say). */
export interface HubAppError { workspace_id: string; slug: string; message: string }

/** Every app on this host, shared by the sidebar, Home, the Apps page and the app tabs. */
export const apps = reactive({ list: [] as HubApp[], errors: [] as HubAppError[], loaded: false, loading: false, error: "" });

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

/** A new app (app.json + index.html) made by the host: blank, or the list of problems (`issues`). */
export async function scaffoldApp(workspaceId: string, body: { slug: string; name: string; description?: string; color?: AppColor; template?: "blank" | "issues" }): Promise<HubApp> {
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
    "- It runs in a frame inside Tendly: make it responsive down to about 360px wide, and follow light and dark mode (`prefers-color-scheme`).",
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
