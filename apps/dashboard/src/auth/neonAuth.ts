/**
 * Neon Auth (Stack Auth) Google sign-in — SDK-free.
 *
 * We deliberately skip `@stackframe/js` to keep the dashboard bundler-free.
 * Neon Auth's project is identified by two *public* values (project id +
 * publishable client key); with those present we start Stack's hosted OAuth
 * flow (using Neon's shared Google credentials, so no separate Google Cloud
 * client is needed). Provide them at runtime via `window.ENGINE_NEON_AUTH` —
 * e.g. a small `config.js` on the deployed Pages site, or the browser console
 * for a quick test. Until they're set, sign-in falls back to a dev session so
 * the gated app is demonstrable and shareable.
 */
import { setSession, type SessionUser } from './session.js';

export interface NeonAuthConfig {
  projectId: string;
  publishableClientKey: string;
}

declare global {
  interface Window {
    ENGINE_NEON_AUTH?: NeonAuthConfig;
  }
}

export function neonAuthConfig(): NeonAuthConfig | null {
  const c = window.ENGINE_NEON_AUTH;
  if (c && c.projectId && c.publishableClientKey) return c;
  return null;
}

export function isNeonAuthConfigured(): boolean {
  return neonAuthConfig() !== null;
}

/**
 * Begin Google sign-in. With Neon Auth configured, redirect into Stack's
 * hosted OAuth (shared Google creds); the return leg exchanges the code and
 * establishes the real session — finished when the two public keys are set and
 * a redirect URL is registered in the Neon Auth console. Without config, sign
 * a dev session in immediately.
 */
export function signInWithGoogle(): void {
  const cfg = neonAuthConfig();
  if (!cfg) {
    devSignIn('google');
    return;
  }
  const redirectUri = location.origin + location.pathname;
  const url = new URL('https://api.stack-auth.com/api/v1/auth/oauth/authorize/google');
  url.searchParams.set('client_id', cfg.projectId);
  url.searchParams.set('publishable_client_key', cfg.publishableClientKey);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  location.href = url.toString();
}

/** Email magic-link — real delivery needs the API; dev signs in with the address. */
export function signInWithEmail(email: string): void {
  devSignIn('email', email);
}

function devSignIn(provider: 'google' | 'email', email?: string): void {
  const user: SessionUser =
    provider === 'email' && email
      ? { name: email.split('@')[0] ?? 'Member', email, provider: 'dev' }
      : { name: 'Team member', email: 'you@engine.dev', provider: 'dev' };
  setSession(user);
}
