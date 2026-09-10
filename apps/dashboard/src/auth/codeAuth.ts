/**
 * Email one-time-code sign-in against `POST /auth/code/request` and
 * `POST /auth/code/verify` on apps/api.
 *
 * The third sign-in path beside `neonAuth.ts` (Google) and `passwordAuth.ts`.
 * It mints the same API session token a password sign-in does, so everything
 * after the auth screen is unchanged: the token is stored, sent as a bearer,
 * and expires on its own.
 *
 * Errors are messages fit for the card, for the same reason as in
 * `passwordAuth.ts`: each failure has a different next step for the person
 * in front of the screen.
 */
import { getApiBaseUrl } from '../api.js';
import { setSession, type SessionUser } from './session.js';

interface VerifyResponse {
  token: string;
  user: { id: string; email: string; name: string };
  joinedAccounts: string[];
}

function apiBase(): string {
  const base = getApiBaseUrl();
  if (!base) {
    throw new Error('This build was deployed without an API address (ENGINE_API_BASE). Sign-in cannot work until it is rebuilt with one.');
  }
  return base;
}

async function post(path: string, body: unknown): Promise<Response> {
  try {
    return await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the API. Check your connection and try again.');
  }
}

async function retryAfter(res: Response): Promise<string> {
  const data = (await res.json().catch(() => null)) as { retryAfterSeconds?: number } | null;
  const s = data?.retryAfterSeconds;
  return s && s > 60 ? `${Math.ceil(s / 60)} minutes` : 'a minute';
}

/** Ask for a code. Resolves on 202 whether or not the address is known — the API does not say. */
export async function requestSignInCode(email: string): Promise<void> {
  const res = await post('/auth/code/request', { email });
  if (res.status === 202) return;
  if (res.status === 429) throw new Error(`Too many codes requested. Wait ${await retryAfter(res)} and try again.`);
  if (res.status === 503) throw new Error('Email sign-in is not enabled on this deployment. Use your password, or ask the operator.');
  if (res.status === 502) throw new Error('The sign-in email could not be sent. Try again in a minute.');
  if (res.status === 400) throw new Error('Enter a valid email address.');
  throw new Error(`Could not request a code (${res.status}). If this persists, the API needs attention.`);
}

/** Present the code. On success the session is stored and the shell boots via AUTH_EVENT. */
export async function verifySignInCode(email: string, code: string): Promise<SessionUser> {
  const res = await post('/auth/code/verify', { email, code });
  if (res.status === 401) throw new Error('That code is not valid or has expired. Request a new one.');
  if (res.status === 429) throw new Error(`Too many attempts. Wait ${await retryAfter(res)} and try again.`);
  if (res.status === 400) throw new Error('Enter the 6-digit code from the email.');
  if (res.status === 503) throw new Error('Email sign-in is not enabled on this deployment.');
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}). If this persists, the API needs attention.`);

  const data = (await res.json().catch(() => null)) as VerifyResponse | null;
  if (!data?.token || !data.user?.email) throw new Error('The API returned a sign-in response we could not read.');

  const user: SessionUser = { name: data.user.name || data.user.email, email: data.user.email, provider: 'code' };
  setSession(user, data.token);
  return user;
}
