import { describe, it, expect } from 'vitest';
import {
  parseLocalRoster,
  localRosterSize,
  localUserId,
  verifyLocalCredentials,
  signLocalSession,
  verifyLocalSession,
} from './localAuth.js';
import { signOAuthState } from './oauthState.js';

const SECRET = 'local-auth-test-secret';
const ROSTER = 'ada@engine.dev:pw-one:Ada Lovelace,grace@engine.dev:pw-two,alan.turing@engine.dev:pw-three';

describe('parseLocalRoster', () => {
  it('reads email, password and optional display name', () => {
    const roster = parseLocalRoster(ROSTER);
    expect(roster.size).toBe(3);
    expect(roster.get('ada@engine.dev')?.user.name).toBe('Ada Lovelace');
  });

  it('derives a name from the address when none is given', () => {
    expect(parseLocalRoster(ROSTER).get('alan.turing@engine.dev')?.user.name).toBe('Alan Turing');
  });

  it('lower-cases and trims the address, so one person is one principal', () => {
    const roster = parseLocalRoster(' Ada@Engine.dev :pw');
    expect(roster.has('ada@engine.dev')).toBe(true);
    expect(roster.get('ada@engine.dev')?.user.id).toBe('local:ada@engine.dev');
  });

  it('drops entries with no password rather than admitting anyone who guesses the address', () => {
    expect(localRosterSize('ada@engine.dev:,grace@engine.dev:pw')).toBe(1);
  });

  it('drops malformed entries without throwing — a roster typo must break one login, not the API', () => {
    expect(localRosterSize('not-an-email:pw,,:::,grace@engine.dev:pw')).toBe(1);
  });

  it('keeps the first of a duplicated address', () => {
    const roster = parseLocalRoster('ada@engine.dev:first,ada@engine.dev:second');
    expect(roster.size).toBe(1);
    expect(roster.get('ada@engine.dev')?.password).toBe('first');
  });

  it('is empty when unset', () => {
    expect(localRosterSize(undefined)).toBe(0);
    expect(localRosterSize('')).toBe(0);
  });
});

describe('verifyLocalCredentials', () => {
  it('accepts a roster credential and returns the user', () => {
    const user = verifyLocalCredentials('ada@engine.dev', 'pw-one', ROSTER);
    expect(user).toEqual({ id: 'local:ada@engine.dev', email: 'ada@engine.dev', name: 'Ada Lovelace' });
  });

  it('accepts a differently-cased address', () => {
    expect(verifyLocalCredentials('  ADA@Engine.dev ', 'pw-one', ROSTER)?.email).toBe('ada@engine.dev');
  });

  it('rejects a wrong password', () => {
    expect(verifyLocalCredentials('ada@engine.dev', 'pw-two', ROSTER)).toBeNull();
  });

  it('rejects an address that is not on the roster', () => {
    expect(verifyLocalCredentials('stranger@engine.dev', 'pw-one', ROSTER)).toBeNull();
  });

  it('rejects everyone when the roster is unset — an unconfigured gate authenticates nobody', () => {
    expect(verifyLocalCredentials('ada@engine.dev', 'pw-one', undefined)).toBeNull();
    expect(verifyLocalCredentials('ada@engine.dev', '', undefined)).toBeNull();
  });

  it('rejects a missing password even for a real address', () => {
    expect(verifyLocalCredentials('ada@engine.dev', undefined, ROSTER)).toBeNull();
  });
});

describe('session tokens', () => {
  const user = { id: localUserId('ada@engine.dev'), email: 'ada@engine.dev', name: 'Ada Lovelace' };

  it('round-trips a signed session', async () => {
    const token = await signLocalSession(user, SECRET);
    const result = await verifyLocalSession(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.user).toEqual(user);
  });

  it('refuses to mint an unsigned token', async () => {
    await expect(signLocalSession(user, '')).rejects.toThrow(/LOCAL_AUTH_SECRET/);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signLocalSession(user, 'other-secret');
    expect(await verifyLocalSession(token, SECRET)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects a tampered payload', async () => {
    const token = await signLocalSession(user, SECRET);
    const [, sig] = token.split('.');
    const forged = btoa(JSON.stringify({ typ: 'engine-local-session', sub: 'local:evil@x.com', email: 'evil@x.com', name: 'E', iat: 0, exp: 9999999999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyLocalSession(`${forged}.${sig}`, SECRET)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('rejects an expired token', async () => {
    const token = await signLocalSession(user, SECRET, { ttlSeconds: 60, nowSeconds: 1_000 });
    expect(await verifyLocalSession(token, SECRET, { nowSeconds: 1_061 })).toEqual({ ok: false, reason: 'expired' });
    expect((await verifyLocalSession(token, SECRET, { nowSeconds: 1_059 })).ok).toBe(true);
  });

  it('rejects junk and half-tokens as malformed', async () => {
    expect(await verifyLocalSession('nonsense', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyLocalSession('a.b.c', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('verifies nobody when the secret is unset', async () => {
    const token = await signLocalSession(user, SECRET);
    expect(await verifyLocalSession(token, undefined)).toEqual({ ok: false, reason: 'unconfigured' });
  });

  /**
   * The reason `typ` exists. An OAuth state shares this wire format and is
   * handed to the browser by every consent flow; a deployment that reused one
   * secret for both would otherwise let one be replayed as the other, with an
   * attacker-chosen `userId` becoming the session principal.
   */
  it('refuses an OAuth state presented as a session token', async () => {
    const state = await signOAuthState(
      { accountId: 'acct', userId: 'local:evil@x.com', provider: 'gsc' },
      SECRET,
    );
    expect(await verifyLocalSession(state, SECRET)).toEqual({ ok: false, reason: 'wrong-type' });
  });
});
