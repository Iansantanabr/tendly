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
  /** Configured but turned off, or never set up: listed apart, under "Not in use". */
  unused?: boolean;
}

/** A fixed English sentence (translated in the page); `path` fills `{path}`. */
export interface CatalogError { message: string; path?: string }

export interface IntegrationList {
  servers: Integration[];
  checked_at: string;
  errors: CatalogError[];
}

/** A variable a `.env` file assigns. Only the name ever leaves the server. */
export interface EnvName { name: string; /** Reads like a credential (`…_TOKEN`, `…_KEY`). */ secret: boolean }
export interface EnvFile { /** Relative to the project folder. */ path: string; names: EnvName[] }
export interface EnvWorkspace { workspace_id: string; workspace_name: string; files: EnvFile[]; truncated: boolean }

export async function loadEnvKeys() {
  return (await request<{ workspaces: EnvWorkspace[] }>("/hub/catalog/env-keys")).workspaces;
}

/** How many names read like keys, over every project and file. */
export function envKeyCount(workspaces: EnvWorkspace[]): number {
  return workspaces.reduce((sum, workspace) =>
    sum + workspace.files.reduce((inFile, file) => inFile + file.names.filter(name => name.secret).length, 0), 0);
}

/** A file's names in two lists: the ones that read like keys, and the rest. */
export function splitEnvNames(file: Pick<EnvFile, "names">): { keys: string[]; others: string[] } {
  return {
    keys: file.names.filter(name => name.secret).map(name => name.name),
    others: file.names.filter(name => !name.secret).map(name => name.name),
  };
}

/** What the `op` CLI on the server reports. Vault names only; no item, no token, no e-mail. */
export interface VaultInfo {
  installed: boolean;
  platform: "macos" | "linux" | "other";
  version?: string;
  signed_in: boolean;
  /** The sign-in address, such as `my.1password.com`. */
  account?: string;
  service_account: boolean;
  /** Whether the vaults were asked for (they are not while nobody is signed in, until the person asks). */
  listed: boolean;
  vaults: string[];
  /** A fixed English sentence, translated in the page. */
  error?: string;
}

/** `unlock` lists the vaults even when nobody is signed in, which makes 1Password ask for approval. */
export const loadVault = (unlock = false) => request<VaultInfo>(`/hub/catalog/vault${unlock ? "?unlock=1" : ""}`);

export const ONE_PASSWORD_CLI_URL = "https://developer.1password.com/docs/cli/get-started/";

/** Which of the three faces the vault section shows. */
export function vaultState(vault: Pick<VaultInfo, "installed" | "signed_in">): "missing" | "signed_out" | "signed_in" {
  if (!vault.installed) return "missing";
  return vault.signed_in ? "signed_in" : "signed_out";
}

export type SkillSource = "claude_user" | "claude_plugin" | "workspace" | "codex";

export interface Skill {
  /** Stable while the SKILL.md stays where it is; used to read its content. */
  id: string;
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

/** The servers agents can reach (whatever their health) and the ones that are off or never set up. */
export function splitByUse<T extends Pick<Integration, "unused">>(servers: T[]): { inUse: T[]; unused: T[] } {
  return { inUse: servers.filter(server => !server.unused), unused: servers.filter(server => server.unused) };
}

export function loadIntegrations(refresh = false) {
  return request<IntegrationList>(`/hub/catalog/integrations${refresh ? "?refresh=1" : ""}`);
}

export async function loadSkills() {
  return (await request<{ skills: Skill[] }>("/hub/catalog/skills")).skills;
}

export interface SkillContent { id: string; name: string; path: string; content: string; truncated: boolean }

export const loadSkillContent = (id: string) => request<SkillContent>(`/hub/catalog/skills/${encodeURIComponent(id)}/content`);

/** Where claude.ai connectors (and the plugins that bring them) are authorized. */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/settings/connectors";

/** A server that waits for sign-in and comes from the Claude account or a plugin is authorized in claude.ai. */
export function authorizeInClaudeAi(server: Pick<Integration, "status" | "source" | "plugin">): boolean {
  return server.status === "needs_auth" && (server.source === "claude_account" || !!server.plugin);
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

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** A skill's folder of origin: its group on the page and its entry in the folder filter. */
export interface SkillOrigin { key: string; label: string; values?: Record<string, string> }

const ORIGIN_ORDER: SkillSource[] = ["workspace", "claude_user", "claude_plugin", "codex"];

export function skillOrigin(skill: Skill, workspaceName: (skill: Skill) => string = s => s.workspace_name ?? ""): SkillOrigin {
  if (skill.source === "workspace") return { key: `workspace:${skill.workspace_id}`, label: "From the project {name}", values: { name: workspaceName(skill) } };
  if (skill.source === "claude_plugin") return { key: `plugin:${skill.plugin ?? ""}`, label: "Plugin {name}", values: { name: skill.plugin ?? "" } };
  if (skill.source === "codex") return { key: "codex", label: "Codex" };
  return { key: "user", label: "Installed by you" };
}

/** Skills in page order: projects, yours, plugins, Codex; then by project, plugin and name. */
export function sortSkills(skills: Skill[], workspaceName: (skill: Skill) => string = s => s.workspace_name ?? ""): Skill[] {
  return [...skills].sort((a, b) =>
    ORIGIN_ORDER.indexOf(a.source) - ORIGIN_ORDER.indexOf(b.source)
    || workspaceName(a).localeCompare(workspaceName(b))
    || (a.plugin ?? "").localeCompare(b.plugin ?? "")
    || a.name.localeCompare(b.name));
}

/** Each origin present once, in page order, with how many skills it has. */
export function skillOrigins(skills: Skill[], workspaceName?: (skill: Skill) => string): (SkillOrigin & { count: number })[] {
  return groupBy(sortSkills(skills, workspaceName), skill => skillOrigin(skill, workspaceName))
    .map(group => ({ key: group.key, label: group.label, values: group.values, count: group.items.length }));
}

/** The search and the folder filter together; an empty `origin` means every folder. */
export function filterSkills(skills: Skill[], query: string, origin = "", workspaceName?: (skill: Skill) => string): Skill[] {
  return skills.filter(skill => (!origin || skillOrigin(skill, workspaceName).key === origin) && matchesSkill(skill, query));
}

/** A SKILL.md without its YAML header, which the page shows apart. */
export function stripFrontMatter(text: string): string {
  const match = /^\uFEFF?---\r?\n(?:[\s\S]*?\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  return match ? text.slice(match[0].length).replace(/^\s*\n/, "") : text;
}

/** What "Use in chat" sends: use this skill by name, with what the person added. */
export function skillChatPrompt(skill: Pick<Skill, "name">, note: string, t: Translate): string {
  const extra = note.trim();
  if (!extra) return t("Use the skill {name}. Start by telling me in a few lines what it does and what you need from me.", { name: skill.name });
  return `${t("Use the skill {name} for this:", { name: skill.name })}\n\n${extra}`;
}

/**
 * A path short enough to read in a list: the home folder as `~`, and a long one
 * cut in the middle, keeping where it starts and the file it ends on
 * (`~/.claude/skills/…/SKILL.md`). The full path stays in the tooltip.
 */
export function shortPath(path: string, max = 48): string {
  const home = path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
  if (home.length <= max) return home;
  const sep = home.includes("/") ? "/" : "\\";
  const parts = home.split(sep);
  if (parts.length <= 4) return home;
  const head = parts.slice(0, 3).join(sep), tail = parts.slice(-2).join(sep);
  return `${head}${sep}…${sep}${tail}`;
}
