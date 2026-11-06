import { reactive } from "vue";
import type { PaneNode } from "@tendly/protocol";
import { appContext, appFolderSlug, contextName, contextNote } from "./app-context";

/** Something open on the Mesa that a conversation can take as context with one click. */
export interface OpenContext {
  workspaceId: string;
  path: string;
  name: string;
  /** Lines the message carries under the path: what an app says is on its screen. */
  note?: string;
}

const state = reactive({ canvas: [] as OpenContext[], page: [] as OpenContext[] });
const sameItem = (a: OpenContext, b: OpenContext) => a.workspaceId === b.workspaceId && a.path === b.path;
/**
 * What every chat composer offers as context. `items` is what is open on the
 * Mesa (App.vue assigns it from the canvas) after what the page over it shows:
 * the app of the full-screen view, which is not a tab of the Mesa.
 */
export const openContext = {
  get items(): OpenContext[] { return [...state.page, ...state.canvas.filter(item => !state.page.some(shown => sameItem(shown, item)))].map(withAppContext); },
  set items(value: OpenContext[]) { state.canvas = value; },
};
/** An app that said what is on its screen is offered as "App · view", with that as its note. */
function withAppContext(item: OpenContext): OpenContext {
  const slug = appFolderSlug(item.path), context = slug ? appContext(`${item.workspaceId}/${slug}`) : undefined;
  return context ? { ...item, name: contextName(item.name, context), note: contextNote(item.name, context) } : item;
}

/**
 * The chips already attached to a composer, brought up to date with what the
 * apps they name say now (an app moved to another view after it was
 * attached). Undefined when nothing changed, so a watcher can do nothing.
 */
export function refreshedContext<T extends { path: string; name: string; note?: string }>(attached: readonly T[], items: readonly OpenContext[], workspaceId: string): T[] | undefined {
  let changed = false;
  const next = attached.map(file => {
    if (!appFolderSlug(file.path)) return file;
    const item = items.find(open => open.workspaceId === workspaceId && open.path === file.path);
    if (!item || (item.name === file.name && item.note === file.note)) return file;
    changed = true;
    const { note: _dropped, ...rest } = file;
    return { ...rest, name: item.name, ...(item.note ? { note: item.note } : {}) } as T;
  });
  return changed ? next : undefined;
}
/** What the page on screen shows (the full-screen app); empty when it shows nothing of the kind. */
export function setPageContext(items: OpenContext[]) { state.page = items; }

const meta = (pane: PaneNode, key: string) => {
  const value = (pane.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Files open in editor or preview panes, and apps open in app panes, in tab
 * order, without duplicates. An app is offered as its folder (`apps/<slug>/`),
 * which a message names like any attached path.
 */
export function contextFromPanes(panes: PaneNode[]): OpenContext[] {
  const seen = new Set<string>(), items: OpenContext[] = [];
  for (const pane of panes) {
    if (pane.kind === "app") {
      const workspaceId = meta(pane, "workspace_id"), slug = meta(pane, "slug");
      if (!workspaceId || !slug) continue;
      const path = `apps/${slug}/`, key = `${workspaceId}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ workspaceId, path, name: meta(pane, "name") || pane.title || slug });
      continue;
    }
    if (pane.kind !== "editor" && pane.kind !== "file_preview") continue;
    const workspaceId = meta(pane, "workspace_id"), path = meta(pane, "path");
    if (!workspaceId || !path || meta(pane, "checkout")) continue;
    const key = `${workspaceId}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ workspaceId, path, name: path.split("/").pop() || path });
  }
  return items;
}
