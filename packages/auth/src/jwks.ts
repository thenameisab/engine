/**
 * JWKS fetching + caching. The issuer (Neon Auth / Better Auth) publishes its
 * public signing keys at a well-known URL; we fetch them once, cache them, and
 * verify tokens locally against them.
 *
 * Two things this deliberately gets right, because both are real availability
 * bugs rather than theory:
 *
 *  1. **Key rotation.** An unknown `kid` triggers a refetch, so a rotated
 *     signing key heals without a redeploy.
 *  2. **Refetch stampedes.** That refetch is rate-limited and de-duplicated —
 *     otherwise a flood of junk tokens carrying random `kid`s would turn every
 *     request into an outbound JWKS fetch, i.e. a free amplification vector
 *     against both us and the issuer.
 */

/** A single JWK as published in a JWKS document. */
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
  use?: string;
}

export interface JwksDocument {
  keys: Jwk[];
}

/** Resolves a token header's `kid`/`alg` to a public key for verification. */
export interface JwksKeyLookup {
  getKey(kid: string | undefined, alg: string): Promise<CryptoKey | null>;
}

export interface RemoteJwksOptions {
  /** How long a fetched JWKS is trusted before refetching. Default 10 minutes. */
  ttlMs?: number;
  /** Floor between refetches triggered by an unknown kid. Default 30 seconds. */
  minRefetchIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MIN_REFETCH_MS = 30 * 1000;

/**
 * Import a JWK as a Web Crypto verify key. `alg` comes from the JWT header but
 * has already been checked against an allowlist by the caller (`verifyJwt`).
 * Ed25519 is tried under its standard name first, then the legacy
 * `NODE-ED25519` name that older Workers compatibility dates require.
 */
async function importJwk(jwk: Jwk, alg: string): Promise<CryptoKey | null> {
  const material = { ...jwk, ext: true } as JsonWebKey;
  try {
    switch (alg) {
      case 'EdDSA':
        try {
          return await crypto.subtle.importKey('jwk', material, { name: 'Ed25519' }, false, ['verify']);
        } catch {
          return await crypto.subtle.importKey(
            'jwk',
            material,
            { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' } as unknown as AlgorithmIdentifier,
            false,
            ['verify'],
          );
        }
      case 'ES256':
        return await crypto.subtle.importKey('jwk', material, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
          'verify',
        ]);
      case 'RS256':
        return await crypto.subtle.importKey(
          'jwk',
          material,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Pick the JWK matching a token header. A `kid` match wins; when the token
 * carries no `kid` we fall back to the sole key, but only if the set is
 * unambiguous — guessing among several keys would be a silent correctness bug.
 */
function selectJwk(keys: Jwk[], kid: string | undefined, alg: string): Jwk | null {
  if (kid) return keys.find((k) => k.kid === kid) ?? null;
  const usable = keys.filter((k) => !k.alg || k.alg === alg);
  return usable.length === 1 ? usable[0]! : null;
}

/**
 * A `JwksKeyLookup` backed by a remote JWKS URL, with TTL caching, rotation
 * healing, and single-flight refetching.
 */
export function createRemoteJwks(url: string, options: RemoteJwksOptions = {}): JwksKeyLookup {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const minRefetchMs = options.minRefetchIntervalMs ?? DEFAULT_MIN_REFETCH_MS;
  const doFetch = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? (() => Date.now());

  let keys: Jwk[] = [];
  let fetchedAt = 0;
  let lastAttemptAt = 0;
  let inFlight: Promise<void> | null = null;
  const imported = new Map<string, CryptoKey>();

  async function refresh(): Promise<void> {
    // Single-flight: concurrent requests share one outbound fetch.
    if (inFlight) return inFlight;
    lastAttemptAt = now();
    inFlight = (async () => {
      const res = await doFetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const doc = (await res.json()) as JwksDocument;
      if (!Array.isArray(doc?.keys)) throw new Error('JWKS response has no keys array');
      keys = doc.keys;
      fetchedAt = now();
      imported.clear();
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    async getKey(kid, alg) {
      if (keys.length === 0 || now() - fetchedAt > ttlMs) await refresh();

      let jwk = selectJwk(keys, kid, alg);
      // Unknown kid: the issuer may have rotated. Refetch, but no more often
      // than minRefetchMs, so unknown-kid tokens can't drive outbound traffic.
      if (!jwk && now() - lastAttemptAt > minRefetchMs) {
        await refresh();
        jwk = selectJwk(keys, kid, alg);
      }
      if (!jwk) return null;

      const cacheKey = `${jwk.kid ?? 'nokid'}:${alg}`;
      const cached = imported.get(cacheKey);
      if (cached) return cached;

      const key = await importJwk(jwk, alg);
      if (key) imported.set(cacheKey, key);
      return key;
    },
  };
}

/** A fixed-key `JwksKeyLookup`, for tests and offline verification. */
export function createStaticJwks(document: JwksDocument): JwksKeyLookup {
  const imported = new Map<string, CryptoKey>();
  return {
    async getKey(kid, alg) {
      const jwk = selectJwk(document.keys, kid, alg);
      if (!jwk) return null;
      const cacheKey = `${jwk.kid ?? 'nokid'}:${alg}`;
      const cached = imported.get(cacheKey);
      if (cached) return cached;
      const key = await importJwk(jwk, alg);
      if (key) imported.set(cacheKey, key);
      return key;
    },
  };
}
