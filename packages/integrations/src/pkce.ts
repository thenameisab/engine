/**
 * PKCE (RFC 7636), on every OAuth flow including the confidential ones.
 *
 * PKCE was specified for public clients that cannot hold a secret, and this is
 * a confidential client that can — so the textbook reading is that it is not
 * required here. OAuth 2.1 requires it anyway, for a reason that applies to us:
 * PKCE defends the *authorization code*, which travels through the customer's
 * browser and lands in a URL. A signed `state` proves the callback belongs to
 * a flow we started; it does nothing about a code that leaked from browser
 * history, a Referer header, a proxy log, or a shared machine. With PKCE a
 * leaked code is inert without the verifier, which never leaves the server.
 *
 * The cost is one column and one hash. The failure it removes is silent and
 * total: an attacker who replays a stolen code gets a live credential bound to
 * the victim's account, and nothing in the audit trail looks unusual.
 */
import { IntegrationError } from './errors.js';

export interface PkcePair {
  /** Held server-side for the life of the flow, sent only on code exchange. */
  verifier: string;
  /** Sent to the authorization endpoint, in the open. */
  challenge: string;
  method: 'S256';
}

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. 96 bytes → 128 chars. */
const VERIFIER_BYTES = 96;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a verifier and its S256 challenge.
 *
 * `plain` is not offered. RFC 7636 permits it only for clients that cannot
 * compute SHA-256, which is not a situation that exists on this runtime, and
 * a `plain` challenge is the same value as the verifier — no protection at all
 * against exactly the interception this exists to stop.
 */
export async function createPkcePair(): Promise<PkcePair> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(VERIFIER_BYTES)));
  return { verifier, challenge: await challengeFor(verifier), method: 'S256' };
}

export async function challengeFor(verifier: string): Promise<string> {
  assertVerifierShape(verifier);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier) as unknown as ArrayBuffer);
  return b64url(new Uint8Array(digest));
}

const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function assertVerifierShape(verifier: string): void {
  if (!VERIFIER_RE.test(verifier)) {
    // Deliberately does not echo the value: it is a credential for the length
    // of the flow, and this message reaches logs.
    throw new IntegrationError('invalid_request', 'PKCE verifier is not 43–128 unreserved characters');
  }
}
