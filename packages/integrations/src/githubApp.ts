/**
 * GitHub App installations — minting access rather than storing it.
 *
 * Every other provider here hands us a long-lived secret we seal and keep. A
 * GitHub App works the other way round: the only secret is Engine's own App
 * private key, held once in `platform_credentials`, and per-customer access is
 * *derived* from it on demand. A short-lived JWT signed with that key is
 * exchanged for an installation token good for an hour, so nothing
 * per-customer is stored, nothing expires unnoticed, and revoking access is
 * something the customer does on GitHub without us being involved.
 *
 * Everything vendor-specific is here; the routes only call these functions.
 */
import { IntegrationError } from './errors.js';

/** GitHub rejects a JWT with `exp` more than 10 minutes out. Nine leaves room for clock skew. */
const JWT_TTL_SECONDS = 9 * 60;

/**
 * Backdate `iat` by a minute. GitHub compares it against its own clock and
 * rejects a token issued "in the future", which a Worker whose clock is a few
 * seconds ahead would otherwise produce intermittently — the worst kind of
 * auth bug to diagnose.
 */
const IAT_SKEW_SECONDS = 60;

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** DER length octets: short form under 128, long form above. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return [0x80 | bytes.length, ...bytes];
}

/** SEQUENCE / OCTET STRING wrapper around already-encoded contents. */
function derWrap(tag: number, contents: Uint8Array): Uint8Array {
  const header = [tag, ...derLength(contents.length)];
  const out = new Uint8Array(header.length + contents.length);
  out.set(header, 0);
  out.set(contents, header.length);
  return out;
}

/** `AlgorithmIdentifier` for rsaEncryption with the NULL parameter, verbatim. */
const RSA_ALGORITHM_ID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

function pemBody(pem: string, label: string): Uint8Array {
  const body = pem
    .replace(`-----BEGIN ${label}-----`, '')
    .replace(`-----END ${label}-----`, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The App private key as PKCS#8 DER, which is the only form WebCrypto imports.
 *
 * GitHub's download button gives a **PKCS#1** key (`BEGIN RSA PRIVATE KEY`),
 * so importing what an administrator actually has fails with an opaque
 * `DataError`. Rather than make the setup instructions include an `openssl
 * pkcs8` incantation — and field the support conversation every time someone
 * misses it — a PKCS#1 key is wrapped into a PKCS#8 envelope here. The
 * envelope is pure structure: version 0, the rsaEncryption algorithm id, and
 * the original key as an OCTET STRING. No key material is altered.
 */
export function toPkcs8(pem: string): Uint8Array {
  if (pem.includes('BEGIN PRIVATE KEY')) return pemBody(pem, 'PRIVATE KEY');
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    const pkcs1 = pemBody(pem, 'RSA PRIVATE KEY');
    const version = new Uint8Array([0x02, 0x01, 0x00]);
    const wrapped = derWrap(0x04, pkcs1);
    const contents = new Uint8Array(version.length + RSA_ALGORITHM_ID.length + wrapped.length);
    contents.set(version, 0);
    contents.set(RSA_ALGORITHM_ID, version.length);
    contents.set(wrapped, version.length + RSA_ALGORITHM_ID.length);
    return derWrap(0x30, contents);
  }
  if (pem.includes('BEGIN ENCRYPTED PRIVATE KEY')) {
    throw new IntegrationError(
      'not_configured',
      'the GitHub App private key is passphrase-protected; upload an unencrypted key',
    );
  }
  throw new IntegrationError(
    'not_configured',
    'the GitHub App private key is not a PEM private key — paste the .pem file GitHub gave you, in full',
  );
}

async function importAppKey(privateKeyPem: string): Promise<CryptoKey> {
  const pkcs8 = toPkcs8(privateKeyPem);
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8 as unknown as ArrayBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  } catch (cause) {
    // Never echo the material, same rule as the encryption keyring.
    throw new IntegrationError('not_configured', 'the GitHub App private key could not be read', { cause });
  }
}

/**
 * A JWT proving Engine is this App. `iss` is the App id; GitHub accepts it for
 * app-level calls only (reading the App, minting installation tokens) — it can
 * never touch a repository, which is what installation tokens are for.
 */
export async function signAppJwt(
  appId: string,
  privateKeyPem: string,
  now: Date = new Date(),
): Promise<string> {
  const issued = Math.floor(now.getTime() / 1000) - IAT_SKEW_SECONDS;
  const header = encodeSegment({ alg: 'RS256', typ: 'JWT' });
  const payload = encodeSegment({ iat: issued, exp: issued + JWT_TTL_SECONDS, iss: appId });
  const signingInput = `${header}.${payload}`;
  const key = await importAppKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput) as unknown as ArrayBuffer,
  );
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`;
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
}

async function githubJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchImpl(url, { ...init, headers: { ...headers(token), ...(init?.headers ?? {}) } });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    // 401/404 on an app-level call means the App id and the private key do not
    // belong together, which is a configuration fault and not a customer's.
    const code = res.status === 401 || res.status === 404 ? 'not_configured' : 'vendor_error';
    throw new IntegrationError(code, `GitHub ${init?.method ?? 'GET'} ${new URL(url).pathname} failed: HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as T;
}

export interface AppIdentity {
  slug: string;
  name: string;
}

/**
 * The App's own record. Read for its `slug`, which the install URL needs and
 * which changes if an administrator renames the App — so it is fetched rather
 * than stored, and a rename cannot leave a link that 404s.
 */
export async function fetchAppIdentity(
  apiBaseUrl: string,
  appJwt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AppIdentity> {
  const app = await githubJson<{ slug?: string; name?: string }>(`${apiBaseUrl}/app`, appJwt, fetchImpl);
  if (!app.slug) {
    throw new IntegrationError('vendor_error', 'GitHub did not report the App slug');
  }
  return { slug: app.slug, name: app.name ?? app.slug };
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/**
 * Exchange the App JWT for an installation token — an hour of access to
 * exactly the repositories that installation was granted, and nothing else on
 * GitHub.
 */
export async function mintInstallationToken(
  apiBaseUrl: string,
  appJwt: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationToken> {
  const body = await githubJson<{ token?: string; expires_at?: string }>(
    `${apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    appJwt,
    fetchImpl,
    { method: 'POST' },
  );
  if (!body.token) throw new IntegrationError('vendor_error', 'GitHub returned no installation token');
  return { token: body.token, expiresAt: body.expires_at ?? '' };
}

export interface InstallationAccount {
  installationId: string;
  /** The GitHub user or organisation that installed the App. */
  login: string;
}

/** One installation's own record, for naming the connection after the account that made it. */
export async function fetchInstallation(
  apiBaseUrl: string,
  appJwt: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<InstallationAccount> {
  const body = await githubJson<{ id?: number; account?: { login?: string } }>(
    `${apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}`,
    appJwt,
    fetchImpl,
  );
  return { installationId, login: body.account?.login ?? 'your GitHub account' };
}

export interface InstallationRepository {
  /** `owner/name`, which is what a `github-pr` deploy target stores. */
  fullName: string;
  defaultBranch: string;
  private: boolean;
}

/**
 * The repositories this installation may touch — exactly what the customer
 * ticked when installing, no more. This is what turns the deploy-target repo
 * field from a box you type a guess into to a list of real choices.
 */
export async function listInstallationRepositories(
  apiBaseUrl: string,
  installationToken: string,
  fetchImpl: typeof fetch = fetch,
  perPage = 100,
): Promise<InstallationRepository[]> {
  const body = await githubJson<{
    repositories?: { full_name?: string; default_branch?: string; private?: boolean }[];
  }>(`${apiBaseUrl}/installation/repositories?per_page=${perPage}`, installationToken, fetchImpl);
  return (body.repositories ?? [])
    .filter((r): r is { full_name: string; default_branch?: string; private?: boolean } => Boolean(r.full_name))
    .map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? 'main',
      private: r.private ?? false,
    }));
}

/**
 * Remove the installation at GitHub. Unlike an OAuth revocation this is a real
 * uninstall: the customer's repositories stop being reachable immediately, and
 * the App disappears from their installed list rather than lingering with no
 * grant behind it.
 */
export async function deleteInstallation(
  apiBaseUrl: string,
  appJwt: string,
  installationId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(`${apiBaseUrl}/app/installations/${encodeURIComponent(installationId)}`, {
    method: 'DELETE',
    headers: headers(appJwt),
  });
  // 404 means it is already gone, which is the state we wanted.
  if (!res.ok && res.status !== 404) {
    throw new IntegrationError('vendor_error', `GitHub uninstall failed: HTTP ${res.status}`);
  }
}
