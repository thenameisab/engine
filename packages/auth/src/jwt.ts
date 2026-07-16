/**
 * JWT verification against a JWKS, on Web Crypto only — no SDK, so it runs
 * identically on the Cloudflare Workers runtime and in Node/vitest. This gates
 * `apps/api`: the dashboard signs in against Neon Auth (Better Auth), asks it
 * for a JWT, and sends it as `Authorization: Bearer <token>`; we verify that
 * token's signature against Neon Auth's published public keys.
 *
 * Verifying signatures (rather than calling Better Auth's `/get-session` per
 * request) keeps the API dependency-free and fast: no network hop on the hot
 * path once the JWKS is cached, and no shared secret to distribute.
 *
 * Neon Auth signs EdDSA/Ed25519 today; ES256/RS256 are mapped too so a signing
 * -algorithm change upstream doesn't require code changes here.
 */
import type { JwksKeyLookup } from './jwks.js';

/** Claims we rely on, plus whatever else the issuer includes. */
export interface JwtClaims {
  sub: string;
  email?: string;
  name?: string;
  iss?: string;
  aud?: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
  [claim: string]: unknown;
}

export type JwtErrorCode =
  | 'malformed'
  | 'unsupported-alg'
  | 'unknown-key'
  | 'bad-signature'
  | 'expired'
  | 'not-yet-valid'
  | 'bad-issuer'
  | 'bad-audience';

/**
 * A verification failure. Carries a machine-readable `code` so callers can
 * distinguish "this token is junk" from "this token is merely expired" (the
 * client should refresh and retry) without string-matching messages.
 */
export class JwtError extends Error {
  constructor(
    readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

/**
 * The JOSE algorithms we accept, mapped to their Web Crypto verify params.
 * An allowlist is the point: `alg` comes from the *attacker-controlled* token
 * header, so anything not listed here — `none` above all — is rejected before
 * a key is ever looked up.
 */
const VERIFY_PARAMS: Record<string, AlgorithmIdentifier | EcdsaParams> = {
  EdDSA: { name: 'Ed25519' },
  ES256: { name: 'ECDSA', hash: 'SHA-256' },
  RS256: { name: 'RSASSA-PKCS1-v1_5' },
};

/** Default leeway for clock skew between the issuer and this Worker. */
export const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export interface VerifyJwtOptions {
  /** Resolves a `kid` from the token header to a public key. */
  keys: JwksKeyLookup;
  /** Require this `iss` claim. Omit to skip the check. */
  issuer?: string;
  /** Require this value to appear in `aud`. Omit to skip the check. */
  audience?: string;
  /** Injectable clock (ms since epoch), for deterministic tests. */
  now?: () => number;
  clockToleranceSeconds?: number;
}

// The explicit `<ArrayBuffer>` matters: Web Crypto's BufferSource will not
// accept a Uint8Array that might be backed by a SharedArrayBuffer.
function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string, what: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment))) as T;
  } catch {
    throw new JwtError('malformed', `could not decode JWT ${what}`);
  }
}

/**
 * Read a token's claims **without verifying the signature**. Only for logging
 * or debugging — never trust the result for an access decision. Exported
 * separately (and named loudly) so that misuse has to be deliberate.
 */
export function decodeJwtUnsafe(token: string): { header: JwtHeader; claims: JwtClaims } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'JWT must have three dot-separated segments');
  return {
    header: decodeJson<JwtHeader>(parts[0]!, 'header'),
    claims: decodeJson<JwtClaims>(parts[1]!, 'payload'),
  };
}

/** Extract the bearer token from an `Authorization` header value, or null. */
export function bearerToken(authorizationHeader: string | undefined | null): string | null {
  if (!authorizationHeader) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1]!.trim() || null : null;
}

/**
 * Verify a JWT's signature and standard time/issuer/audience claims.
 * Resolves with the claims only when every check passes; otherwise throws a
 * `JwtError`. A token with no `exp` is rejected rather than treated as
 * never-expiring — an unbounded session token is exactly what we don't want
 * guarding live SERP/LLM keys.
 */
export async function verifyJwt(token: string, options: VerifyJwtOptions): Promise<JwtClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed', 'JWT must have three dot-separated segments');
  const [headerSeg, payloadSeg, signatureSeg] = parts as [string, string, string];

  const header = decodeJson<JwtHeader>(headerSeg, 'header');
  const alg = header.alg;
  if (!alg || !(alg in VERIFY_PARAMS)) {
    throw new JwtError('unsupported-alg', `unsupported JWT alg: ${alg ?? '(none)'}`);
  }

  const key = await options.keys.getKey(header.kid, alg);
  if (!key) throw new JwtError('unknown-key', `no JWKS key matches kid: ${header.kid ?? '(none)'}`);

  const signature = base64UrlDecode(signatureSeg);
  const signed = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
  const valid = await crypto.subtle.verify(VERIFY_PARAMS[alg]!, key, signature, signed);
  if (!valid) throw new JwtError('bad-signature', 'JWT signature does not verify against the JWKS key');

  // Claims are only trustworthy after the signature check above.
  const claims = decodeJson<JwtClaims>(payloadSeg, 'payload');
  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const leeway = options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;

  if (typeof claims.exp !== 'number') throw new JwtError('expired', 'JWT has no exp claim');
  if (nowSec > claims.exp + leeway) throw new JwtError('expired', 'JWT is expired');
  if (typeof claims.nbf === 'number' && nowSec < claims.nbf - leeway) {
    throw new JwtError('not-yet-valid', 'JWT is not valid yet (nbf)');
  }
  if (options.issuer && claims.iss !== options.issuer) {
    throw new JwtError('bad-issuer', `JWT iss ${claims.iss ?? '(none)'} !== expected ${options.issuer}`);
  }
  if (options.audience) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!audiences.includes(options.audience)) {
      throw new JwtError('bad-audience', `JWT aud does not include ${options.audience}`);
    }
  }
  if (!claims.sub) throw new JwtError('malformed', 'JWT has no sub claim');

  return claims;
}
