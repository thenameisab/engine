import { describe, it, expect } from 'vitest';
import { createRemoteJwks } from './jwks.js';
import { verifyJwt } from './jwt.js';
import { generateTestKeypair, signTestJwt, sessionClaims, type TestKeypair } from './testTokens.js';

const NOW_SEC = 1_770_000_000;

/** A fake JWKS endpoint that counts fetches and can rotate its published keys. */
function jwksServer(initial: TestKeypair) {
  let current = initial;
  let fetches = 0;
  let status = 200;
  const fetchImpl = (async () => {
    fetches++;
    return {
      ok: status === 200,
      status,
      json: async () => current.jwks,
    } as Response;
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    get fetches() {
      return fetches;
    },
    rotateTo(next: TestKeypair) {
      current = next;
    },
    fail(code: number) {
      status = code;
    },
  };
}

describe('createRemoteJwks', () => {
  it('fetches once and caches across verifications', async () => {
    const kp = await generateTestKeypair();
    const server = jwksServer(kp);
    const keys = createRemoteJwks('https://auth.test/jwks', { fetchImpl: server.fetchImpl });
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const now = () => NOW_SEC * 1000;

    await verifyJwt(token, { keys, now });
    await verifyJwt(token, { keys, now });
    await verifyJwt(token, { keys, now });

    expect(server.fetches).toBe(1);
  });

  it('refetches once the TTL expires', async () => {
    const kp = await generateTestKeypair();
    const server = jwksServer(kp);
    let clock = 1_000_000;
    const keys = createRemoteJwks('https://auth.test/jwks', {
      fetchImpl: server.fetchImpl,
      ttlMs: 60_000,
      now: () => clock,
    });

    await keys.getKey(kp.kid, 'EdDSA');
    expect(server.fetches).toBe(1);

    clock += 30_000;
    await keys.getKey(kp.kid, 'EdDSA');
    expect(server.fetches).toBe(1); // still fresh

    clock += 40_000; // now past the 60s TTL
    await keys.getKey(kp.kid, 'EdDSA');
    expect(server.fetches).toBe(2);
  });

  it('heals from a key rotation: an unknown kid triggers a refetch', async () => {
    const oldKey = await generateTestKeypair('EdDSA', 'key-v1');
    const newKey = await generateTestKeypair('EdDSA', 'key-v2');
    const server = jwksServer(oldKey);
    let clock = 1_000_000;
    const keys = createRemoteJwks('https://auth.test/jwks', { fetchImpl: server.fetchImpl, now: () => clock });

    await verifyJwt(await signTestJwt(oldKey, sessionClaims(NOW_SEC)), { keys, now: () => NOW_SEC * 1000 });
    expect(server.fetches).toBe(1);

    // Issuer rotates; a token arrives signed by the new key, with a kid we've never seen.
    server.rotateTo(newKey);
    clock += 60_000; // past the refetch floor
    const claims = await verifyJwt(await signTestJwt(newKey, sessionClaims(NOW_SEC)), {
      keys,
      now: () => NOW_SEC * 1000,
    });

    expect(claims.sub).toBe('user_123');
    expect(server.fetches).toBe(2);
  });

  it('rate-limits unknown-kid refetches so junk tokens cannot drive outbound traffic', async () => {
    const kp = await generateTestKeypair('EdDSA', 'real-kid');
    const server = jwksServer(kp);
    let clock = 1_000_000;
    const keys = createRemoteJwks('https://auth.test/jwks', {
      fetchImpl: server.fetchImpl,
      minRefetchIntervalMs: 30_000,
      now: () => clock,
    });

    await keys.getKey('real-kid', 'EdDSA');
    expect(server.fetches).toBe(1);

    // A flood of random kids within the refetch floor: no extra fetches.
    for (let i = 0; i < 50; i++) {
      expect(await keys.getKey(`junk-kid-${i}`, 'EdDSA')).toBeNull();
    }
    expect(server.fetches).toBe(1);

    // Past the floor, exactly one refetch is allowed.
    clock += 31_000;
    expect(await keys.getKey('junk-kid-x', 'EdDSA')).toBeNull();
    expect(server.fetches).toBe(2);
  });

  it('de-duplicates concurrent fetches into a single request', async () => {
    const kp = await generateTestKeypair();
    const server = jwksServer(kp);
    const keys = createRemoteJwks('https://auth.test/jwks', { fetchImpl: server.fetchImpl });

    const results = await Promise.all(Array.from({ length: 10 }, () => keys.getKey(kp.kid, 'EdDSA')));

    expect(server.fetches).toBe(1);
    expect(results.every((k) => k !== null)).toBe(true);
  });

  it('propagates a JWKS endpoint failure instead of silently allowing the request', async () => {
    const kp = await generateTestKeypair();
    const server = jwksServer(kp);
    server.fail(500);
    const keys = createRemoteJwks('https://auth.test/jwks', { fetchImpl: server.fetchImpl });

    await expect(keys.getKey(kp.kid, 'EdDSA')).rejects.toThrow(/JWKS fetch failed: 500/);
  });

  it('falls back to the sole key when a token carries no kid', async () => {
    const kp = await generateTestKeypair();
    const server = jwksServer(kp);
    const keys = createRemoteJwks('https://auth.test/jwks', { fetchImpl: server.fetchImpl });
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC), { kid: undefined });

    await expect(verifyJwt(token, { keys, now: () => NOW_SEC * 1000 })).resolves.toMatchObject({ sub: 'user_123' });
  });
});
