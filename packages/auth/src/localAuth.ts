/**
 * Credential sign-in for the fixed set of pre-alpha users — the third trust
 * source in this gate, alongside Neon Auth JWTs (`jwt.ts`) and the machine
 * service token (`serviceToken.ts`).
 *
 * Why this exists. Neon Auth's Google flow is the real identity story, but it
 * cannot sign anyone in to the deployed dashboard today: the Pages origin is
 * not on Neon Auth's trusted-origins list, so `POST /sign-in/social` answers
 * `403 INVALID_CALLBACKURL` for everyone. That is a console setting outside
 * this repository. Meanwhile the product has exactly three users, all of whom
 * need in. So: a closed roster, no signup, no password reset, no recovery —
 * three people, three credentials, and nothing else can authenticate.
 *
 * The roster lives in one Worker secret rather than in this file. "Hardcoded"
 * here means *fixed* — the set cannot grow through any code path — not
 * *committed*: a password in git is a password in every clone, every fork and
 * every CI log, and email addresses are personal data. The mechanism is in
 * source; the three identities are configuration.
 *
 * On success the API mints a short-lived HMAC-signed session token that
 * `requireAuth` verifies on later requests. Deliberately not a JWT: `jwt.ts`
 * verifies *someone else's* asymmetric tokens from a published JWKS, while
 * this is a symmetric value one Worker both mints and checks. Same reasoning,
 * and the same wire format, as `oauthState.ts`.
 */
import { timingSafeEqual } from './serviceToken.js';

/** A member of the fixed roster. `id` is what lands in `users.id`. */
export interface LocalUser {
  /** Stable principal id — namespaced so it can never collide with a Neon Auth `sub`. */
  id: string;
  email: string;
  name: string;
}

/** Marks a session token as this kind of token. See `verifyLocalSession`. */
const TOKEN_TYPE = 'engine-local-session';

/** Eight hours: a working day, so nobody signs in twice before lunch. */
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

/**
 * Turn an email into a stable principal id.
 *
 * Lower-cased so `Person@x.com` and `person@x.com` are one user rather than
 * two rows in `users` and two disjoint sets of accounts. The `local:` prefix
 * keeps the namespace disjoint from Neon Auth's `sub` values, so migrating a
 * person to Google sign-in later creates a new principal instead of silently
 * inheriting this one's memberships.
 */
export function localUserId(email: string): string {
  return `local:${email.trim().toLowerCase()}`;
}

/** Fall back to the local-part when no display name is configured: "ada.love" -> "Ada Love". */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((p) => p[0].toUpperCase() + p.slice(1))
      .join(' ') || email
  );
}

interface RosterEntry {
  user: LocalUser;
  password: string;
}

/**
 * Parse the roster secret.
 *
 * Format: `email:password[:Display Name]`, comma-separated. The name is
 * optional and derived from the address when absent. A password containing a
 * comma or a colon cannot be expressed — documented in `.dev.vars.example`,
 * and the alternative (JSON in an env var) is worse to type correctly into a
 * `wrangler secret put` prompt.
 *
 * Malformed and duplicate entries are dropped rather than throwing: this runs
 * inside a request, and a typo in the roster must not take the whole API down
 * — it must take *that one login* down, visibly, at the sign-in screen.
 */
export function parseLocalRoster(raw: string | undefined): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  if (!raw) return roster;
  for (const chunk of raw.split(',')) {
    const parts = chunk.split(':');
    const email = (parts[0] ?? '').trim().toLowerCase();
    const password = parts[1] ?? '';
    const name = parts.slice(2).join(':').trim();
    // A blank password would admit anyone who guessed the address.
    if (!email || !email.includes('@') || !password) continue;
    if (roster.has(email)) continue;
    roster.set(email, {
      user: { id: localUserId(email), email, name: name || nameFromEmail(email) },
      password,
    });
  }
  return roster;
}

/** How many credentials are configured — for the readiness endpoint, which must not reveal who they are. */
export function localRosterSize(raw: string | undefined): number {
  return parseLocalRoster(raw).size;
}

/**
 * Check a presented credential against the roster.
 *
 * Returns the user, or null. The comparison is timing-safe, and an unknown
 * address is compared against a dummy of the same shape so that "no such user"
 * and "wrong password" take the same path — otherwise the endpoint answers,
 * by the clock, which of the three addresses are real.
 */
export function verifyLocalCredentials(
  email: string | undefined,
  password: string | undefined,
  raw: string | undefined,
): LocalUser | null {
  const roster = parseLocalRoster(raw);
  if (roster.size === 0) return null;
  const entry = roster.get((email ?? '').trim().toLowerCase());
  const expected = entry?.password ?? ' unmatchable';
  const ok = timingSafeEqual(password ?? '', expected);
  return ok && entry ? entry.user : null;
}

interface SessionPayload {
  typ: string;
  sub: string;
  email: string;
  name: string;
  /** Expiry, epoch seconds. */
  exp: number;
  /** Issued-at, epoch seconds — so a token can be aged out by rotation later. */
  iat: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * Mint a session token for a roster user. Throws on an unset secret rather
 * than minting an unsigned one — the same refusal `signOAuthState` makes.
 */
export async function signLocalSession(
  user: LocalUser,
  secret: string,
  opts: { ttlSeconds?: number; nowSeconds?: number } = {},
): Promise<string> {
  if (!secret) throw new Error('LOCAL_AUTH_SECRET is not set — refusing to mint an unsigned session token');
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    typ: TOKEN_TYPE,
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(body) as unknown as ArrayBuffer,
  );
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export type LocalSessionResult =
  | { ok: true; user: LocalUser; expiresAtSeconds: number }
  | { ok: false; reason: 'unconfigured' | 'malformed' | 'bad-signature' | 'expired' | 'wrong-type' };

/**
 * Verify a session token minted by `signLocalSession`.
 *
 * The `typ` check is not ceremony. This token and an OAuth state share a wire
 * format, so a deployment that reused one secret for both would otherwise let
 * a signed OAuth state — which any consent flow hands to the browser — be
 * presented as a session bearing an attacker-chosen `userId`. Checking the
 * type closes that regardless of how the secrets are configured.
 */
export async function verifyLocalSession(
  token: string,
  secret: string | undefined,
  opts: { nowSeconds?: number } = {},
): Promise<LocalSessionResult> {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sigB64] = parts;

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sigB64) as unknown as ArrayBuffer,
      new TextEncoder().encode(body) as unknown as ArrayBuffer,
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };

  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.typ !== TOKEN_TYPE) return { ok: false, reason: 'wrong-type' };
  if (!payload.sub || !payload.email || typeof payload.exp !== 'number') return { ok: false, reason: 'malformed' };

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    user: { id: payload.sub, email: payload.email, name: payload.name || payload.email },
    expiresAtSeconds: payload.exp,
  };
}
