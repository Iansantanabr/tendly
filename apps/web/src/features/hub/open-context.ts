import { reactive } from "vue";
import type { PaneNode } from "@tendly/protocol";

/** Something open on the Mesa that a conversation can take as context with one click. */
export interface OpenContext {
  workspaceId: string;
  path: string;
  name: string;
}

/** Kept current by App.vue from the canvas; read by every chat composer. */
export const openContext = reactive({ items: [] as OpenContext[] });

const meta = (pane: PaneNode, key: string) => {
  const value = (pane.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
};

/** Files open in editor or preview panes, in tab order, without duplicates. */
export function contextFromPanes(panes: PaneNode[]): OpenContext[] {
  const seen = new Set<string>(), items: OpenContext[] = [];
  for (const pane of panes) {
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
