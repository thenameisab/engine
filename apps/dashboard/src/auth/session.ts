/**
 * Client-side session for the auth gate.
 *
 * Two kinds of session land here:
 *
 *  - **Google (Neon Auth).** The real session is a cookie on Neon Auth's
 *    origin; this blob is presentation state only, deciding whether the shell
 *    or the sign-in screen renders. Forging it gains a would-be attacker an
 *    empty shell, because every API request carries a separately-fetched JWT
 *    the API verifies against the published JWKS.
 *  - **Password (the fixed pre-alpha roster).** Here the API itself mints an
 *    HMAC-signed session token at `POST /auth/login`, and that token is stored
 *    alongside the user — see `TOKEN_KEY` for why it is persisted.
 *
 * There is deliberately no 'dev' provider. One used to exist as a fallback for
 * when Neon Auth was unreachable, which meant a broken auth service silently
 * admitted anyone; sign-in now fails visibly instead.
 */
export interface SessionUser {
  name: string;
  email: string;
  /** 'code' is an email one-time code; it mints the same API token a password sign-in does. */
  provider: 'google' | 'password' | 'code';
}

const KEY = 'engine.session';

/**
 * The API session token for a password sign-in.
 *
 * Persisted, unlike the Google path's bearer token, which is held only in
 * memory because it can be re-minted at any time from a cookie the browser
 * keeps. There is no cookie behind a credential sign-in: not persisting this
 * would sign the user out on every reload, and re-prompting for a password on
 * every refresh trains people to type it into anything that asks. The token
 * expires on its own after eight hours, and `signOut` removes it.
 */
const TOKEN_KEY = 'engine.apiToken';

export const AUTH_EVENT = 'engine:auth-changed';

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getUser(): SessionUser | null {
  const raw = safeGet(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  return getUser() !== null;
}

/** The stored API token for a password session, or null (Google sessions mint theirs per request). */
export function getStoredApiToken(): string | null {
  return safeGet(TOKEN_KEY);
}

export function setSession(user: SessionUser, apiToken?: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
    if (apiToken) localStorage.setItem(TOKEN_KEY, apiToken);
  } catch {
    /* storage unavailable (sandboxed preview) — session lasts the page life via the event only */
  }
  dispatchEvent(new Event(AUTH_EVENT));
}

export function signOut(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  dispatchEvent(new Event(AUTH_EVENT));
}

/** Initials for the avatar, from a name or email. */
export function initials(user: SessionUser): string {
  const src = user.name?.trim() || user.email;
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'U';
}
