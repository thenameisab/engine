/**
 * The OAuth `state` parameter, signed.
 *
 * The existing GSC connect flow sets `state` to the bare project id
 * (`apps/api/src/index.ts`, E1 wizard) and its callback is deliberately
 * ungated — a Google redirect arrives with no session, so it cannot be. That
 * combination was harmless only because the callback threw the tokens away.
 * Once a callback persists a credential, an unsigned state is an account
 * takeover primitive: an attacker completes consent with their own Google
 * account, hand-edits `state` to a victim's id, and the callback dutifully
 * binds the attacker's token to the victim's account — or, run the other way,
 * tricks a signed-in victim into a callback that attaches the attacker's
 * Google account to the victim's project.
 *
 * So `state` becomes a token this service minted and can verify: HMAC-SHA-256
 * over the claims, with an expiry. The callback trusts the claims because it
 * signed them, not because the browser presented them.
 *
 * Deliberately not a JWT. `jwt.ts` verifies *Neon Auth's* asymmetric tokens
 * from a published JWKS; this is a symmetric value we both mint and check,
 * inside one Worker, and reusing the JWT path would imply a shared identity
 * contract that does not exist here.
 */

/** What the callback needs to know, and could not otherwise learn. */
export interface OAuthStateClaims {
  /** The account the resulting credential belongs to. */
  accountId: string;
  /** The user who started the flow — recorded as the connecting actor. */
  userId: string;
  /** Which provider's consent this is ('gsc' | 'ga4' | 'gbp'). */
  provider: string;
  /** Where to send the browser after the callback finishes. */
  returnTo?: string;
}

interface SignedPayload extends OAuthStateClaims {
  /** Expiry, epoch seconds. */
  exp: number;
  /** Single-use randomness, so two flows started in the same second differ. */
  nonce: string;
}

/** Default lifetime. Long enough to read a consent screen, short enough that a leaked state is stale. */
const DEFAULT_TTL_SECONDS = 600;

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
 * Mint a signed state token. `secret` is the `OAUTH_STATE_SECRET` Worker
 * secret; `nowSeconds` and `nonce` are injectable so expiry and replay are
 * testable without waiting or mocking globals.
 */
export async function signOAuthState(
  claims: OAuthStateClaims,
  secret: string,
  opts: { ttlSeconds?: number; nowSeconds?: number; nonce?: string } = {},
): Promise<string> {
  if (!secret) throw new Error('OAUTH_STATE_SECRET is not set — refusing to mint an unsigned OAuth state');
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const payload: SignedPayload = {
    ...claims,
    exp: now + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    nonce: opts.nonce ?? b64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), new TextEncoder().encode(body) as unknown as ArrayBuffer);
  return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export type OAuthStateResult =
  | { ok: true; claims: OAuthStateClaims & { nonce: string } }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'unconfigured' };

/**
 * Verify a state token and return its claims.
 *
 * Returns a reason rather than throwing, because the callback's response
 * differs per case: an expired state is a user who left the tab open and
 * should be told to retry, a bad signature is an attack and should be logged
 * as one. `crypto.subtle.verify` is constant-time, so no separate
 * timing-safe comparison is needed here.
 */
export async function verifyOAuthState(
  token: string,
  secret: string | undefined,
  opts: { nowSeconds?: number } = {},
): Promise<OAuthStateResult> {
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

  let payload: SignedPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SignedPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload.accountId || !payload.userId || !payload.provider || typeof payload.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now >= payload.exp) return { ok: false, reason: 'expired' };

  return {
    ok: true,
    claims: {
      accountId: payload.accountId,
      userId: payload.userId,
      provider: payload.provider,
      returnTo: payload.returnTo,
      nonce: payload.nonce,
    },
  };
}
