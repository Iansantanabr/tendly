/**
 * Shortcuts: a site with a tile, beside the apps in the rail, the catalog and
 * Home. Kept on the server (`hub/shortcuts.rs`), which also says whether the
 * site lets itself be framed; here is the list, the calls, and the decision
 * of where a shortcut opens: a pane of the Mesa when it may, a tab of its own
 * otherwise, with the reason.
 */
import { reactive } from "vue";
import type { PaneNode } from "@tendly/protocol";
import { errorMessage, json, request } from "../api";
import { appColor, appLetter, type AppColor } from "./app-tile";

export interface ShortcutEmbed { allowed: boolean | null; reason: string | null; checked_at: string | null; reason_text?: string | null }
export interface Shortcut {
  id: string;
  name: string;
  url: string;
  letter: string;
  color: AppColor;
  position: number;
  embed: ShortcutEmbed;
  created_at: string;
  updated_at: string;
}

export const shortcuts = reactive({ list: [] as Shortcut[], loaded: false, loading: false, error: "", checkFreshSeconds: 24 * 3600 });

let pending: Promise<void> | undefined;
export function refreshShortcuts(): Promise<void> {
  if (pending) return pending;
  shortcuts.loading = true;
  pending = (async () => {
    try {
      const result = await request<{ shortcuts: Shortcut[]; check_fresh_seconds?: number }>("/hub/shortcuts");
      shortcuts.list = result.shortcuts ?? [];
      if (typeof result.check_fresh_seconds === "number") shortcuts.checkFreshSeconds = result.check_fresh_seconds;
      shortcuts.error = "";
    } catch (cause) { shortcuts.error = errorMessage(cause); }
    finally { shortcuts.loaded = true; shortcuts.loading = false; pending = undefined; }
  })();
  return pending;
}

function put(shortcut: Shortcut) {
  const at = shortcuts.list.findIndex(item => item.id === shortcut.id);
  if (at >= 0) shortcuts.list.splice(at, 1, shortcut); else shortcuts.list.push(shortcut);
  return shortcut;
}
export interface ShortcutInput { name: string; url: string; letter?: string; color?: AppColor }
export async function createShortcut(input: ShortcutInput): Promise<Shortcut> {
  return put(await request<Shortcut>("/hub/shortcuts", json("POST", input)));
}
export async function updateShortcut(id: string, input: Partial<ShortcutInput>): Promise<Shortcut> {
  return put(await request<Shortcut>(`/hub/shortcuts/${encodeURIComponent(id)}`, json("PATCH", input)));
}
export async function removeShortcut(id: string): Promise<void> {
  await request(`/hub/shortcuts/${encodeURIComponent(id)}`, { method: "DELETE" });
  shortcuts.list = shortcuts.list.filter(item => item.id !== id);
}
/** Asks the server to look at the site again; the verdict comes back with `reason_text`. */
export async function checkShortcut(id: string): Promise<Shortcut> {
  return put(await request<Shortcut>(`/hub/shortcuts/${encodeURIComponent(id)}/check`, { method: "POST" }));
}

// ---------------------------------------------------------------- where it opens

export type Opening = { where: "pane" } | { where: "tab"; reason: string };

/** Whether the verdict is recent enough to trust without asking the server again. */
export function verdictFresh(embed: ShortcutEmbed, freshSeconds: number, now = Date.now()): boolean {
  if (embed.allowed === null || !embed.checked_at) return false;
  const then = Date.parse(embed.checked_at);
  return Number.isFinite(then) && now - then < freshSeconds * 1000;
}

/** Loopback addresses are trusted by browsers even over http: no mixed content. */
function loopback(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, "").split(":")[0];
  return name === "localhost" || name.endsWith(".localhost") || name === "127.0.0.1" || name === "::1" || name.startsWith("127.");
}

/**
 * Pane or tab. A site that refuses framing, one the server could not reach,
 * and (when Tendly is on https) a plain-http site the browser would block as
 * mixed content, all open in a tab.
 */
export function shortcutOpening(shortcut: Pick<Shortcut, "url" | "embed">, pageProtocol: string, t: (text: string, values?: Record<string, string | number>) => string): Opening {
  let url: URL;
  try { url = new URL(shortcut.url); } catch { return { where: "tab", reason: t("The address could not be read.") }; }
  if (pageProtocol === "https:" && url.protocol === "http:" && !loopback(url.host)) {
    return { where: "tab", reason: t("Tendly is on https and this site is not: a browser does not show it inside a secure page.") };
  }
  const { allowed, reason } = shortcut.embed;
  if (allowed === true) return { where: "pane" };
  if (allowed === false) {
    const why = reason?.startsWith("x-frame-options") ? t("the site says it must not be shown inside another page (X-Frame-Options)")
      : reason?.startsWith("frame-ancestors") ? t("the site only lets some pages show it inside theirs (frame-ancestors), and Tendly is not one")
      : t("the site refuses to be framed");
    return { where: "tab", reason: t("Opened in a new tab: {why}.", { why }) };
  }
  return { where: "tab", reason: t("Opened in a new tab: Tendly could not reach the site to see whether it can be framed.") };
}

/** A shortcut as a pane of the Mesa: an `app` pane with `shortcut` in its metadata (`AppPane.vue` tells them apart). */
export function shortcutPane(shortcut: Shortcut, workspaceId: string): PaneNode {
  return {
    type: "pane", id: `shortcut-${encodeURIComponent(shortcut.id)}`, kind: "app", title: shortcut.name,
    metadata: { workspace_id: workspaceId, slug: `shortcut-${shortcut.id}`, shortcut: shortcut.id, name: shortcut.name, letter: appLetter(shortcut.letter, shortcut.name), color: appColor(shortcut.color), url: shortcut.url },
  };
}
export const shortcutKey = (shortcut: Pick<Shortcut, "id">) => `shortcut/${shortcut.id}`;
export const findShortcut = (id: string | undefined) => shortcuts.list.find(item => item.id === id);

/** The host of a shortcut's address, for the cards: `notion.so`. */
export function shortcutHost(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}
