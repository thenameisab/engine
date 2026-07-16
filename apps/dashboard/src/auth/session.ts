/**
 * Client-side session for the auth gate. Deliberately minimal: a signed-in
 * user is a small JSON blob in localStorage. Real token verification happens
 * against Neon Auth once its keys are wired (see neonAuth.ts); until then a
 * dev sign-in is enough to demonstrate and share the gated app.
 */
export interface SessionUser {
  name: string;
  email: string;
  provider: 'google' | 'email' | 'dev';
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
