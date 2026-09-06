/**
 * Credential sign-in against `POST /auth/login` on apps/api.
 *
 * The counterpart to `neonAuth.ts`. Where that one hands the browser to
 * Google and adopts a cookie session, this one posts an email and password to
 * our own API and gets back an HMAC-signed session token the API will accept
 * on later requests.
 *
 * It exists because Google sign-in cannot complete from the deployed
 * dashboard: its origin is not on Neon Auth's trusted-origins list, so
 * `POST /sign-in/social` answers 403 for everyone. Three people need in.
 */
import { getApiBaseUrl } from '../api.js';
import { setSession, type SessionUser } from './session.js';

interface LoginResponse {
  token: string;
  user: { id: string; email: string; name: string };
}

/**
 * Sign in, or throw with a message fit to render on the card.
 *
 * Every failure mode here is one the person in front of the screen has to act
 * on, and the actions differ: fix the API URL, wait, retype the password, or
 * go and configure the deployment. A single "sign-in failed" would collapse
 * four different next steps into one dead end.
 */
export async function signInWithPassword(email: string, password: string): Promise<SessionUser> {
  const base = getApiBaseUrl();
  if (!base) {
    throw new Error('No API URL is configured. Set it in Settings, or ask whoever deployed this build.');
  }

  let res: Response;
  try {
    res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new Error('Could not reach the API. Check your connection and the API URL in Settings.');
  }

  if (res.status === 401) throw new Error('That email and password combination is not valid.');
  if (res.status === 503) {
    throw new Error('Credential sign-in is not enabled on this deployment. Set LOCAL_AUTH_USERS and LOCAL_AUTH_SECRET.');
  }
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}). If this persists, the API needs attention.`);

  const data = (await res.json().catch(() => null)) as LoginResponse | null;
  if (!data?.token || !data.user?.email) throw new Error('The API returned a sign-in response we could not read.');

  const user: SessionUser = { name: data.user.name || data.user.email, email: data.user.email, provider: 'password' };
  setSession(user, data.token);
  return user;
}
