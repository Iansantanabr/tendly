import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsSignIn, signInRoute } from './sign-in-needed.ts';

test('an expired official sign-in is recognised', () => {
  assert.equal(needsSignIn('Claude Code could not complete the turn. Check its native account, endpoint and permission settings. Claude Code said: Failed to authenticate: OAuth session expired and could not be refreshed'), true);
  assert.equal(needsSignIn('Not logged in · Please run /login'), true);
  assert.equal(needsSignIn('Your access token could not be refreshed because your refresh token was revoked.'), true);
  assert.equal(needsSignIn('Login required'), true);
});

test('a rejected API key or another failure is not a sign-in problem', () => {
  assert.equal(needsSignIn('Claude Code could not complete the turn (HTTP 401). Check the key, and that the endpoint takes it as an x-api-key header. Claude Code said: Failed to authenticate. API Error: 401 bad key'), false);
  assert.equal(needsSignIn('Claude Code could not complete the turn (HTTP 429). The endpoint is limiting requests; try again later.'), false);
  assert.equal(needsSignIn('Claude Code could not complete the turn. Check its native account, endpoint and permission settings.'), false);
  assert.equal(needsSignIn('Invalid API key · Fix external API key'), false);
});

const base = { id: 'a', name: 'Claude', provider: 'claude_code', profile_id: 'p', status: 'signed_out', capabilities: { login: false, refresh_token: false, quota: false, reset_quota: false, logout: false } };

test('Claude Code signs in through its own command in a terminal', () => {
  const route = signInRoute({ ...base, guidance: 'env -u ANTHROPIC_API_KEY claude auth login' });
  assert.equal(route.kind, 'terminal');
  assert.equal(route.command, 'env -u ANTHROPIC_API_KEY claude auth login');
});

test('an account GCore signs in itself, or no account, goes to Accounts', () => {
  assert.equal(signInRoute({ ...base, capabilities: { ...base.capabilities, login: true }, guidance: 'x' }).kind, 'accounts');
  assert.equal(signInRoute(undefined).kind, 'accounts');
  assert.equal(signInRoute({ ...base }).kind, 'accounts');
});
