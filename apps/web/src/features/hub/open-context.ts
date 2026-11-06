import { reactive } from "vue";
import type { PaneNode } from "@tendly/protocol";

/** Something open on the Mesa that a conversation can take as context with one click. */
export interface OpenContext {
  workspaceId: string;
  path: string;
  name: string;
}

const state = reactive({ canvas: [] as OpenContext[], page: [] as OpenContext[] });
const sameItem = (a: OpenContext, b: OpenContext) => a.workspaceId === b.workspaceId && a.path === b.path;
/**
 * What every chat composer offers as context. `items` is what is open on the
 * Mesa (App.vue assigns it from the canvas) after what the page over it shows:
 * the app of the full-screen view, which is not a tab of the Mesa.
 */
export const openContext = {
  get items(): OpenContext[] { return [...state.page, ...state.canvas.filter(item => !state.page.some(shown => sameItem(shown, item)))]; },
  set items(value: OpenContext[]) { state.canvas = value; },
};
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
