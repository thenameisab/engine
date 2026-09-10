import { describe, expect, it } from 'vitest';
import { loadKeyring, sealCredential } from '@engine/integrations';
import { resolveSerpKey } from './repositories/serpKey.js';
import type { Db } from './db.js';

/**
 * Whose Serper key a rank lookup spends. Worth its own test because the wrong
 * answer is invisible: falling back when the client has a key spends our
 * credit on their lookups, and refusing to fall back takes rank tracking away
 * from every client who has connected nothing.
 */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/** A database that answers one query with the rows given. */
function dbReturning(rows: unknown[]): Db {
  return (async () => rows) as unknown as Db;
}

async function connectedRow(apiKey: string) {
  const keyring = await loadKeyring(KEY);
  const sealed = await sealCredential(keyring, ACCOUNT, 'serper', {
    kind: 'api_key',
    secrets: { apiKey },
    public: {},
  });
  return {
    keyring,
    row: {
      status: 'connected',
      granted_scopes: [],
      secret_sealed: sealed.sealed,
      credential_kind: 'api_key',
      key_version: sealed.keyVersion,
      public_fields: {},
    },
  };
}

describe('resolveSerpKey', () => {
  it("uses the client's own key when Serper is connected", async () => {
    const { keyring, row } = await connectedRow('client-key');
    const resolved = await resolveSerpKey(dbReturning([row]), ACCOUNT, keyring, {
      SERPER_API_KEY: 'platform-key',
    });
    expect(resolved).toBe('client-key');
  });

  it('falls back to the platform key when the client has connected nothing', async () => {
    const keyring = await loadKeyring(KEY);
    const resolved = await resolveSerpKey(dbReturning([]), ACCOUNT, keyring, {
      SERPER_API_KEY: 'platform-key',
    });
    expect(resolved).toBe('platform-key');
  });

  it('falls back when the stored credential was cleared, rather than refusing the lookup', async () => {
    const keyring = await loadKeyring(KEY);
    const cleared = { status: 'connected', granted_scopes: [], secret_sealed: null, credential_kind: null };
    const resolved = await resolveSerpKey(dbReturning([cleared]), ACCOUNT, keyring, {
      SERPER_API_KEY: 'platform-key',
    });
    expect(resolved).toBe('platform-key');
  });

  it('falls back when the sealed credential cannot be opened, not 500s the poll', async () => {
    // The state every stored connection is left in by an ENCRYPTION_KEY
    // rotation. This used to throw out of resolveSerpKey and fail the whole
    // rank poll, so on rotation day every customer with their own Serper key
    // lost rank tracking instead of quietly falling back to ours.
    const { row } = await connectedRow('client-key');
    const otherKeyring = await loadKeyring(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
    const resolved = await resolveSerpKey(dbReturning([row]), ACCOUNT, otherKeyring, {
      SERPER_API_KEY: 'platform-key',
    });
    expect(resolved).toBe('platform-key');
  });

  it('returns null when neither key exists, so the route can say so', async () => {
    const keyring = await loadKeyring(KEY);
    expect(await resolveSerpKey(dbReturning([]), ACCOUNT, keyring, {})).toBeNull();
  });
});
