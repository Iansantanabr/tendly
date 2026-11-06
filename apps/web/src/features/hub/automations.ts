import { json, request } from "../api";

/** What the Automations page and its log read from `/api/hub/automations`. */
export type AutomationKind = "script" | "agent";
export type RunStatus = "running" | "ok" | "failed" | "timeout";

export interface AutomationRunSummary {
  id: number;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  session_id: string | null;
  trigger: "schedule" | "manual";
}
export interface AutomationRun extends AutomationRunSummary {
  automation_id: string;
  output_tail: string;
}
export interface Automation {
  id: string;
  name: string;
  description: string;
  kind: AutomationKind;
  cron: string;
  timezone: string | null;
  workspace_id: string | null;
  command: string | null;
  prompt: string | null;
  provider: "claude_code" | "codex" | null;
  endpoint_id: string | null;
  model: string | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
  next_run: string | null;
  last_run: AutomationRunSummary | null;
  running: boolean;
}
/** The editable part, as the form sends it. */
export type AutomationDraft = Pick<Automation, "name" | "description" | "kind" | "cron" | "workspace_id" | "command" | "prompt" | "provider"> & Partial<Pick<Automation, "endpoint_id" | "model" | "enabled" | "timezone">>;

/** Schedules most people want, as English labels for `t()`. */
export const CRON_PRESETS: readonly { cron: string; label: string }[] = [
  { cron: "0 * * * *", label: "Every hour" },
  { cron: "0 9 * * *", label: "Every day at 9:00" },
  { cron: "0 9 * * 1-5", label: "Weekdays at 9:00" },
  { cron: "0 9 * * 1", label: "Mondays at 9:00" },
  { cron: "*/15 * * * *", label: "Every 15 minutes" },
];

export function presetLabel(cron: string): string | undefined {
  const normal = cron.trim().split(/\s+/).join(" ");
  return CRON_PRESETS.find(preset => preset.cron === normal)?.label;
}

export const listAutomations = async () => (await request<{ automations: Automation[] }>("/hub/automations")).automations;
export const createAutomation = (draft: AutomationDraft) => request<Automation>("/hub/automations", json("POST", draft));
export const updateAutomation = (id: string, patch: Partial<AutomationDraft>) => request<Automation>(`/hub/automations/${encodeURIComponent(id)}`, json("PATCH", patch));
export const deleteAutomation = (id: string) => request<{ ok: boolean }>(`/hub/automations/${encodeURIComponent(id)}`, json("DELETE"));
export const runAutomation = (id: string) => request<AutomationRun>(`/hub/automations/${encodeURIComponent(id)}/run`, json("POST"));
export const automationRuns = async (id: string, limit = 20) => (await request<{ runs: AutomationRun[] }>(`/hub/automations/${encodeURIComponent(id)}/runs?limit=${limit}`)).runs;

type Translate = (source: string, values?: Record<string, string | number>) => string;

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
export function ago(iso: string | null | undefined, t: Translate, now = Date.now()): string {
  if (!iso) return "";
  const seconds = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return t("just now");
  if (seconds < 3600) return t("{count} min ago", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("{count} h ago", { count: Math.floor(seconds / 3600) });
  return t("{count} d ago", { count: Math.floor(seconds / 86400) });
}

/** The last result line on a card, and its tone. */
export function lastResult(automation: Pick<Automation, "running" | "last_run">, t: Translate, now = Date.now()): { text: string; tone: "ok" | "failed" | "running" | "none" } {
  const run = automation.last_run;
  if (automation.running || run?.status === "running") return { text: t("Running…"), tone: "running" };
  if (!run) return { text: t("Didn't run yet"), tone: "none" };
  const when = ago(run.finished_at ?? run.started_at, t, now);
  if (run.status === "ok") return { text: t("Succeeded {when}", { when }), tone: "ok" };
  if (run.status === "timeout") return { text: t("Timed out {when}", { when }), tone: "failed" };
  return { text: t("Failed {when}", { when }), tone: "failed" };
}

/** How long a run took, "12 s" / "3 min". */
export function duration(run: Pick<AutomationRun, "started_at" | "finished_at">, t: Translate): string {
  if (!run.finished_at) return "";
  const seconds = Math.max(0, Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000));
  return seconds < 60 ? t("{count} s", { count: seconds }) : t("{count} min", { count: Math.round(seconds / 60) });
}

/** The fields an agent may change, as the conversation sees them. */
export function editable(automation: Automation) {
  const { id, name, description, kind, cron, timezone, workspace_id, command, prompt, provider, endpoint_id, model, enabled } = automation;
  return { id, name, description, kind, cron, timezone, workspace_id, command, prompt, provider, endpoint_id, model, enabled };
}

/** The first message of an "Edit with chat" conversation. */
export function editPrompt(automation: Automation, t: Translate): string {
  return [
    t("I want to change my automation “{name}”. This is how it is now:", { name: automation.name }),
    "",
    "```json",
    JSON.stringify(editable(automation), null, 2),
    "```",
    "",
    t("Ask me what to change if I have not said it yet. Then save the change with the tendly_automation_update tool, using this id; do not create a new automation. The schedule is a five-field cron in this machine's time zone unless timezone says otherwise."),
  ].join("\n");
}
