import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash, dummyHash, DEFAULT_ITERATIONS } from './passwordHash.js';

// Every test here uses a small iteration count deliberately. The default is
// 100,000, and a suite that pays that cost per assertion would be slow enough
// that people stop running it. The count is a stored parameter, so the code
// paths are identical either way — that is the property being relied on, and
// the round-trip test below asserts it holds at the real default too.
const FAST = 1_000;

describe('hashPassword', () => {
  it('produces the documented self-describing format', async () => {
    const stored = await hashPassword('correct horse', { iterations: FAST });
    const parts = stored.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('pbkdf2-sha256');
    expect(parts[1]).toBe(String(FAST));
    expect(parts[2]).not.toHaveLength(0);
    expect(parts[3]).not.toHaveLength(0);
  });

  // Deliberately a made-up literal. A real password used as a fixture is a
  // real password committed to git, in every clone and every CI log.
  it('never stores the password itself', async () => {
    const secret = 'not-a-real-password-9f3a';
    const stored = await hashPassword(secret, { iterations: FAST });
    expect(stored).not.toContain(secret);
  });

  // The three pre-alpha users were issued the same password. Without a
  // per-user salt, one leaked hash would read as three, and the rows would
  // visibly reveal that the passwords match.
  it('gives the same password two unrelated hashes', async () => {
    const a = await hashPassword('same-password', { iterations: FAST });
    const b = await hashPassword('same-password', { iterations: FAST });
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', a)).toBe(true);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('refuses an empty password rather than storing a hash of nothing', async () => {
    await expect(hashPassword('', { iterations: FAST })).rejects.toThrow(/empty password/);
  });

  it('refuses a nonsense iteration count', async () => {
    await expect(hashPassword('x', { iterations: 0 })).rejects.toThrow(/invalid iteration count/);
    await expect(hashPassword('x', { iterations: 1.5 })).rejects.toThrow(/invalid iteration count/);
  });
});

describe('verifyPassword', () => {
  it('round-trips at the real default iteration count', async () => {
    const stored = await hashPassword('a real password', { iterations: DEFAULT_ITERATIONS });
    expect(await verifyPassword('a real password', stored)).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const stored = await hashPassword('right', { iterations: FAST });
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('is case- and whitespace-exact', async () => {
    const stored = await hashPassword('Secret', { iterations: FAST });
    expect(await verifyPassword('secret', stored)).toBe(false);
    expect(await verifyPassword(' Secret', stored)).toBe(false);
    expect(await verifyPassword('Secret ', stored)).toBe(false);
  });

  // A corrupt row must reject one login, not throw. An exception here would
  // surface as a 500 and tell an attacker they had found something unusual.
  it('returns false rather than throwing on a malformed stored value', async () => {
    for (const bad of [
      '',
      'not-a-hash',
      'pbkdf2-sha256$100000$onlythree',
      'pbkdf2-sha256$notanumber$c2FsdA$aGFzaA',
      'pbkdf2-sha256$0$c2FsdA$aGFzaA',
      'bcrypt$10$c2FsdA$aGFzaA',
      'pbkdf2-sha256$1000$$aGFzaA',
      'pbkdf2-sha256$1000$c2FsdA$',
    ]) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('rejects an empty or missing presented password', async () => {
    const stored = await hashPassword('x', { iterations: FAST });
    expect(await verifyPassword('', stored)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
  });

  // The salt is what makes the hash unforgeable from the password alone; a
  // verification that ignored it would accept a hash derived with any salt.
  it('does not verify against a hash of the same password with a different salt', async () => {
    const stored = await hashPassword('shared', {
      iterations: FAST,
      salt: new Uint8Array(16).fill(1),
    });
    const other = await hashPassword('shared', {
      iterations: FAST,
      salt: new Uint8Array(16).fill(2),
    });
    expect(stored).not.toBe(other);
    // Swap in the other hash's digest, keeping this one's salt: must not verify.
    const [, iters, salt] = stored.split('$');
    const forged = `pbkdf2-sha256$${iters}$${salt}$${other.split('$')[3]}`;
    expect(await verifyPassword('shared', forged)).toBe(false);
  });
});

describe('needsRehash', () => {
  it('flags a hash made with a lower work factor', async () => {
    const stored = await hashPassword('x', { iterations: FAST });
    expect(needsRehash(stored, FAST * 2)).toBe(true);
  });

  it('leaves a current hash alone', async () => {
    const stored = await hashPassword('x', { iterations: FAST });
    expect(needsRehash(stored, FAST)).toBe(false);
    expect(needsRehash(stored, FAST - 1)).toBe(false);
  });

  it('says no for a hash it cannot parse — there is no sign-in to upgrade', () => {
    expect(needsRehash('garbage')).toBe(false);
    expect(needsRehash(undefined)).toBe(false);
  });
});

describe('dummyHash', () => {
  // This exists so the unknown-address path spends the same time as the
  // wrong-password path. If it were not a real, parseable hash, verifyPassword
  // would bail out before deriving anything and the timing gap would be back.
  it('is parseable, so verifying against it performs a real derivation', async () => {
    const dummy = dummyHash(FAST);
    expect(dummy.split('$')).toHaveLength(4);
    expect(dummy.split('$')[1]).toBe(String(FAST));
    expect(await verifyPassword('anything at all', dummy)).toBe(false);
  });

  it('carries the current work factor by default', () => {
    expect(dummyHash().split('$')[1]).toBe(String(DEFAULT_ITERATIONS));
  });
});
