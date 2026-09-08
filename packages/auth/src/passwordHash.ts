/**
 * Password hashing for the credential roster, now that it lives in Postgres
 * rather than in a Worker secret (migration 0016).
 *
 * PBKDF2-HMAC-SHA-256, because this runs on the Workers runtime. bcrypt,
 * scrypt and Argon2 are the better primitives on a normal server and none of
 * them is available here without shipping WASM into an edge bundle that is
 * already 456 KiB; PBKDF2 is what WebCrypto implements natively, so it is
 * fast, constant-work and dependency-free. The stored format keeps the door
 * open: it names the algorithm, so adding `argon2id$...` later is a new branch
 * in `verifyPassword`, not a migration.
 *
 * Stored form, one self-describing string:
 *
 *   pbkdf2-sha256$<iterations>$<salt-b64url>$<hash-b64url>
 *
 * The iteration count travels *with the hash* rather than living in a constant
 * here. That is what makes the work factor raisable: old hashes keep verifying
 * at the count they were made with, and `needsRehash` says which ones to
 * upgrade on the next successful sign-in. A constant would mean every existing
 * password stops verifying the day it changes.
 */
import { timingSafeEqual } from './serviceToken.js';

const ALGORITHM = 'pbkdf2-sha256';

/**
 * Default work factor.
 *
 * OWASP's PBKDF2-SHA-256 guidance is 600,000, written for servers with no
 * per-request CPU ceiling. Workers has one, and it applies to sign-in — a
 * derivation that exceeds it does not slow the login down, it fails the
 * request outright, which is a worse security outcome than a lower count
 * (nobody can sign in, so the deployment gets "fixed" by turning this off).
 * 100,000 is the compromise: ~13 bits of added cost over a bare hash, and
 * comfortably inside the CPU budget of a paid Workers request.
 *
 * Raise it by changing this number — nothing re-derives eagerly, and
 * `needsRehash` upgrades each password the next time its owner signs in.
 */
export const DEFAULT_ITERATIONS = 100_000;

/** 16 bytes, the usual floor: enough that no two users share a salt in practice. */
const SALT_BYTES = 16;

/** 32 bytes — the natural output width of SHA-256; asking for more adds no entropy. */
const KEY_BYTES = 32;

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

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as unknown as ArrayBuffer,
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Hash a password for storage. A fresh random salt every call, so the same
 * password stored for two people produces two unrelated hashes — which is the
 * whole point of a salt, and matters here because the three pre-alpha users
 * were handed the same password.
 */
export async function hashPassword(
  password: string,
  opts: { iterations?: number; salt?: Uint8Array } = {},
): Promise<string> {
  if (!password) throw new Error('refusing to hash an empty password');
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`invalid iteration count: ${iterations}`);
  }
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${b64urlEncode(salt)}$${b64urlEncode(hash)}`;
}

interface ParsedHash {
  iterations: number;
  salt: Uint8Array;
  hash: string;
}

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 4) return null;
  const [algo, iterationsRaw, saltRaw, hash] = parts;
  if (algo !== ALGORITHM || !saltRaw || !hash) return null;
  const iterations = Number(iterationsRaw);
  if (!Number.isInteger(iterations) || iterations < 1) return null;
  try {
    return { iterations, salt: b64urlDecode(saltRaw), hash };
  } catch {
    return null;
  }
}

/**
 * Check a presented password against a stored hash.
 *
 * Never throws on a malformed stored value — a corrupt row must reject that
 * one login, not 500 the endpoint, which would tell an attacker they had found
 * something interesting. The final comparison is timing-safe: PBKDF2 makes the
 * derivation slow, and a fast `===` on the result would hand back a byte-by-byte
 * oracle on the very thing the derivation exists to protect.
 */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (!password || !stored) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  let derived: Uint8Array;
  try {
    derived = await derive(password, parsed.salt, parsed.iterations);
  } catch {
    return false;
  }
  return timingSafeEqual(b64urlEncode(derived), parsed.hash);
}

/**
 * True when a stored hash was made with fewer iterations than we now want, so
 * the caller can transparently re-hash on the next successful sign-in — the
 * only moment the plaintext is available to re-derive from.
 *
 * An unparseable hash reports false: it cannot be verified against in the
 * first place, so there is no successful sign-in to upgrade.
 */
export function needsRehash(stored: string | undefined, iterations: number = DEFAULT_ITERATIONS): boolean {
  if (!stored) return false;
  const parsed = parseHash(stored);
  if (!parsed) return false;
  return parsed.iterations < iterations;
}

/**
 * A syntactically valid hash that no password verifies against, for the
 * unknown-user path.
 *
 * Without it, "no such user" returns immediately while "wrong password" spends
 * 100,000 iterations first — a timing difference measured in tens of
 * milliseconds, which turns the login form into a roster oracle over the
 * network, not just in theory. Callers must run a real derivation against this
 * when the lookup misses.
 */
export function dummyHash(iterations: number = DEFAULT_ITERATIONS): string {
  return `${ALGORITHM}$${iterations}$${b64urlEncode(new Uint8Array(SALT_BYTES))}$${b64urlEncode(new Uint8Array(KEY_BYTES))}`;
}
