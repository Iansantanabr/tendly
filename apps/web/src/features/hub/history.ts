/** File history: the versions Tendly keeps of a file, and a line diff
 * between two of them in the unified form `GitDiffLines` draws. */
import { request } from "../api";

export type Translate = (text: string, values?: Record<string, string | number>) => string;

export interface FileVersion {
  id: number;
  workspace_id: string;
  path: string;
  size: number;
  author_kind: "you" | "agent" | "unknown";
  session_id: string | null;
  session_title?: string | null;
  created_at: string;
}
export interface FileVersionContent extends FileVersion { content: string; }

export const listVersions = (workspaceId: string, path: string) =>
  request<{ versions: FileVersion[] }>(`/hub/history?workspace_id=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`).then(body => body.versions);
export const readVersion = (id: number) => request<FileVersionContent>(`/hub/history/versions/${id}`);
export const restoreVersion = (id: number) => request<FileVersion>(`/hub/history/versions/${id}/restore`, { method: "POST" });
export const readCurrent = (workspaceId: string, path: string) =>
  request<{ content: string }>(`/workspaces/${encodeURIComponent(workspaceId)}/file?path=${encodeURIComponent(path)}`).then(file => file.content);

/** Who made a version, as the list names them. */
export function authorLabel(version: Pick<FileVersion, "author_kind" | "session_title">, t: Translate): string {
  if (version.author_kind === "you") return t("You");
  if (version.author_kind === "agent") return version.session_title ? t("Agent · {title}", { title: version.session_title }) : t("Agent");
  return t("Outside Tendly");
}

/** The conversation an agent's version came from, when there is one to open. */
export function conversationOf(version: Pick<FileVersion, "author_kind" | "session_id">): string | null {
  return version.author_kind === "agent" && version.session_id ? version.session_id : null;
}

export function ago(iso: string, t: Translate, now = Date.now()): string {
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("just now");
  if (seconds < 3600) return t("{count} min ago", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{count} h ago", { count: Math.floor(seconds / 3600) });
  if (seconds < 30 * 86400) return t("{count} d ago", { count: Math.floor(seconds / 86400) });
  return new Date(iso).toLocaleDateString();
}

export const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

type Op = { kind: " " | "-" | "+"; text: string };
/** Past this many cells the middle is shown as replaced outright. */
const MAX_CELLS = 4_000_000;

/** Line operations turning `before` into `after`: longest common subsequence
 * of what is left once the shared start and end are set aside. */
export function lineOps(before: string, after: string): Op[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const head: Op[] = a.slice(0, start).map(text => ({ kind: " ", text }));
  const tail: Op[] = a.slice(endA).map(text => ({ kind: " ", text }));
  const x = a.slice(start, endA), y = b.slice(start, endB);
  const n = x.length, m = y.length;
  const middle: Op[] = [];
  if (n * m > MAX_CELLS) {
    middle.push(...x.map(text => ({ kind: "-" as const, text })), ...y.map(text => ({ kind: "+" as const, text })));
  } else {
    // lengths[i][j]: the LCS of x[i..] and y[j..], one flat row-major array.
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = x[i] === y[j] ? lengths[(i + 1) * width + j + 1] + 1 : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { middle.push({ kind: " ", text: x[i] }); i++; j++; }
      else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) middle.push({ kind: "-", text: x[i++] });
      else middle.push({ kind: "+", text: y[j++] });
    }
    while (i < n) middle.push({ kind: "-", text: x[i++] });
    while (j < m) middle.push({ kind: "+", text: y[j++] });
  }
  return [...head, ...middle, ...tail];
}

/** A unified diff of two texts with `context` lines around each change;
 * empty when they are the same. */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const ops = lineOps(before, after);
  const changed = ops.map((op, index) => op.kind !== " " ? index : -1).filter(index => index >= 0);
  if (!changed.length) return "";
  // Ranges of ops to show, merged where their context touches.
  const ranges: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - context), to = Math.min(ops.length, index + context + 1);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  // Line numbers where each op starts, on both sides.
  const starts: [number, number][] = [];
  let lineA = 1, lineB = 1;
  for (const op of ops) {
    starts.push([lineA, lineB]);
    if (op.kind !== "+") lineA++;
    if (op.kind !== "-") lineB++;
  }
  const out: string[] = [];
  for (const [from, to] of ranges) {
    const slice = ops.slice(from, to);
    const countA = slice.filter(op => op.kind !== "+").length, countB = slice.filter(op => op.kind !== "-").length;
    const [startA, startB] = starts[from];
    out.push(`@@ -${countA ? startA : startA - 1},${countA} +${countB ? startB : startB - 1},${countB} @@`);
    for (const op of slice) out.push(op.kind + op.text);
  }
  return out.join("\n");
}
