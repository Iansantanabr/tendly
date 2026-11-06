import { reactive } from "vue";
import type { EndpointProfile, ProviderKind, Session } from "@tendly/protocol";
import { request } from "../api";
import { offeredModels } from "../model-choices";
import { modelEfforts } from "../reasoning-effort";
import { agentClient } from "../clients";
import { accountLimitPercent, quotaShortTitle, type AccountView } from "../account-ui";
import type { SessionActivity } from "./inbox";

type Translate = (text: string, values?: Record<string, string | number>) => string;
type Activity = Record<string, Pick<SessionActivity, "last_turn_at"> | undefined>;

// ---------------------------------------------------------------------------
// "Continue …" on the home page

/** When a conversation last did something: its last turn, else its own update time. */
export function lastActivity(session: Pick<Session, "id" | "updated_at">, activity: Activity): number {
  const at = activity[session.id]?.last_turn_at ?? session.updated_at;
  const time = at ? Date.parse(at) : NaN;
  return Number.isFinite(time) ? time : 0;
}

/** The conversation to pick up again: the one active most recently, never an archived one or a terminal. */
export function continueTarget<T extends Pick<Session, "id" | "updated_at" | "archived_at" | "provider">>(sessions: readonly T[], activity: Activity): T | undefined {
  let best: T | undefined, bestAt = -1;
  for (const session of sessions) {
    if (session.archived_at || session.provider === "terminal") continue;
    const at = lastActivity(session, activity);
    if (at > bestAt) { best = session; bestAt = at; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Recent routines in the conversation bar

/** A conversation an agent routine opened (`GET /hub/automations/recent-sessions`). */
export interface RecentRoutine {
  session_id: string;
  automation_id: string;
  automation_name: string;
  started_at: string;
  status: string;
}

export const routines = reactive({ items: [] as RecentRoutine[] });

/** Asked when the bar opens and whenever the inbox gets a new entry (a routine that ran adds one). */
export async function refreshRoutines() {
  try { routines.items = (await request<{ items: RecentRoutine[] }>("/hub/automations/recent-sessions?limit=10")).items; }
  catch { /* An older backend has no routines: the group simply does not show. */ }
}

/** The routine that opened each conversation, newest first wins. */
export function routineBySession(items: readonly RecentRoutine[]): Map<string, RecentRoutine> {
  const map = new Map<string, RecentRoutine>();
  for (const item of items) if (!map.has(item.session_id)) map.set(item.session_id, item);
  return map;
}

export type ConversationGroupKey = "unread" | "waiting" | "running" | "routines" | "rest";
export interface ConversationGroup<T> { key: ConversationGroupKey; label: string; items: T[] }

/**
 * The bar's groups, by what each conversation needs from you. Conversations
 * without a project are listed, plus the ones a routine opened wherever they
 * run; a routine's conversation that needs nothing goes under "Recent routines"
 * rather than "Your conversations".
 */
export function groupConversations<T extends Pick<Session, "id" | "title" | "status" | "workspace_id" | "updated_at" | "archived_at" | "provider">>(options: {
  sessions: readonly T[];
  workspaceId: string;
  routines: Map<string, RecentRoutine>;
  activity: Activity;
  isUnread: (id: string) => boolean;
  query?: string;
}): ConversationGroup<T>[] {
  const q = (options.query ?? "").trim().toLowerCase();
  const listed = options.sessions
    .filter(s => !s.archived_at && s.provider !== "terminal" && (s.workspace_id === options.workspaceId || options.routines.has(s.id)))
    .filter(s => !q || s.title.toLowerCase().includes(q) || !!options.routines.get(s.id)?.automation_name.toLowerCase().includes(q))
    .sort((a, b) => lastActivity(b, options.activity) - lastActivity(a, options.activity));
  const groups: Record<ConversationGroupKey, T[]> = { unread: [], waiting: [], running: [], routines: [], rest: [] };
  for (const s of listed) {
    if (s.status === "waiting") groups.waiting.push(s);
    else if (s.status === "running" || s.status === "starting") groups.running.push(s);
    else if (options.isUnread(s.id)) groups.unread.push(s);
    else if (options.routines.has(s.id)) groups.routines.push(s);
    else groups.rest.push(s);
  }
  const labels: Record<ConversationGroupKey, string> = {
    unread: "Unread", waiting: "Waiting for your reply", running: "Running now", routines: "Recent routines", rest: "Your conversations",
  };
  return (["unread", "waiting", "running", "routines", "rest"] as const)
    .map(key => ({ key, label: labels[key], items: groups[key] }))
    .filter(g => g.items.length);
}

// ---------------------------------------------------------------------------
// The home composer's account, model, effort and permission

/** What the composer remembers per agent; "" means the default for that field. */
export interface AgentChoice { endpoint?: string; model?: string; effort?: string; permission?: string }
export interface HomeMemory { provider?: ProviderKind; workspace?: string; agents?: Partial<Record<ProviderKind, AgentChoice>> }

const text = (value: unknown) => typeof value === "string" ? value : undefined;

/** The stored `tendly.hub.home` object, or nothing usable in it. */
export function readHomeMemory(raw: string | null | undefined): HomeMemory {
  let value: unknown;
  try { value = JSON.parse(raw ?? "{}"); } catch { return {}; }
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const memory: HomeMemory = {};
  if (source.provider === "claude_code" || source.provider === "codex") memory.provider = source.provider;
  if (text(source.workspace)) memory.workspace = source.workspace as string;
  if (source.agents && typeof source.agents === "object") {
    memory.agents = {};
    for (const [provider, choice] of Object.entries(source.agents as Record<string, unknown>)) {
      if (!choice || typeof choice !== "object") continue;
      const c = choice as Record<string, unknown>;
      memory.agents[provider as ProviderKind] = { endpoint: text(c.endpoint), model: text(c.model), effort: text(c.effort), permission: text(c.permission) };
    }
  }
  return memory;
}

/** Models the account offers, as "New session" lists them before anything is loaded: its aliases, then its chosen models. */
export function modelOptions(profile: EndpointProfile | undefined): { id: string; name: string }[] {
  if (!profile || profile.native_config) return [];
  const seen = new Set<string>();
  return [
    ...Object.entries(profile.model_aliases ?? {}).map(([id, name]) => ({ id, name: `${id} → ${name}` })),
    ...offeredModels([], profile.models),
  ].filter(entry => !seen.has(entry.id) && !!seen.add(entry.id));
}

/** Thinking depths for this agent, account and model, as "New session" offers them. */
export function effortOptions(provider: ProviderKind, profile: EndpointProfile | undefined, model: string, current?: string): string[] {
  if (provider === "terminal") return [];
  const chosen = model || profile?.model || undefined;
  const effective = profile && !profile.native_config && chosen ? profile.model_aliases?.[chosen] ?? chosen : undefined;
  return modelEfforts(provider as Exclude<ProviderKind, "terminal">, effective, undefined, current || profile?.effort, !!profile && !profile.native_config);
}

/** The approval modes the agent can start in. */
export function permissionOptions(provider: ProviderKind): string[] {
  return [...(agentClient(provider)?.permissionModes ?? [])];
}

/** A remembered value if it is still offered, else the default. */
export function keepOffered(value: string | undefined, offered: readonly string[], fallback: string): string {
  return value !== undefined && (value === "" || offered.includes(value)) ? value : fallback;
}

/** "5h 18% · Week 37%": how much of each official window the account has used; "" when it reports none. */
export function usageText(account: Pick<AccountView, "limits"> | undefined, t: Translate, now = Date.now()): string {
  const parts: string[] = [];
  for (const slot of ["primary", "secondary"] as const) {
    const limit = account?.limits?.[slot], used = accountLimitPercent(limit, now);
    if (!limit || used === undefined) continue;
    const name = quotaShortTitle(slot, limit);
    parts.push(`${t(name.key, name.values)} ${Math.round(used)}%`);
  }
  return parts.join(" · ");
}
