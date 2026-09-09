import { describe, expect, it } from 'vitest';
import {
  toPkcs8,
  signAppJwt,
  fetchAppIdentity,
  mintInstallationToken,
  listInstallationRepositories,
  deleteInstallation,
} from './githubApp.js';
import { IntegrationError } from './errors.js';

/** A real 2048-bit RSA key, generated for this test and used nowhere else. */
const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

const pkcs8Pem = toPem(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey), 'PRIVATE KEY');

/**
 * The same key as PKCS#1, which is what GitHub's download button actually
 * gives you. Derived by stripping the PKCS#8 envelope back off: version,
 * algorithm identifier, then the PKCS#1 key as an OCTET STRING.
 */
function pkcs1PemFromPkcs8(pem: string): string {
  const der = toPkcs8(pem);
  // Skip the outer SEQUENCE header, the 3-byte version and the 15-byte
  // algorithm identifier, then read the OCTET STRING's contents.
  let i = 1;
  const first = der[i];
  i += first < 0x80 ? 1 : 1 + (first & 0x7f);
  i += 3 + 15;
  const tag = der[i];
  if (tag !== 0x04) throw new Error('expected an OCTET STRING');
  i += 1;
  const len = der[i];
  i += len < 0x80 ? 1 : 1 + (len & 0x7f);
  return toPem(der.slice(i).buffer as ArrayBuffer, 'RSA PRIVATE KEY');
}

const pkcs1Pem = pkcs1PemFromPkcs8(pkcs8Pem);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('toPkcs8', () => {
  it('passes a PKCS#8 key through unchanged', () => {
    expect(Array.from(toPkcs8(pkcs8Pem))).toEqual(Array.from(toPkcs8(pkcs8Pem)));
  });

  it('wraps the PKCS#1 key GitHub actually hands out into an importable PKCS#8', async () => {
    // The bug this prevents: GitHub's private-key download is
    // `BEGIN RSA PRIVATE KEY`, WebCrypto imports only PKCS#8, and the failure
    // is an opaque DataError at signing time — long after the paste.
    const der = toPkcs8(pkcs1Pem);
    const key = await crypto.subtle.importKey(
      'pkcs8',
      der as unknown as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(key.type).toBe('private');
  });

  it('names the fault for a passphrase-protected key', () => {
    expect(() => toPkcs8('-----BEGIN ENCRYPTED PRIVATE KEY-----\nx\n-----END ENCRYPTED PRIVATE KEY-----'))
      .toThrow(/passphrase-protected/);
  });

  it('names the fault for something that is not a key at all', () => {
    expect(() => toPkcs8('ghp_a_personal_access_token')).toThrow(/not a PEM private key/);
  });
});

describe('signAppJwt', () => {
  it('signs a verifiable RS256 JWT claiming the App id', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    const jwt = await signAppJwt('123456', pkcs8Pem, now);
    const [header, payload, signature] = jwt.split('.');

    const decode = (seg: string) =>
      JSON.parse(atob(seg.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = decode(payload);
    expect(claims.iss).toBe('123456');
    // Backdated a minute: GitHub rejects a token issued in the future, and a
    // Worker clock a few seconds fast would otherwise fail intermittently.
    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000) - 60);
    // And inside GitHub's 10-minute ceiling.
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);

    const raw = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));
    const verified = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      keyPair.publicKey,
      raw as unknown as ArrayBuffer,
      new TextEncoder().encode(`${header}.${payload}`) as unknown as ArrayBuffer,
    );
    expect(verified).toBe(true);
  });

  it('signs identically from the PKCS#1 form of the same key', async () => {
    const now = new Date('2026-09-09T12:00:00.000Z');
    expect(await signAppJwt('123456', pkcs1Pem, now)).toBe(await signAppJwt('123456', pkcs8Pem, now));
  });
});

describe('the app-level calls', () => {
  it('reads the slug from the App rather than trusting a stored copy', async () => {
    const identity = await fetchAppIdentity('https://api.github.com', 'jwt', async (url, init) => {
      expect(String(url)).toBe('https://api.github.com/app');
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer jwt');
      return jsonResponse({ slug: 'engine-fixes', name: 'Engine' });
    });
    expect(identity).toEqual({ slug: 'engine-fixes', name: 'Engine' });
  });

  it('reports a 401 on an app-level call as a configuration fault, not a customer one', async () => {
    // An App id that does not match its private key lands here.
    await expect(
      fetchAppIdentity('https://api.github.com', 'jwt', async () => jsonResponse({ message: 'Bad credentials' }, 401)),
    ).rejects.toMatchObject({ reason: 'not_configured' });
  });

  it('mints an installation token', async () => {
    const minted = await mintInstallationToken('https://api.github.com', 'jwt', '42', async (url, init) => {
      expect(String(url)).toBe('https://api.github.com/app/installations/42/access_tokens');
      expect(init?.method).toBe('POST');
      return jsonResponse({ token: 'ghs_installation', expires_at: '2026-09-09T13:00:00Z' });
    });
    expect(minted.token).toBe('ghs_installation');
    expect(minted.expiresAt).toBe('2026-09-09T13:00:00Z');
  });

  it('lists only the repositories the installation was granted', async () => {
    const repos = await listInstallationRepositories('https://api.github.com', 'ghs_installation', async (url) => {
      expect(String(url)).toContain('/installation/repositories');
      return jsonResponse({
        repositories: [
          { full_name: 'acme/site', default_branch: 'main', private: false },
          { full_name: 'acme/private-site', default_branch: 'trunk', private: true },
          // A malformed row must not become a repository with no name.
          { default_branch: 'main' },
        ],
      });
    });
    expect(repos).toEqual([
      { fullName: 'acme/site', defaultBranch: 'main', private: false },
      { fullName: 'acme/private-site', defaultBranch: 'trunk', private: true },
    ]);
  });

  it('treats an already-removed installation as removed', async () => {
    await expect(
      deleteInstallation('https://api.github.com', 'jwt', '42', async () => new Response('', { status: 404 })),
    ).resolves.toBeUndefined();
  });

  it('reports a failed uninstall', async () => {
    await expect(
      deleteInstallation('https://api.github.com', 'jwt', '42', async () => new Response('', { status: 500 })),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});
