/**
 * Versions of a whole app (`hub/apps/versions.rs`): each burst of changes to
 * `apps/<slug>/` (one agent turn, your saves) as one entry, and "Restore the
 * app to this version", which writes new file versions and deletes nothing.
 */
import { request } from "../api";
import type { HubApp } from "./apps";

export interface AppVersion {
  id: number;
  author_kind: "you" | "agent" | "unknown";
  session_id: string | null;
  session_title: string | null;
  message: string | null;
  started_at: string;
  at: string;
  files: string[];
  count: number;
  current: boolean;
}
export interface RestoreOutcome { restored: string[]; removed: string[]; unchanged: string[]; skipped: { path: string; reason: string }[] }

type AppId = Pick<HubApp, "workspace_id" | "slug">;
const base = (app: AppId) => `/hub/apps/${encodeURIComponent(app.workspace_id)}/${encodeURIComponent(app.slug)}/versions`;

export function listVersions(app: AppId): Promise<{ versions: AppVersion[]; truncated: boolean }> {
  return request(base(app));
}
export function restoreVersion(app: AppId, id: number): Promise<RestoreOutcome> {
  return request(`${base(app)}/${id}/restore`, { method: "POST" });
}

type Translate = (text: string, values?: Record<string, string | number>) => string;

/** Who made the version, as a short label. */
export function authorLabel(version: Pick<AppVersion, "author_kind" | "session_title">, t: Translate): string {
  if (version.author_kind === "agent") return version.session_title ? t("Agent · {conversation}", { conversation: version.session_title }) : t("Agent");
  if (version.author_kind === "you") return t("You");
  return t("Outside Tendly");
}

/** What the version did, in one line: what the agent said, else the files. */
export function versionTitle(version: Pick<AppVersion, "message" | "files" | "count">, t: Translate): string {
  if (version.message) return version.message;
  const [first, second] = version.files;
  if (version.count === 1 && first) return first;
  if (version.count === 2 && first && second) return `${first}, ${second}`;
  return t("{count} files", { count: version.count });
}

/** The files, for a tooltip: up to the first forty, then "…". */
export function filesTitle(version: Pick<AppVersion, "files" | "count">): string {
  return version.files.join("\n") + (version.count > version.files.length ? "\n…" : "");
}

/** What a restore did, in one sentence for a toast. */
export function restoreSummary(outcome: RestoreOutcome, t: Translate): string {
  const parts: string[] = [];
  if (outcome.restored.length) parts.push(t("{count} restored", { count: outcome.restored.length }));
  if (outcome.removed.length) parts.push(t("{count} removed", { count: outcome.removed.length }));
  if (outcome.skipped.length) parts.push(t("{count} left as they are", { count: outcome.skipped.length }));
  if (!parts.length) return t("The app was already at that version.");
  return t("App restored: {what}.", { what: parts.join(", ") });
}
