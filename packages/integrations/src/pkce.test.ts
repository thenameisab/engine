import { describe, it, expect } from 'vitest';
import { createPkcePair, challengeFor, assertVerifierShape } from './pkce.js';
import { IntegrationError } from './errors.js';

describe('createPkcePair', () => {
  it('produces an RFC 7636 verifier and its S256 challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.method).toBe('S256');
    expect(pair.verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    // base64url of a SHA-256 digest, unpadded.
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await challengeFor(pair.verifier)).toBe(pair.challenge);
  });

  it('never repeats a verifier', async () => {
    const pairs = await Promise.all(Array.from({ length: 20 }, () => createPkcePair()));
    expect(new Set(pairs.map((p) => p.verifier)).size).toBe(20);
  });

  it('produces a challenge that differs from the verifier', async () => {
    // The property that makes S256 worth anything: a `plain` challenge is the
    // verifier itself and protects against nothing.
    const pair = await createPkcePair();
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('matches the RFC 7636 appendix B test vector', async () => {
    // The one published vector, so a refactor of the encoding cannot pass by
    // being self-consistently wrong.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(await challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('assertVerifierShape', () => {
  it('rejects a verifier that is too short, too long, or has reserved characters', () => {
    expect(() => assertVerifierShape('tooshort')).toThrow(IntegrationError);
    expect(() => assertVerifierShape('a'.repeat(129))).toThrow(IntegrationError);
    expect(() => assertVerifierShape(`${'a'.repeat(42)}+`)).toThrow(IntegrationError);
  });

  it('does not echo the verifier in the error', () => {
    // It is a credential for the life of the flow, and this message reaches logs.
    const secret = 'short+secret';
    try {
      assertVerifierShape(secret);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it('accepts the boundary lengths', () => {
    expect(() => assertVerifierShape('a'.repeat(43))).not.toThrow();
    expect(() => assertVerifierShape('a'.repeat(128))).not.toThrow();
  });
});
