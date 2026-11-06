import { computed, reactive, type Ref } from "vue";
import type { LayoutDocument, LayoutNode } from "@tendly/protocol";
import { ApiError, errorMessage, json, request } from "../api";

/**
 * Named spaces: saved Mesa layouts reopened by name (`/api/hub/spaces`).
 * Opening one replaces the shared canvas through the server's revisioned
 * save, so a stale window gets the usual conflict bar instead of overwriting.
 */

export interface SpaceSummary { id: string; name: string; position: number; created_at: string; updated_at: string }
export interface Space extends SpaceSummary { layout: LayoutDocument }

export const SPACE_NAME_MAX = 80;
/** This browser's open space (per browser, like the canvas cache). */
export const ACTIVE_SPACE_KEY = "tendly.hub.space";
/** `/mesa?espaco=<id>` opens a space from a link. */
export const SPACE_QUERY = "espaco";

// ---------------------------------------------------------------------------
// Pure helpers

/** Why a name cannot be used, or "" when it can. Same rules as the server: trimmed, 1–80 characters, unique ignoring case. */
export function spaceNameError(name: string, spaces: readonly SpaceSummary[], exceptId?: string): string {
  const clean = name.trim();
  if (!clean) return "A space needs a name";
  if ([...clean].length > SPACE_NAME_MAX) return "Space names are at most 80 characters";
  const wanted = clean.toLowerCase();
  if (spaces.some(space => space.id !== exceptId && space.name.toLowerCase() === wanted)) return "A space with this name already exists";
  return "";
}

/**
 * The part of a layout a space is about: which panes, where, and how big.
 * Left out: the tab a stack shows in front, responsive projections, legacy
 * collapsed snapshots, temporary-window markers and tab titles (a tab takes
 * its session's new name on its own). Ratios are compared to two decimals so
 * a resize that snaps back does not count.
 */
export function layoutSignature(document: LayoutDocument): string {
  const node = (value: LayoutNode): unknown => {
    if (value.type === "split") return { t: "split", id: value.id, d: value.direction, r: Math.round(value.ratio * 100) / 100, a: node(value.first), b: node(value.second) };
    if (value.type === "stack") return { t: "stack", id: value.id, panes: value.panes.map(node) };
    const metadata = Object.entries(value.metadata ?? {}).filter(([key]) => key !== "ephemeral").sort(([a], [b]) => a.localeCompare(b));
    return { t: "pane", id: value.id, k: value.kind, m: canonical(Object.fromEntries(metadata)) };
  };
  return JSON.stringify({ v: document.version, root: node(document.root) });
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
/** The canvas no longer matches the space it was saved as. */
export function layoutDiffers(current: LayoutDocument, saved: LayoutDocument): boolean {
  return layoutSignature(current) !== layoutSignature(saved);
}

/** The space id a `/mesa?espaco=<id>` link asks for, if it looks like one. */
export function spaceFromQuery(query: Record<string, unknown>): string | undefined {
  const raw = query[SPACE_QUERY];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  return /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : undefined;
}
/** The same query without the space parameter, for `router.replace` once it was handled. */
export function withoutSpaceQuery<T extends Record<string, unknown>>(query: T): Partial<T> {
  const { [SPACE_QUERY]: _dropped, ...rest } = query;
  return rest as Partial<T>;
}
/** A link that opens this space on the Mesa. */
export function spaceLink(origin: string, id: string): string {
  return `${origin}/mesa?${SPACE_QUERY}=${encodeURIComponent(id)}`;
}

type SpaceStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem">>;
export function readActiveSpace(storage: SpaceStorage | undefined): string | undefined {
  try { return storage?.getItem(ACTIVE_SPACE_KEY) || undefined; } catch { return undefined; }
}
export function writeActiveSpace(storage: SpaceStorage | undefined, id: string | undefined): void {
  try {
    if (id) storage?.setItem(ACTIVE_SPACE_KEY, id);
    else if (storage?.removeItem) storage.removeItem(ACTIVE_SPACE_KEY);
    else storage?.setItem(ACTIVE_SPACE_KEY, "");
  } catch { /* the choice lasts this page only */ }
}

const copy = (document: LayoutDocument): LayoutDocument => JSON.parse(JSON.stringify(document));

// ---------------------------------------------------------------------------
// API

const path = (id: string) => `/hub/spaces/${encodeURIComponent(id)}`;
export const listSpaces = () => request<{ spaces: SpaceSummary[] }>("/hub/spaces").then(result => result.spaces ?? []);
export const getSpace = (id: string) => request<Space>(path(id));
export const createSpace = (name: string, layout: LayoutDocument) => request<Space>("/hub/spaces", json("POST", { name: name.trim(), layout }));
export const updateSpace = (id: string, patch: { name?: string; layout?: LayoutDocument; position?: number }) => request<Space>(path(id), json("PATCH", patch));
export const deleteSpace = (id: string) => request<void>(path(id), json("DELETE"));
export const openSpaceOnServer = (id: string, expectedRevision: number) =>
  request<{ revision: number; layout: LayoutDocument }>(path(id) + "/open", json("POST", { expected_revision: expectedRevision }));

// ---------------------------------------------------------------------------
// The Mesa's spaces, shared by every place the menu is shown

/** What the spaces need from the canvas persistence. */
export interface SpaceCanvas {
  layout: Ref<LayoutDocument>;
  revision: Readonly<Ref<number>>;
  conflict: Ref<boolean>;
  /** Send a change still waiting, so it is not lost to the open. */
  flush: () => Promise<void>;
  /** Put the layout the server just saved in place, at its revision. */
  adopt: (layout: LayoutDocument, revision: number) => Promise<void>;
}

export type SpaceControl = ReturnType<typeof useSpaces>;

export function useSpaces(canvas: SpaceCanvas, storage?: SpaceStorage) {
  const state = reactive({
    list: [] as SpaceSummary[],
    activeId: readActiveSpace(storage) as string | undefined,
    /** The active space's layout as last saved or opened. */
    saved: undefined as LayoutDocument | undefined,
    loaded: false,
    busy: false,
    error: "",
  });
  const active = computed(() => state.list.find(space => space.id === state.activeId));
  const dirty = computed(() => !!active.value && !!state.saved && layoutDiffers(canvas.layout.value, state.saved));

  function setActive(id: string | undefined, saved?: LayoutDocument) {
    state.activeId = id; state.saved = saved; writeActiveSpace(storage, id);
  }
  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    state.busy = true; state.error = "";
    try { return await work(); }
    catch (cause) { state.error = errorMessage(cause); return undefined; }
    finally { state.busy = false; }
  }

  async function refresh() {
    try {
      state.list = await listSpaces(); state.loaded = true;
      if (state.activeId && !state.list.some(space => space.id === state.activeId)) setActive(undefined);
      else if (state.activeId && !state.saved) {
        const id = state.activeId, space = await getSpace(id);
        if (state.activeId === id) state.saved = space.layout;
      }
    } catch (cause) { state.error = errorMessage(cause); }
  }
  const sortIn = (space: SpaceSummary) => {
    state.list = [...state.list.filter(entry => entry.id !== space.id), space]
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  };
  const summary = ({ layout: _layout, ...rest }: Space): SpaceSummary => rest;

  /** Saves the Mesa as it is now under a new name, and makes it the active space. */
  function saveAs(name: string) {
    return run(async () => {
      const layout = copy(canvas.layout.value);
      const space = await createSpace(name, layout);
      sortIn(summary(space)); setActive(space.id, space.layout);
      return space;
    });
  }
  /** Overwrites the active space with the Mesa as it is now. */
  function save() {
    const id = state.activeId;
    if (!id) return Promise.resolve(undefined);
    return run(async () => {
      const space = await updateSpace(id, { layout: copy(canvas.layout.value) });
      sortIn(summary(space)); if (state.activeId === id) state.saved = space.layout;
      return space;
    });
  }
  function rename(id: string, name: string) {
    return run(async () => { const space = await updateSpace(id, { name: name.trim() }); sortIn(summary(space)); return space; });
  }
  function remove(id: string) {
    return run(async () => {
      await deleteSpace(id);
      state.list = state.list.filter(space => space.id !== id);
      if (state.activeId === id) setActive(undefined);
      return true;
    });
  }
  /**
   * Opens a space as the shared canvas. A stale revision (another window or an
   * agent saved first) raises the canvas conflict bar and changes nothing.
   * Resolves "opened", "conflict" or "failed".
   */
  async function open(id: string): Promise<"opened" | "conflict" | "failed"> {
    if (canvas.conflict.value) return "conflict";
    state.busy = true; state.error = "";
    try {
      await canvas.flush();
      if (canvas.conflict.value) return "conflict";
      const opened = await openSpaceOnServer(id, canvas.revision.value);
      await canvas.adopt(opened.layout, opened.revision);
      setActive(id, opened.layout);
      if (!state.list.some(space => space.id === id)) void refresh();
      return "opened";
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) { canvas.conflict.value = true; return "conflict"; }
      state.error = errorMessage(cause);
      return "failed";
    } finally { state.busy = false; }
  }
  return { state, active, dirty, refresh, saveAs, save, rename, remove, open };
}
