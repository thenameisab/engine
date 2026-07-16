/**
 * Neon Auth — which is **Better Auth**, not Stack. SDK-free: we call Better
 * Auth's REST endpoints directly so the dashboard stays bundler-free.
 *
 * Flow (Google): POST /sign-in/social → `{ url }` → redirect the browser there
 * → Better Auth runs Google's OAuth → sets a session cookie → returns to our
 * `callbackURL`. On load we call GET /get-session (with credentials) to adopt
 * that cookie session. Sign-out hits POST /sign-out.
 *
 * The base URL is this Neon project's Better Auth endpoint (a public endpoint —
 * it serves JWKS/`/ok` to anyone). Override per-environment with
 * `window.ENGINE_AUTH_BASE`. The deployed dashboard's origin must be added to
 * Neon Auth's trusted origins for the OAuth callback to be accepted.
 */
import { setSession, type SessionUser } from './session.js';

const DEFAULT_AUTH_BASE =
  'https://ep-wild-wildflower-aomyso5f.neonauth.c-2.ap-southeast-1.aws.neon.tech/neondb/auth';

declare global {
  interface Window {
    ENGINE_AUTH_BASE?: string;
  }
}

function authBase(): string {
  return (window.ENGINE_AUTH_BASE || DEFAULT_AUTH_BASE).replace(/\/$/, '');
}

interface BetterAuthUser {
  name?: string;
  email?: string;
  image?: string;
}

function toUser(u: BetterAuthUser | undefined, provider: SessionUser['provider']): SessionUser | null {
  if (!u?.email) return null;
  return { name: u.name || u.email.split('@')[0] || 'Member', email: u.email, provider };
}

/** The current Better Auth session (cookie-based), or null. Adopts a session set by an OAuth return. */
export async function fetchRemoteSession(): Promise<SessionUser | null> {
  try {
    const res = await fetch(`${authBase()}/get-session`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = (await res.json()) as { user?: BetterAuthUser } | null;
    return toUser(data?.user ?? undefined, 'google');
  } catch {
    return null;
  }
}

/** Begin Google sign-in. Redirects into Better Auth's social flow; dev fallback on any hiccup. */
export async function signInWithGoogle(): Promise<void> {
  try {
    const res = await fetch(`${authBase()}/sign-in/social`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google', callbackURL: location.href }),
    });
    if (res.ok) {
      const data = (await res.json()) as { url?: string };
      if (data.url) {
        location.href = data.url;
        return;
      }
    }
  } catch {
    /* fall through to dev session */
  }
  setSession({ name: 'Team member', email: 'you@engine.dev', provider: 'dev' });
}

/**
 * Email magic-link, if the Better Auth instance has the plugin enabled.
 * Returns true when a link was sent; on any failure, signs in a dev session so
 * the app stays usable. (Magic-link delivery + the plugin land server-side.)
 */
export async function sendEmailLink(email: string): Promise<boolean> {
  try {
    const res = await fetch(`${authBase()}/sign-in/magic-link`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: location.href }),
    });
    if (res.ok) return true;
  } catch {
    /* fall through to dev session */
  }
  setSession({ name: email.split('@')[0] || 'Member', email, provider: 'dev' });
  return false;
}

export async function signOutRemote(): Promise<void> {
  try {
    await fetch(`${authBase()}/sign-out`, { method: 'POST', credentials: 'include' });
  } catch {
    /* ignore — local session is cleared regardless */
  }
}
