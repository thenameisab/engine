/**
 * Stripe webhook signature verification (G3), reimplemented against Web
 * Crypto instead of the Stripe SDK so it runs identically in Cloudflare
 * Workers and Node/vitest — no live Stripe account needed to verify this is
 * correct, since the algorithm is just HMAC-SHA256 over a known string.
 * https://docs.stripe.com/webhooks#verify-manually
 */

/** Default replay-protection window, matching Stripe's own SDK default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time equality for two equal-length hex strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ParsedSigHeader {
  timestamp: number;
  signatures: string[];
}

/** Stripe-Signature header shape: `t=<unix>,v1=<hex>,v1=<hex>,...` (multiple v1s during secret rotation). */
function parseSigHeader(header: string): ParsedSigHeader | null {
  const parts = header.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/**
 * Verify a raw webhook body against Stripe's `Stripe-Signature` header.
 * `nowSeconds` is injectable so replay-tolerance is deterministically testable.
 */
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const parsed = parseSigHeader(sigHeader);
  if (!parsed) return false;
  if (Math.abs(nowSeconds - parsed.timestamp) > toleranceSeconds) return false;

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${payload}`);
  return parsed.signatures.some((sig) => timingSafeEqual(sig, expected));
}
