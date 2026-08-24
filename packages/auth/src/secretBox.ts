/**
 * Authenticated encryption for third-party credentials held at rest.
 *
 * Every integration before this one took its credential from a Worker secret:
 * one `SERPER_API_KEY`, one `GBP_REFRESH_TOKEN`, set by us, the same for every
 * customer. Per-account OAuth inverts that — the refresh token belongs to the
 * customer, arrives at runtime, and has to live in Postgres next to the row
 * that describes it. A plaintext `refresh_token` column would mean a database
 * dump, a leaked read-replica URL, or an over-broad support query hands over
 * live write access to a customer's Google Business Profile.
 *
 * So the token is sealed before it is stored and opened only in the isolate
 * that needs it. AES-256-GCM via Web Crypto: authenticated, so a tampered
 * ciphertext fails to open rather than decrypting to garbage, and available on
 * the Workers runtime without a dependency (the same constraint that kept
 * `jwt.ts` and Stripe signature verification SDK-free).
 *
 * This is not a substitute for guarding the database. It narrows what a
 * database compromise alone yields: sealed blobs, useless without a key that
 * lives in the Worker's secret store and is never written to Postgres.
 */

/** Sealed-blob format version, so the wire format can change without ambiguity. */
const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the GCM standard nonce length
const KEY_BYTES = 32; // AES-256

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const raw = atob(s);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/**
 * Import the configured encryption key. The key is supplied as base64 of 32
 * raw bytes — generate one with
 * `openssl rand -base64 32` — and bound as the `ENCRYPTION_KEY` Worker secret.
 *
 * Throws on a missing or wrong-length key rather than deriving something
 * workable from whatever it was given. A short key silently stretched into a
 * valid AES key is the kind of "it works" that quietly halves the security of
 * every token in the table.
 */
export async function importEncryptionKey(base64Key: string | undefined): Promise<CryptoKey> {
  if (!base64Key) throw new Error('ENCRYPTION_KEY is not set — cannot seal or open stored credentials');
  let raw: Uint8Array;
  try {
    raw = fromBase64(base64Key);
  } catch {
    throw new Error('ENCRYPTION_KEY is not valid base64');
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(`ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (AES-256), got ${raw.length}`);
  }
  return crypto.subtle.importKey('raw', raw as unknown as ArrayBuffer, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Seal a credential for storage. Returns `v1.<iv>.<ciphertext>`, both base64 —
 * one self-describing string that fits a single text column, carrying its own
 * IV so nothing else has to be stored alongside it.
 *
 * A fresh random IV per call is what makes this safe to reuse the same key
 * across every row: GCM catastrophically leaks plaintext if an (key, IV) pair
 * is ever reused, so the IV is never derived from the row or the value.
 *
 * `aad` binds the blob to its context (we pass `<accountId>:<provider>`). It is
 * authenticated but not encrypted, so a blob lifted out of one account's row
 * and pasted into another's fails to open instead of decrypting cleanly into
 * someone else's live token.
 */
export async function seal(key: CryptoKey, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer, additionalData: encoder.encode(aad) as unknown as ArrayBuffer },
    key,
    encoder.encode(plaintext) as unknown as ArrayBuffer,
  );
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

/**
 * Open a sealed credential. Throws when the blob is malformed, the version is
 * unknown, the key is wrong, the `aad` does not match, or a single byte was
 * altered — GCM authenticates, so there is no "decrypted but wrong" outcome to
 * accidentally act on.
 */
export async function open(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const parts = sealed.split('.');
  if (parts.length !== 3) throw new Error('sealed credential is malformed');
  const [version, ivB64, ctB64] = parts;
  if (version !== VERSION) throw new Error(`unsupported sealed-credential version: ${version}`);

  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = fromBase64(ivB64);
    ciphertext = fromBase64(ctB64);
  } catch {
    throw new Error('sealed credential is not valid base64');
  }
  if (iv.length !== IV_BYTES) throw new Error('sealed credential has a malformed IV');

  const encoder = new TextEncoder();
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as ArrayBuffer,
        additionalData: encoder.encode(aad) as unknown as ArrayBuffer,
      },
      key,
      ciphertext as unknown as ArrayBuffer,
    );
  } catch {
    // Deliberately does not distinguish wrong-key from wrong-aad from tampered.
    // The caller cannot act differently on any of them, and saying which one
    // failed tells an attacker probing the endpoint what to change next.
    throw new Error('sealed credential failed to open (wrong key, wrong context, or tampered)');
  }
  return new TextDecoder().decode(plaintext);
}

/** The `aad` context string for an account's credential on one provider. */
export function credentialAad(accountId: string, provider: string): string {
  return `${accountId}:${provider}`;
}
