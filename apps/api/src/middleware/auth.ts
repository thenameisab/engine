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
  JwtError,
  type JwksKeyLookup,
} from '@engine/auth';

export interface AuthUser {
  /** The Better Auth user id (JWT `sub`), or a `service:*` machine principal. */
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
    c.set('user', { id: 'dev', email: 'dev@engine.local', name: 'Local dev' });
    return next();
  }

  const jwksUrl = c.env.AUTH_JWKS_URL;
  if (!jwksUrl) {
    return c.json({ error: 'auth is not configured (AUTH_JWKS_URL)' }, 503);
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

  try {
    const claims = await verifyJwt(token, {
      keys: jwksFor(jwksUrl),
      issuer: c.env.AUTH_ISSUER,
      audience: c.env.AUTH_AUDIENCE,
    });
    c.set('user', {
      id: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : undefined,
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
