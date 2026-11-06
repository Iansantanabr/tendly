import { shallowRef } from "vue";
import type { EndpointProfile, ProviderKind } from "@tendly/protocol";
import { json, request } from "../api";
import { PROFILE_CHOICE_REQUIRED, preferredProfileSelection } from "../profile-preferences";
import { loadPreferences, preferenceFor } from "../preferences";
import { loadConversationsWorkspace } from "./inbox";

/**
 * Starting a conversation from anywhere ("Ask the agent", "Use in chat"…).
 * App.vue keeps `startProfiles` current and registers the handler that opens a
 * started conversation on the Mesa, so a component deep in a pane needs no
 * props or emits to do it.
 */
export const startProfiles = shallowRef<EndpointProfile[]>([]);
let opened: ((sessionId: string) => void) | undefined;
export function onConversationStarted(handler: (sessionId: string) => void) { opened = handler; }
/** Opens an existing conversation on the Mesa, the way a started one opens. */
export function openConversation(sessionId: string) { opened?.(sessionId); }

export const ACCOUNT_REQUIRED = "This host has several accounts and none is the default. Choose one in Settings → Preferences, then send again.";

export class AccountChoiceRequired extends Error { constructor() { super(ACCOUNT_REQUIRED); } }

/** The account "New session" would use for this agent; null for the provider default. */
export async function defaultEndpoint(provider: ProviderKind, profiles = startProfiles.value): Promise<string | null> {
  await loadPreferences();
  const chosen = preferredProfileSelection(provider, profiles, undefined, preferenceFor(provider)?.endpoint_profile_id);
  if (chosen === PROFILE_CHOICE_REQUIRED) throw new AccountChoiceRequired();
  return chosen || null;
}

export interface StartOptions {
  prompt: string;
  /** A project; none (or an unknown one) means the folder for conversations without a project. */
  workspaceId?: string | null;
  provider?: ProviderKind;
  endpointId?: string | null;
  model?: string | null;
  effort?: string | null;
  permission?: string | null;
  /** Open it on the Mesa once started (default true). */
  open?: boolean;
}

/** Starts a conversation with `prompt` and returns its session id. Throws AccountChoiceRequired when no account can be picked. */
export async function startConversation(options: StartOptions): Promise<string> {
  const provider = options.provider ?? "claude_code";
  const workspace = options.workspaceId || await loadConversationsWorkspace();
  if (!workspace) throw new Error("Add a workspace first: it is the folder the agent works in.");
  const endpoint = options.endpointId !== undefined ? options.endpointId : await defaultEndpoint(provider);
  const body: Record<string, unknown> = { workspace_id: workspace, provider, prompt: options.prompt, endpoint_id: endpoint };
  if (options.model) body.model = options.model;
  if (options.effort) body.effort = options.effort;
  if (options.permission) body.permission = options.permission;
  const result = await request<{ started: { id: string } }>("/hub/start", json("POST", body));
  if (options.open !== false) opened?.(result.started.id);
  return result.started.id;
}
