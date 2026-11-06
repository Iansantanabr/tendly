/**
 * The person's arrangement of their apps: which come first (pinned), in what
 * order the rest follow, and which are left out of the quick places (hidden).
 * One arrangement for the icon rail, the sidebar list and the Apps card on
 * Home; the Apps catalog shows every app, hidden ones included.
 *
 * It is kept with the hub settings (`app_order`), so it follows the person to
 * another browser. Every entry is `<workspace id>/<slug>`.
 */
import { computed, ref } from "vue";
import { errorMessage } from "../api";
import { apps } from "./apps";
import { hubSettings, saveHubSettings } from "./settings";

export interface AppOrder {
  /** First, in this order. */
  pinned: string[];
  /** The rest, in this order; apps not named here come after, the latest changed first. */
  order: string[];
  /** Left out of the rail, the sidebar list and Home. */
  hidden: string[];
}
export const EMPTY_ORDER: Readonly<AppOrder> = Object.freeze({ pinned: [], order: [], hidden: [] });

/** What the order needs to know of an app. */
export interface OrderedApp { workspace_id: string; slug: string; updated_at?: string | null }

export const appKey = (app: { workspace_id: string; slug: string }) => `${app.workspace_id}/${app.slug}`;

const keys = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.includes("/")))] : [];

/** An arrangement read from anywhere (the server, an older build): always three lists, a hidden app never pinned. */
export function tidyOrder(value: unknown): AppOrder {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const hidden = keys(source.hidden);
  return { pinned: keys(source.pinned).filter(key => !hidden.includes(key)), order: keys(source.order), hidden };
}

interface Groups<T> { pinned: T[]; rest: T[]; hidden: T[] }

function groups<T extends OrderedApp>(list: readonly T[], prefs: AppOrder): Groups<T> {
  const place = (keysInOrder: readonly string[]) => new Map(keysInOrder.map((key, index) => [key, index]));
  const pinnedAt = place(prefs.pinned), orderAt = place(prefs.order), hiddenSet = new Set(prefs.hidden);
  const recent = (a: T, b: T) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "") || appKey(a).localeCompare(appKey(b));
  const pinned: T[] = [], listed: T[] = [], loose: T[] = [], hidden: T[] = [];
  for (const app of list) {
    const key = appKey(app);
    if (hiddenSet.has(key)) hidden.push(app);
    else if (pinnedAt.has(key)) pinned.push(app);
    else if (orderAt.has(key)) listed.push(app);
    else loose.push(app);
  }
  pinned.sort((a, b) => pinnedAt.get(appKey(a))! - pinnedAt.get(appKey(b))!);
  listed.sort((a, b) => orderAt.get(appKey(a))! - orderAt.get(appKey(b))!);
  return { pinned, rest: [...listed, ...loose.sort(recent)], hidden: hidden.sort(recent) };
}

/** The apps to show, in the person's order: pinned, then arranged, then the rest by latest change. Hidden ones are left out. */
export function arrangeApps<T extends OrderedApp>(list: readonly T[], prefs: AppOrder): T[] {
  const { pinned, rest } = groups(list, prefs);
  return [...pinned, ...rest];
}

/** The apps the person hid, for the catalog. */
export function hiddenApps<T extends OrderedApp>(list: readonly T[], prefs: AppOrder): T[] {
  return groups(list, prefs).hidden;
}

export const isPinnedApp = (prefs: AppOrder, key: string) => prefs.pinned.includes(key) && !prefs.hidden.includes(key);
export const isHiddenApp = (prefs: AppOrder, key: string) => prefs.hidden.includes(key);

/** Whether an app has a neighbour to trade places with in that direction: pinned apps move among themselves, and so do the rest. */
export function canMoveApp(list: readonly OrderedApp[], prefs: AppOrder, key: string, by: -1 | 1): boolean {
  const { pinned, rest } = groups(list, prefs);
  for (const group of [pinned, rest]) {
    const index = group.findIndex(app => appKey(app) === key);
    if (index >= 0) return index + by >= 0 && index + by < group.length;
  }
  return false;
}

/**
 * The arrangement after an app trades places with its neighbour. The first
 * move writes down the order everything is shown in, so nothing else jumps.
 * Entries for apps that are not in the list right now (a project that is
 * offline, say) are kept at the end.
 */
export function moveApp(list: readonly OrderedApp[], prefs: AppOrder, key: string, by: -1 | 1): AppOrder {
  if (!canMoveApp(list, prefs, key, by)) return prefs;
  const { pinned, rest } = groups(list, prefs);
  const swapped = (group: OrderedApp[]) => {
    const next = group.map(appKey), index = next.indexOf(key);
    [next[index], next[index + by]] = [next[index + by], next[index]];
    return next;
  };
  const withAbsent = (present: string[], before: readonly string[]) => [...present, ...before.filter(entry => !present.includes(entry))];
  if (pinned.some(app => appKey(app) === key)) return { ...prefs, pinned: withAbsent(swapped(pinned), prefs.pinned) };
  return { ...prefs, order: withAbsent(swapped(rest), prefs.order) };
}

/** Pinned apps come first; pinning shows a hidden app again. */
export function setAppPinned(prefs: AppOrder, key: string, pinned: boolean): AppOrder {
  const without = prefs.pinned.filter(entry => entry !== key);
  return pinned ? { ...prefs, pinned: [...without, key], hidden: prefs.hidden.filter(entry => entry !== key) } : { ...prefs, pinned: without };
}

/** A hidden app leaves the rail, the sidebar list and Home (and stops being pinned); it stays in the catalog. */
export function setAppHidden(prefs: AppOrder, key: string, hidden: boolean): AppOrder {
  const without = prefs.hidden.filter(entry => entry !== key);
  return hidden ? { ...prefs, hidden: [...without, key], pinned: prefs.pinned.filter(entry => entry !== key) } : { ...prefs, hidden: without };
}

// ---------------------------------------------------------------------------
// The arrangement in use

export const appOrder = computed(() => tidyOrder(hubSettings.value?.app_order));
/** Every visible app, in the person's order. */
export const arrangedApps = computed(() => arrangeApps(apps.list, appOrder.value));
export const hiddenAppList = computed(() => hiddenApps(apps.list, appOrder.value));
/** Why the last change was not saved, shown by whichever menu made it. */
export const appOrderError = ref("");

let latest = 0;
/** Shows the new arrangement at once and saves it; if saving fails, what was there comes back. */
export async function changeAppOrder(next: AppOrder, save: (order: AppOrder) => Promise<unknown> = order => saveHubSettings({ app_order: order })): Promise<boolean> {
  const before = hubSettings.value, own = ++latest;
  appOrderError.value = "";
  if (before) hubSettings.value = { ...before, app_order: next };
  try { await save(next); return true; }
  catch (cause) {
    // A later change is already on screen: leave it; only the last one is undone.
    if (own === latest && before && hubSettings.value) hubSettings.value = { ...hubSettings.value, app_order: tidyOrder(before.app_order) };
    appOrderError.value = errorMessage(cause);
    return false;
  }
}
