/**
 * The icon rail: on the Mesa, on a desktop-width window, the global navigation
 * is a narrow column of icons and the Workspaces/Conversations panel is a
 * column of its own beside it. Everywhere else (Home, the pages, a phone's
 * drawer) the sidebar stays expanded.
 *
 * This file holds what the rail decides; `IconRail.vue` draws it.
 */
import { computed, ref, watch } from "vue";
import type { PaneNode } from "@tendly/protocol";
import { errorMessage } from "../api";
import { hubSettings, saveHubSettings, type MesaSidebar } from "./settings";

/** Where a rail item goes. */
export type RailTarget = "home" | "canvas" | "skills" | "integrations" | "automations" | "apps" | "inbox" | "settings" | "sessions" | "usage" | "system";
export interface RailItem { id: RailTarget; label: string; icon: string }

/** The global navigation, top of the rail, in this order. */
export const RAIL_NAV: readonly RailItem[] = [
  { id: "home", label: "Home", icon: "home" },
  { id: "canvas", label: "Workspace canvas", icon: "grid" },
  { id: "skills", label: "Skills", icon: "sparkles" },
  { id: "integrations", label: "Integrations", icon: "plug" },
  { id: "automations", label: "Automations", icon: "timer" },
];
/** Pages the expanded sidebar lists and the rail has no icon for: they sit behind "More". */
export const RAIL_MORE: readonly RailItem[] = [
  { id: "sessions", label: "All sessions", icon: "clock" },
  { id: "usage", label: "Usage", icon: "chart" },
  { id: "system", label: "System", icon: "gauge" },
];

/**
 * Which sidebar a window gets. The rail is for the Mesa, and only where the
 * sidebar is a column: below that width it is a drawer, left as it was. An
 * app in full screen (`app`) keeps the rail alone, whatever the preference
 * says about the Mesa: the page is the app's.
 */
export function sidebarLayout(input: { page?: string; wide: boolean; mobile: boolean; preference: MesaSidebar }): "rail" | "expanded" | "app" {
  if (!input.wide || input.mobile) return "expanded";
  if (input.page === "app") return "app";
  return !input.page && input.preference === "icons" ? "rail" : "expanded";
}

/** Where an arrow key moves within the rail, or undefined for any other key. The ends wrap. */
export function rovingIndex(key: string, index: number, count: number): number | undefined {
  if (count <= 0) return undefined;
  if (key === "ArrowDown") return index < 0 ? 0 : (index + 1) % count;
  if (key === "ArrowUp") return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}

/** A key that asks for an item's options: the menu key, Shift+F10, or the arrow pointing at where the menu opens. */
export function opensOptions(event: { key: string; shiftKey?: boolean }): boolean {
  return event.key === "ContextMenu" || event.key === "ArrowRight" || (event.key === "F10" && !!event.shiftKey);
}

/** The app an app pane shows, as `<workspace id>/<slug>`; undefined for any other pane. */
export function appPaneKey(pane: Pick<PaneNode, "kind" | "metadata"> | undefined): string | undefined {
  if (pane?.kind !== "app") return undefined;
  const workspace = pane.metadata?.workspace_id, slug = pane.metadata?.slug;
  return typeof workspace === "string" && typeof slug === "string" && workspace && slug ? `${workspace}/${slug}` : undefined;
}

/** Every app with a tab open on the Mesa. */
export function openAppKeys(panes: readonly Pick<PaneNode, "kind" | "metadata">[]): string[] {
  return [...new Set(panes.map(appPaneKey).filter((key): key is string => !!key))];
}

/**
 * Where something that flies out of the rail goes: to the right of its item,
 * level with it, pulled up when it would run past the bottom of the window.
 */
export function flyoutPlace(anchor: { top: number; right: number; height: number }, viewportHeight: number, height = 0, gap = 8): { left: number; top: number } {
  const lowest = Math.max(gap, viewportHeight - height - gap);
  return { left: Math.round(anchor.right + gap), top: Math.round(Math.min(Math.max(gap, anchor.top), lowest)) };
}

/** The number on the bell: nothing at zero, capped so it fits the badge. */
export function badgeText(count: number | undefined): string {
  if (!count || count < 1) return "";
  return count > 99 ? "99+" : String(Math.floor(count));
}

// ---------------------------------------------------------------------------
// The preference

const STORAGE = "tendly.hub.mesa-sidebar";
const asChoice = (value: unknown): MesaSidebar | undefined => value === "icons" || value === "expanded" ? value : undefined;
function stored(): MesaSidebar | undefined {
  try { return typeof localStorage === "undefined" ? undefined : asChoice(localStorage.getItem(STORAGE)); } catch { return undefined; }
}
/** What this browser saw last, used until the server answers so the Mesa does not open one way and flip to the other. */
const lastSeen = ref<MesaSidebar | undefined>(stored());
watch(() => asChoice(hubSettings.value?.mesa_sidebar), value => {
  if (!value) return;
  lastSeen.value = value;
  try { if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE, value); } catch { /* Fine without it. */ }
}, { immediate: true });

/** How the sidebar looks on the Mesa: the saved choice, else what this browser saw last, else icons. */
export const mesaSidebar = computed<MesaSidebar>(() => asChoice(hubSettings.value?.mesa_sidebar) ?? lastSeen.value ?? "icons");

/**
 * Saves the choice; the sidebar changes once the server has it (the rail and
 * the full sidebar are different components, so a change that had to be taken
 * back would lose its own error message). Returns why it could not be saved,
 * or "" when it was.
 */
export async function setMesaSidebar(value: MesaSidebar, save: (value: MesaSidebar) => Promise<unknown> = choice => saveHubSettings({ mesa_sidebar: choice })): Promise<string> {
  try {
    await save(value);
    // A server that answered without the setting (an older one) still gets the choice for this page.
    if (hubSettings.value && asChoice(hubSettings.value.mesa_sidebar) !== value) hubSettings.value = { ...hubSettings.value, mesa_sidebar: value };
    lastSeen.value = value;
    return "";
  } catch (cause) { return errorMessage(cause); }
}
