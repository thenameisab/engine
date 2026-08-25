/**
 * Client-side session for the auth gate: a signed-in user as a small JSON blob
 * in localStorage.
 *
 * This is presentation state only — it decides whether the shell or the sign-in
 * screen renders, and nothing more. Every request to the API carries a
 * separately-fetched Neon Auth JWT which the API verifies against the published
 * JWKS, so forging this blob gains a would-be attacker an empty shell and
 * nothing else.
 *
 * There is deliberately no 'dev' provider. One used to exist as a fallback for
 * when Neon Auth was unreachable, which meant a broken auth service silently
 * admitted anyone; sign-in now fails visibly instead.
 */
export interface SessionUser {
  name: string;
  email: string;
  provider: 'google' | 'email';
}

const KEY = 'engine.session';
export const AUTH_EVENT = 'engine:auth-changed';

function safeGet(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function getUser(): SessionUser | null {
  const raw = safeGet();
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

export function setSession(user: SessionUser): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable (sandboxed preview) — session lasts the page life via the event only */
  }
  dispatchEvent(new Event(AUTH_EVENT));
}

export function signOut(): void {
  try {
    localStorage.removeItem(KEY);
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
