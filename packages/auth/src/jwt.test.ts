import { describe, it, expect } from 'vitest';
import { verifyJwt, bearerToken, decodeJwtUnsafe, JwtError } from './jwt.js';
import { createStaticJwks } from './jwks.js';
import { generateTestKeypair, signTestJwt, sessionClaims } from './testTokens.js';

const NOW_MS = 1_770_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(JwtError);
  await promise.catch((err: JwtError) => expect(err.code).toBe(code));
}

describe('verifyJwt', () => {
  it('accepts a genuinely signed token and returns its claims', async () => {
    const kp = await generateTestKeypair();
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const claims = await verifyJwt(token, { keys: createStaticJwks(kp.jwks), now });

    expect(claims.sub).toBe('user_123');
    expect(claims.email).toBe('member@engine.dev');
  });

  /**
   * The one test in this file that generates an RSA key, and the only one that
   * needs a timeout.
   *
   * RSA-2048 keygen is a probabilistic prime search, so its runtime has a long
   * tail rather than an average. Measured on an idle developer machine over 12
   * runs: 16 ms fastest, 55 ms median, **137 ms slowest** — an 8.5x spread with
   * nothing else competing for the CPU. On a shared CI runner that tail
   * stretches, and on 2026-09-10 it crossed vitest's 5-second default and
   * failed the build on `main`, which skipped `migrate`, `deploy-api` and
   * `deploy` behind it.
   *
   * The generous timeout is the fix rather than a smaller modulus, because the
   * test asserts that RS256 verifies at all — not that it is fast — and 2048
   * is what a real JWKS uses. Ed25519 keygen is constant-time and needs none
   * of this, which is why the other tests here carry no timeout.
   */
  it('verifies RS256 as well as EdDSA, so an upstream alg change still works', async () => {
    const kp = await generateTestKeypair('RS256', 'rsa-key');
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const claims = await verifyJwt(token, { keys: createStaticJwks(kp.jwks), now });

    expect(claims.sub).toBe('user_123');
  }, 30_000);

  it('rejects a tampered payload — the core guarantee', async () => {
    const kp = await generateTestKeypair();
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const [header, , signature] = token.split('.') as [string, string, string];
    // Re-encode the claims with an escalated sub, keeping the original signature.
    const forgedPayload = btoa(JSON.stringify(sessionClaims(NOW_SEC, { sub: 'admin' })))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await expectCode(
      verifyJwt(`${header}.${forgedPayload}.${signature}`, { keys: createStaticJwks(kp.jwks), now }),
      'bad-signature',
    );
  });

  it('rejects alg:none — the classic JWT bypass', async () => {
    const kp = await generateTestKeypair();
    const claims = sessionClaims(NOW_SEC);
    const seg = (v: unknown) =>
      btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unsigned = `${seg({ alg: 'none', typ: 'JWT' })}.${seg(claims)}.`;

    await expectCode(verifyJwt(unsigned, { keys: createStaticJwks(kp.jwks), now }), 'unsupported-alg');
  });

  it('rejects a token signed by a different key that claims a trusted kid', async () => {
    const trusted = await generateTestKeypair('EdDSA', 'trusted-kid');
    const attacker = await generateTestKeypair('EdDSA', 'attacker-kid');
    // Attacker signs with their own key but labels it with the trusted kid.
    const token = await signTestJwt(attacker, sessionClaims(NOW_SEC), { kid: 'trusted-kid' });

    await expectCode(verifyJwt(token, { keys: createStaticJwks(trusted.jwks), now }), 'bad-signature');
  });

  it('rejects an expired token, and honours clock tolerance at the boundary', async () => {
    const kp = await generateTestKeypair();
    const keys = createStaticJwks(kp.jwks);
    const expired = await signTestJwt(kp, sessionClaims(NOW_SEC, { exp: NOW_SEC - 3600 }));
    await expectCode(verifyJwt(expired, { keys, now }), 'expired');

    // 30s past exp is inside the default 60s skew leeway.
    const justExpired = await signTestJwt(kp, sessionClaims(NOW_SEC, { exp: NOW_SEC - 30 }));
    await expect(verifyJwt(justExpired, { keys, now })).resolves.toMatchObject({ sub: 'user_123' });

    // ...but not with tolerance turned off.
    await expectCode(verifyJwt(justExpired, { keys, now, clockToleranceSeconds: 0 }), 'expired');
  });

  it('rejects a token with no exp rather than treating it as eternal', async () => {
    const kp = await generateTestKeypair();
    const claims = sessionClaims(NOW_SEC);
    delete claims.exp;
    const token = await signTestJwt(kp, claims);

    await expectCode(verifyJwt(token, { keys: createStaticJwks(kp.jwks), now }), 'expired');
  });

  it('rejects a not-yet-valid token (nbf)', async () => {
    const kp = await generateTestKeypair();
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC, { nbf: NOW_SEC + 600 }));

    await expectCode(verifyJwt(token, { keys: createStaticJwks(kp.jwks), now }), 'not-yet-valid');
  });

  it('enforces issuer and audience when configured', async () => {
    const kp = await generateTestKeypair();
    const keys = createStaticJwks(kp.jwks);
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const issuer = 'https://auth.example.test/neondb/auth';

    await expect(verifyJwt(token, { keys, now, issuer, audience: 'engine-api' })).resolves.toBeTruthy();
    await expectCode(verifyJwt(token, { keys, now, issuer: 'https://evil.test' }), 'bad-issuer');
    await expectCode(verifyJwt(token, { keys, now, audience: 'other-api' }), 'bad-audience');
  });

  it('accepts an array aud that contains the expected audience', async () => {
    const kp = await generateTestKeypair();
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC, { aud: ['engine-api', 'something-else'] }));

    await expect(
      verifyJwt(token, { keys: createStaticJwks(kp.jwks), now, audience: 'engine-api' }),
    ).resolves.toBeTruthy();
  });

  it('rejects an unknown kid and a malformed token', async () => {
    const kp = await generateTestKeypair('EdDSA', 'real-kid');
    const keys = createStaticJwks(kp.jwks);
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC), { kid: 'ghost-kid' });

    await expectCode(verifyJwt(token, { keys, now }), 'unknown-key');
    await expectCode(verifyJwt('not-a-jwt', { keys, now }), 'malformed');
    await expectCode(verifyJwt('a.b.c', { keys, now }), 'malformed');
  });

  it('rejects a signed token with no sub — we key authorisation off it', async () => {
    const kp = await generateTestKeypair();
    const claims = sessionClaims(NOW_SEC);
    delete claims.sub;
    const token = await signTestJwt(kp, claims);

    await expectCode(verifyJwt(token, { keys: createStaticJwks(kp.jwks), now }), 'malformed');
  });
});

describe('bearerToken', () => {
  it('extracts a token, case-insensitively, and rejects everything else', async () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(bearerToken('bearer  abc.def.ghi  ')).toBe('abc.def.ghi');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
  });
});

describe('decodeJwtUnsafe', () => {
  it('reads claims without verifying (debug only)', async () => {
    const kp = await generateTestKeypair();
    const token = await signTestJwt(kp, sessionClaims(NOW_SEC));
    const { header, claims } = decodeJwtUnsafe(token);

    expect(header.alg).toBe('EdDSA');
    expect(claims.email).toBe('member@engine.dev');
  });
});
