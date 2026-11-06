import { request } from "../api";

/** Where an MCP server comes from, as the server reports it. */
export type IntegrationSource = "claude_account" | "claude_user" | "claude_project" | "codex" | "workspace";
export type IntegrationStatus = "connected" | "needs_auth" | "failed" | "unknown";

export interface Integration {
  name: string;
  source: IntegrationSource;
  workspace_id?: string;
  workspace_name?: string;
  /** The Claude Code plugin that brings this server. */
  plugin?: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** The command or URL, with credentials already removed by the server. */
  target: string;
  status: IntegrationStatus;
  detail?: string;
}

/** A fixed English sentence (translated in the page); `path` fills `{path}`. */
export interface CatalogError { message: string; path?: string }

export interface IntegrationList {
  servers: Integration[];
  checked_at: string;
  errors: CatalogError[];
}

export type SkillSource = "claude_user" | "claude_plugin" | "workspace" | "codex";

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
  plugin?: string;
  workspace_id?: string;
  workspace_name?: string;
  /** Absolute path of the SKILL.md. */
  path: string;
  /** Relative to the workspace, for workspace skills. */
  rel_path?: string;
}

export function loadIntegrations(refresh = false) {
  return request<IntegrationList>(`/hub/catalog/integrations${refresh ? "?refresh=1" : ""}`);
}

export async function loadSkills() {
  return (await request<{ skills: Skill[] }>("/hub/catalog/skills")).skills;
}

export interface Group<T> { key: string; label: string; values?: Record<string, string>; items: T[] }

/** Items grouped in first-seen order; `keyOf` names the group and its label. */
export function groupBy<T>(items: T[], keyOf: (item: T) => { key: string; label: string; values?: Record<string, string> }): Group<T>[] {
  const groups = new Map<string, Group<T>>();
  for (const item of items) {
    const { key, label, values } = keyOf(item);
    let group = groups.get(key);
    if (!group) { group = { key, label, values, items: [] }; groups.set(key, group); }
    group.items.push(item);
  }
  return [...groups.values()];
}

/** Lower-case text match over a skill's name, description and plugin. */
export function matchesSkill(skill: Skill, query: string) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = `${skill.name} ${skill.description} ${skill.plugin ?? ""} ${skill.workspace_name ?? ""}`.toLowerCase();
  return words.every(word => text.includes(word));
}
