/**
 * Test-only JWT/JWKS forge. Excluded from the build (see tsconfig).
 *
 * These helpers mint **real** Ed25519/RSA keypairs via Web Crypto and sign
 * **real** JWTs with them, so the tests exercise the same crypto path a Neon
 * Auth token takes — no mocked signatures, no live account needed. This is why
 * this package can be genuinely tested here rather than smoke-scripted.
 */
import type { Jwk, JwksDocument } from './jwks.js';

export interface TestKeypair {
  privateKey: CryptoKey;
  jwk: Jwk;
  jwks: JwksDocument;
  alg: 'EdDSA' | 'RS256';
  kid: string;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

/** Generate a signing keypair and the JWKS document that publishes its public half. */
export async function generateTestKeypair(alg: 'EdDSA' | 'RS256' = 'EdDSA', kid = 'test-key-1'): Promise<TestKeypair> {
  const params =
    alg === 'EdDSA'
      ? { name: 'Ed25519' }
      : { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
  const pair = (await crypto.subtle.generateKey(params as AlgorithmIdentifier, true, ['sign', 'verify'])) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk;

  // Publish the key the way a real JWKS does: public parameters only, tagged
  // with our kid/alg. (Web Crypto's export tags Ed25519 keys `alg: "Ed25519"`,
  // whereas JWKS documents use the JOSE name `EdDSA` — as Neon Auth's does.)
  const jwk: Jwk = { ...exported, kid, alg, use: 'sig' };
  delete (jwk as Record<string, unknown>).key_ops;
  delete (jwk as Record<string, unknown>).ext;
  delete (jwk as Record<string, unknown>).d;

  return { privateKey: pair.privateKey, jwk, jwks: { keys: [jwk] }, alg, kid };
}

/** Sign a real JWT with a test keypair. `header` overrides let tests forge bad tokens. */
export async function signTestJwt(
  keypair: TestKeypair,
  claims: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = { alg: keypair.alg, typ: 'JWT', kid: keypair.kid, ...headerOverrides };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(claims)}`;
  const params = keypair.alg === 'EdDSA' ? { name: 'Ed25519' } : { name: 'RSASSA-PKCS1-v1_5' };
  const signature = await crypto.subtle.sign(params, keypair.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** Claims shaped like a Better Auth JWT, valid for an hour from `nowSec`. */
export function sessionClaims(nowSec: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user_123',
    email: 'member@engine.dev',
    name: 'Team Member',
    iss: 'https://auth.example.test/neondb/auth',
    aud: 'engine-api',
    iat: nowSec,
    exp: nowSec + 3600,
    ...overrides,
  };
}
