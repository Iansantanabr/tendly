import type { Session } from '@tendly/protocol';
import { json, request, workspacePath } from './api';
import type { AccountView } from './account-ui';

/**
 * Whether a failed turn's message means the account's sign-in is gone.
 *
 * An expired or revoked official sign-in fails every turn the same way, and
 * the raw message ("OAuth session expired and could not be refreshed") does
 * not say what to do. A rejected API key is a different problem with a
 * different fix (the endpoint profile), so a reply that carries an HTTP 401 or
 * 403 from a key, or names an API key, is left alone.
 */
export function needsSignIn(text: string): boolean {
  const lower = text.toLowerCase();
  if (/x-api-key|api key|apikey|\(http 40[13]\)/.test(lower)) return false;
  return /oauth/.test(lower)
    || /not (?:logged|signed) in/.test(lower)
    || /(?:please )?(?:run )?\/login\b/.test(lower)
    || /(?:login|sign-in|sign in) (?:is )?required/.test(lower)
    || /(?:session|token|credential)s?\b.{0,40}(?:expired|revoked|could not be refreshed)/.test(lower);
}

export type SignInRoute =
  /** Run the client's own login command in a terminal on the Mesa. */
  | { kind: 'terminal'; command: string; account: AccountView }
  /** GCore signs this account in itself, from the Accounts dialog. */
  | { kind: 'accounts'; account?: AccountView };

/**
 * How this account signs in again. Claude Code keeps sign-in in its own CLI,
 * so its account carries the exact command (with the configuration directory
 * it has to land in); a client GCore can sign in itself goes to Accounts.
 */
export function signInRoute(account: AccountView | undefined): SignInRoute {
  if (account && !account.capabilities.login && account.guidance) return { kind: 'terminal', command: account.guidance, account };
  return { kind: 'accounts', account };
}

/**
 * Opens a temporary terminal in the workspace and types the login command into
 * it. The person finishes in the browser (or pastes the code into the
 * terminal); nothing here sees a credential.
 */
export async function openSignInTerminal(workspaceId: string, command: string, title: string): Promise<Session> {
  const created = await request<Session>(`${workspacePath(workspaceId)}/sessions`, json('POST', { title, provider: 'terminal', interaction_mode: 'pty', ephemeral: true }));
  const started = await request<Session>(`/sessions/${encodeURIComponent(created.id)}/start`, json('POST'));
  await request(`/sessions/${encodeURIComponent(created.id)}/message`, json('POST', { content: command }));
  return started;
}

/** Asks the account to check its sign-in again; resolves to the new status. */
export async function recheckSignIn(account: AccountView): Promise<AccountView['status']> {
  const view = await request<AccountView>(`/accounts/${encodeURIComponent(account.id)}/refresh`, json('POST', {}));
  return view.status;
}
