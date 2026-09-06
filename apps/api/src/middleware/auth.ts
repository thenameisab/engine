/**
 * Bearer-JWT gate for the API (Neon Auth / Better Auth).
 *
 * Until now every route here was open to anyone who found the Worker URL —
 * including `/rank/poll` and `/ai/poll`, which spend real Serper/OpenAI credit
 * per call, and every DB-backed project route. The dashboard's sign-in screen
 * was a client-side gate only: cosmetic, trivially bypassed with curl. This
 * closes that.
 *
 * The dashboard signs in against Neon Auth, asks it for a JWT (`GET /token`),
 * and sends `Authorization: Bearer <token>`. We verify the signature against
 * Neon Auth's published JWKS — no shared secret, and no per-request call back
 * to the auth server once the key set is cached in the isolate.
 */
import type { Context, Next } from 'hono';
import {
  createRemoteJwks,
  verifyJwt,
  bearerToken,
  verifyServiceToken,
  verifyLocalSession,
  JwtError,
  type JwksKeyLookup,
} from '@engine/auth';

export interface AuthUser {
  /**
   * The principal: a Better Auth user id (JWT `sub`), a `local:<email>` roster
   * user (see `POST /auth/login`), or a `service:*` machine caller.
   */
  id: string;
  email?: string;
  name?: string;
  /** True for the edge worker's service token rather than a signed-in human. */
  isService?: boolean;
}

export interface AuthEnv {
  /** Neon Auth's JWKS endpoint. Public — a var, not a secret. */
  AUTH_JWKS_URL?: string;
  /** Optional expected `iss` claim. */
  AUTH_ISSUER?: string;
  /** Optional expected `aud` claim. */
  AUTH_AUDIENCE?: string;
  /**
   * Set to 'disabled' to run the API unauthenticated. Local development only —
   * never for a deployed Worker holding live API keys.
   */
  AUTH_MODE?: string;
  /**
   * Shared secret for machine callers with no user session — specifically the
   * edge worker's C1.7 auto-rollback call. Bound as a secret on both Workers.
   */
  INTERNAL_API_TOKEN?: string;
  /**
   * Comma-separated emails allowed to use the product ("invite-only, pre-alpha",
   * which the sign-in screen claims and nothing enforced). Case-insensitive.
   *
   * Unset means no allowlist: any Google account that clears the consent screen
   * can sign in and create its own account. That is the deliberate default —
   * a deny-all-when-unset would be indistinguishable, from the user's side,
   * from auth being broken, which is the failure class this codebase keeps
   * removing. `/health/integrations` reports whether it is configured.
   */
  ALLOWED_EMAILS?: string;
  /**
   * The fixed pre-alpha roster: `email:password[:Name]`, comma-separated.
   * Parsed by `@engine/auth`'s `parseLocalRoster`. Unset means credential
   * sign-in is off and `POST /auth/login` answers 503.
   */
  LOCAL_AUTH_USERS?: string;
  /**
   * HMAC key for the session tokens `POST /auth/login` mints. Must not be
   * shared with `OAUTH_STATE_SECRET`; the token's `typ` claim makes a mix-up
   * safe anyway, but two jobs deserve two keys.
   */
  LOCAL_AUTH_SECRET?: string;
}

/**
 * JWKS lookups live at module scope so the key set is cached for the life of
 * the isolate and shared across requests — a per-request cache would refetch
 * the JWKS on every call and defeat the purpose. Keyed by URL so a config
 * change doesn't serve stale keys.
 */
const jwksByUrl = new Map<string, JwksKeyLookup>();

function jwksFor(url: string): JwksKeyLookup {
  let jwks = jwksByUrl.get(url);
  if (!jwks) {
    jwks = createRemoteJwks(url);
    jwksByUrl.set(url, jwks);
  }
  return jwks;
}

/**
 * Parse `ALLOWED_EMAILS` into a normalised set. Empty when unset.
 *
 * Exported for the readiness check and for tests; the comparison is
 * lower-cased and trimmed because an invite list is typed by a human and
 * "Person@Example.com " is the same person.
 */
export function parseAllowedEmails(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Whether a verified email may use the product.
 *
 * An unset allowlist admits everyone — see `ALLOWED_EMAILS`. A *set* allowlist
 * rejects a token carrying no email at all, rather than treating "no email" as
 * "not excluded": the gate exists to name who is allowed in, and something it
 * cannot name is not on the list.
 */
export function isInvited(email: string | undefined, allowedRaw: string | undefined): boolean {
  const allowed = parseAllowedEmails(allowedRaw);
  if (allowed.size === 0) return true;
  if (!email) return false;
  return allowed.has(email.trim().toLowerCase());
}

/**
 * True when the request was made to a loopback address — the only place
 * `AUTH_MODE=disabled` is allowed to take effect.
 *
 * Reads the request URL's hostname rather than any header: `Host` and
 * `X-Forwarded-Host` are attacker-controlled, so trusting either would hand
 * back the bypass this exists to close.
 */
export function isLoopbackRequest(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.localhost')
  );
}

/** Map a verification failure to a status: expired → 401 (refresh and retry). */
function statusFor(err: JwtError): 401 | 403 {
  return err.code === 'expired' || err.code === 'not-yet-valid' ? 401 : 403;
}

/**
 * Require a valid Neon Auth JWT. On success the verified user is available as
 * `c.get('user')`. Fails **closed**: if the gate is misconfigured we refuse the
 * request (503) rather than waving it through, since the failure mode of
 * guessing wrong here is an open API holding live credentials.
 */
export async function requireAuth(
  c: Context<{ Bindings: AuthEnv; Variables: { user: AuthUser } }>,
  next: Next,
): Promise<Response | void> {
  if (c.env.AUTH_MODE === 'disabled') {
    // Honoured only for a request that actually arrived on a loopback host.
    // The docs have always said "local development only, never on a deployed
    // Worker", but nothing enforced it — one stray `wrangler secret put
    // AUTH_MODE disabled` left the API wide open over every project route, the
    // database URL, and live SERP/LLM credit, with no signal that it had
    // happened. A hostname check is cheap and cannot be got wrong by accident.
    if (isLoopbackRequest(c.req.url)) {
      c.set('user', { id: 'dev', email: 'dev@engine.local', name: 'Local dev' });
      return next();
    }
    return c.json(
      { error: 'AUTH_MODE=disabled is refused outside local development. Unset it on this deployment.' },
      503,
    );
  }

  const token = bearerToken(c.req.header('authorization'));
  if (!token) {
    return c.json({ error: 'missing bearer token' }, 401);
  }

  // Machine callers present the shared service token instead of a JWT. Checked
  // before the JWT path since it is not one.
  //
  // The principal is `service:internal`, not the name of any one caller: more
  // than one machine holds this token (the edge worker's auto-rollback, the
  // off-edge crawl runner), and a shared secret cannot tell us which one is
  // calling. Naming a specific service here would put a claim in the audit log
  // that we never verified — the same lie C1.8 removed from the human path.
  // A service that wants to be named can label itself via `actor`.
  if (verifyServiceToken(token, c.env.INTERNAL_API_TOKEN)) {
    c.set('user', { id: 'service:internal', isService: true });
    return next();
  }

  // Credential sign-in for the fixed roster (`POST /auth/login`). Tried before
  // the JWT path and skipped entirely when unconfigured, so a deployment that
  // uses only Neon Auth behaves exactly as it did.
  //
  // A Neon Auth JWT has three dot-separated segments and this token has two,
  // so a token of the wrong kind falls through as 'malformed' rather than
  // being rejected outright — the two schemes coexist on one header.
  if (c.env.LOCAL_AUTH_SECRET) {
    const session = await verifyLocalSession(token, c.env.LOCAL_AUTH_SECRET);
    if (session.ok) {
      // Deliberately not run through `isInvited`. The roster is already an
      // explicit, closed list of exactly who may sign in — and a stricter one,
      // since it also demands a password. Composing a second list here adds no
      // gate, only a way to lock the three users out by editing an unrelated var.
      c.set('user', { id: session.user.id, email: session.user.email, name: session.user.name });
      return next();
    }
    // An expired session is the one failure the client can fix on its own, and
    // only by signing in again — say so rather than letting it fall through to
    // the JWT path and come back as an opaque 'invalid token'.
    if (session.reason === 'expired') {
      return c.json({ error: 'session expired', code: 'expired' }, 401);
    }
  }

  const jwksUrl = c.env.AUTH_JWKS_URL;
  if (!jwksUrl) {
    // Reached only when the token is not a service token and not a valid local
    // session, so there is genuinely no way left to verify it.
    return c.json({ error: 'auth is not configured (AUTH_JWKS_URL)' }, 503);
  }

  try {
    const claims = await verifyJwt(token, {
      keys: jwksFor(jwksUrl),
      issuer: c.env.AUTH_ISSUER,
      audience: c.env.AUTH_AUDIENCE,
    });
    const email = typeof claims.email === 'string' ? claims.email : undefined;

    // Invite gate. Applied after verification, never before: deciding access
    // on an unverified `email` claim would let anyone mint their own pass.
    if (!isInvited(email, c.env.ALLOWED_EMAILS)) {
      return c.json(
        {
          error: 'This account is not on the invite list for this pre-alpha.',
          email: email ?? null,
        },
        403,
      );
    }

    c.set('user', {
      id: claims.sub,
      email,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    });
    return next();
  } catch (err) {
    if (err instanceof JwtError) {
      return c.json({ error: 'invalid token', code: err.code }, statusFor(err));
    }
    // A JWKS fetch failure lands here: we cannot verify, so we cannot allow.
    return c.json({ error: 'could not verify token' }, 503);
  }
}
