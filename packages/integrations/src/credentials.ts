/**
 * What is stored for a connection, and how it is sealed.
 *
 * Two things this adds to the sealing primitive in `@engine/auth`:
 *
 * **A credential is a kind, not a refresh token.** The original store had one
 * column, `refresh_token_sealed`, which quietly asserted that every integration
 * is OAuth. An API-key vendor has no refresh token and no token endpoint, and
 * forcing one into that column would mean every reader has to guess what it is
 * holding.
 *
 * **Keys rotate.** `ENCRYPTION_KEY` is a single Worker secret, and the honest
 * consequence of rotating it today is that every stored connection becomes
 * unopenable and every customer must reconnect — which means in practice it is
 * never rotated, and a key that is never rotated is a key that outlives the
 * people who saw it. A keyring fixes that: seal with the primary, open with
 * whichever key sealed it, and re-seal on read so a rotation drains without a
 * migration or a customer noticing.
 */
import { importEncryptionKey, seal, open } from '@engine/auth';
import { IntegrationError } from './errors.js';
import type { ApiKeyAuth, ApiKeyField, IntegrationProvider } from './types.js';

/** An OAuth grant: the long-lived half, plus what we know about the account. */
export interface OAuthCredential {
  kind: 'oauth2';
  refreshToken: string;
}

/**
 * An API key, as a field bag.
 *
 * `secrets` is sealed; `public` is stored in the clear so the UI can show what
 * is configured — an account id or region is not a credential, and hiding it
 * makes a misconfigured connection undiagnosable.
 */
export interface ApiKeyCredential {
  kind: 'api_key';
  secrets: Record<string, string>;
  public: Record<string, string>;
}

export type Credential = OAuthCredential | ApiKeyCredential;

/** The stored form: an opaque sealed blob plus the key version that sealed it. */
export interface SealedCredential {
  kind: Credential['kind'];
  sealed: string;
  keyVersion: string;
  /** Non-secret fields, stored in the clear. Empty for OAuth. */
  public: Record<string, string>;
}

/**
 * The encryption keys this deployment can open, newest first.
 *
 * Parsed from `ENCRYPTION_KEYS` as `version:base64key` pairs, comma-separated,
 * with the first entry being the one new credentials are sealed under. A bare
 * base64 key with no version is accepted and treated as version `v1`, so the
 * existing single-key `ENCRYPTION_KEY` deployment keeps working unchanged.
 */
export interface Keyring {
  primary: { version: string; key: CryptoKey };
  byVersion: Map<string, CryptoKey>;
}

const VERSION_RE = /^[a-z0-9]{1,16}$/;

export async function loadKeyring(spec: string | undefined): Promise<Keyring> {
  if (!spec || spec.trim() === '') {
    throw new IntegrationError('not_configured', 'no encryption key configured — cannot seal or open credentials');
  }
  const entries = spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const byVersion = new Map<string, CryptoKey>();
  let primary: { version: string; key: CryptoKey } | undefined;

  for (const entry of entries) {
    // A base64 key contains '+' and '/' but never ':', so the separator is
    // unambiguous and a versionless key cannot be misparsed as a versioned one.
    const idx = entry.indexOf(':');
    const version = idx === -1 ? 'v1' : entry.slice(0, idx);
    const material = idx === -1 ? entry : entry.slice(idx + 1);
    if (!VERSION_RE.test(version)) {
      throw new IntegrationError('not_configured', `encryption key version must match ${VERSION_RE} — got a malformed entry`);
    }
    if (byVersion.has(version)) {
      throw new IntegrationError('not_configured', `encryption key version '${version}' is listed twice`);
    }
    let key: CryptoKey;
    try {
      key = await importEncryptionKey(material);
    } catch (cause) {
      // The message from importEncryptionKey names the fault (bad base64,
      // wrong length) and never echoes the material.
      throw new IntegrationError('not_configured', `encryption key '${version}' is unusable: ${(cause as Error).message}`, {
        cause,
      });
    }
    byVersion.set(version, key);
    primary ??= { version, key };
  }

  /* c8 ignore next -- entries is non-empty above, so primary is always set. */
  if (!primary) throw new IntegrationError('not_configured', 'no usable encryption key found');
  return { primary, byVersion };
}

/**
 * Bind a sealed blob to its row.
 *
 * Account, provider and kind are authenticated but not encrypted, so a blob
 * lifted out of one account's row and pasted into another's fails to open
 * instead of decrypting cleanly into someone else's live credential. `kind` is
 * in there too: without it, an API-key blob moved into the OAuth column would
 * open successfully and then be sent to a token endpoint.
 */
export function credentialAad(accountId: string, providerId: string, kind: Credential['kind']): string {
  return `${accountId}:${providerId}:${kind}`;
}

export async function sealCredential(
  keyring: Keyring,
  accountId: string,
  providerId: string,
  credential: Credential,
): Promise<SealedCredential> {
  const payload = credential.kind === 'oauth2' ? credential.refreshToken : JSON.stringify(credential.secrets);
  const sealed = await seal(keyring.primary.key, payload, credentialAad(accountId, providerId, credential.kind));
  return {
    kind: credential.kind,
    sealed,
    keyVersion: keyring.primary.version,
    public: credential.kind === 'api_key' ? credential.public : {},
  };
}

export interface OpenedCredential {
  credential: Credential;
  /** True when the blob was sealed under a non-primary key and should be re-sealed. */
  staleKey: boolean;
}

export async function openCredential(
  keyring: Keyring,
  accountId: string,
  providerId: string,
  stored: SealedCredential,
): Promise<OpenedCredential> {
  const key = keyring.byVersion.get(stored.keyVersion);
  if (!key) {
    // Naming the version is safe and is the only way an operator can tell that
    // a key was dropped from the keyring too early, rather than that the data
    // is corrupt.
    throw new IntegrationError(
      'not_configured',
      `credential was sealed with key version '${stored.keyVersion}', which is not in the current keyring`,
      { providerId },
    );
  }
  const plaintext = await open(key, stored.sealed, credentialAad(accountId, providerId, stored.kind));
  const staleKey = stored.keyVersion !== keyring.primary.version;

  if (stored.kind === 'oauth2') {
    return { credential: { kind: 'oauth2', refreshToken: plaintext }, staleKey };
  }
  let secrets: Record<string, string>;
  try {
    secrets = JSON.parse(plaintext) as Record<string, string>;
  } catch {
    throw new IntegrationError('invalid_response', 'stored API-key credential is not valid JSON', { providerId });
  }
  return { credential: { kind: 'api_key', secrets, public: stored.public }, staleKey };
}

/* ── API-key validation ──────────────────────────────────────────────────── */

export interface ApiKeySubmission {
  [field: string]: string;
}

/**
 * Check a submitted API key against the provider's declared fields, and split
 * it into the halves that are stored differently.
 *
 * Validation happens before anything is stored, and before the value is sent
 * anywhere: a rejected paste should cost the customer a form error, not a
 * stored credential that fails silently on the next sync.
 */
export function validateApiKeySubmission(
  provider: IntegrationProvider,
  submission: ApiKeySubmission,
): ApiKeyCredential {
  if (provider.auth.kind !== 'api_key') {
    throw new IntegrationError('invalid_request', `${provider.id} does not take an API key`, { providerId: provider.id });
  }
  const auth: ApiKeyAuth = provider.auth;
  const secrets: Record<string, string> = {};
  const publicFields: Record<string, string> = {};

  for (const field of auth.fields) {
    const raw = submission[field.name];
    if (raw === undefined || raw.trim() === '') {
      throw new IntegrationError('invalid_request', `${field.label} is required`, { providerId: provider.id });
    }
    const value = raw.trim();
    assertFieldShape(provider.id, field, value);
    if (field.secret) secrets[field.name] = value;
    else publicFields[field.name] = value;
  }

  const known = new Set(auth.fields.map((f) => f.name));
  const unexpected = Object.keys(submission).filter((k) => !known.has(k));
  if (unexpected.length > 0) {
    // Refused rather than ignored. A field name we do not recognise means the
    // form and the registry disagree, and silently dropping it would store a
    // credential the customer believes is complete.
    throw new IntegrationError('invalid_request', `unexpected field(s): ${unexpected.join(', ')}`, {
      providerId: provider.id,
    });
  }
  return { kind: 'api_key', secrets, public: publicFields };
}

function assertFieldShape(providerId: string, field: ApiKeyField, value: string): void {
  if (!field.pattern) return;
  // Anchored, so a pattern cannot match a substring of a longer paste — the
  // usual way a trailing newline or a copied surrounding quote gets through.
  const re = new RegExp(`^(?:${field.pattern})$`);
  if (!re.test(value)) {
    // Never echoes the value: this message reaches the UI and the logs, and
    // the whole point of the field is that it is a secret.
    throw new IntegrationError('invalid_request', `${field.label} does not look like a valid value`, { providerId });
  }
}

/**
 * Apply a stored API key to an outbound request, as the provider declares.
 *
 * Returns the pieces rather than mutating a request, so a caller can use it
 * with any client, and so a test can assert placement without a network.
 */
export function applyApiKey(
  provider: IntegrationProvider,
  credential: ApiKeyCredential,
  url: string,
): { url: string; headers: Record<string, string> } {
  if (provider.auth.kind !== 'api_key') {
    throw new IntegrationError('invalid_request', `${provider.id} does not use an API key`, { providerId: provider.id });
  }
  const placement = provider.auth.placement;
  // The first declared secret field is the credential itself; any others are
  // supporting values the vendor's own client would take separately.
  const primaryField = provider.auth.fields.find((f) => f.secret);
  /* c8 ignore next -- the registry guarantees at least one secret field. */
  if (!primaryField) throw new IntegrationError('invalid_request', `${provider.id} declares no secret field`);
  const value = credential.secrets[primaryField.name];
  if (!value) {
    throw new IntegrationError('invalid_credentials', `stored credential is missing ${primaryField.label}`, {
      providerId: provider.id,
    });
  }

  if (placement.in === 'header') {
    return { url, headers: { [placement.name]: `${placement.prefix ?? ''}${value}` } };
  }
  const u = new URL(url);
  u.searchParams.set(placement.name, value);
  return { url: u.toString(), headers: {} };
}
