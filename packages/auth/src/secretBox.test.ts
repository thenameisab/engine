import { describe, it, expect } from 'vitest';
import { importEncryptionKey, seal, open, credentialAad } from './secretBox.js';

/** A valid 32-byte key, base64. Test-only value, never a real secret. */
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 7 + 11) & 0xff)));
const OTHER_KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => (i * 13 + 3) & 0xff)));

const AAD = credentialAad('acct-1', 'gsc');

describe('importEncryptionKey', () => {
  it('rejects a missing key rather than defaulting to one', async () => {
    await expect(importEncryptionKey(undefined)).rejects.toThrow(/ENCRYPTION_KEY is not set/);
  });

  it('rejects a key that is not 32 bytes, instead of stretching it', async () => {
    const short = btoa('too-short');
    await expect(importEncryptionKey(short)).rejects.toThrow(/must decode to 32 bytes/);
  });

  it('rejects a non-base64 key', async () => {
    await expect(importEncryptionKey('not!valid!base64!')).rejects.toThrow(/not valid base64/);
  });
});

describe('seal / open', () => {
  it('round-trips a credential', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const token = '1//0abcdefgRefreshTokenValue';
    expect(await open(key, await seal(key, token, AAD), AAD)).toBe(token);
  });

  it('never emits the plaintext in the sealed blob', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const sealed = await seal(key, 'super-secret-refresh-token', AAD);
    expect(sealed).not.toContain('super-secret-refresh-token');
    expect(sealed.startsWith('v1.')).toBe(true);
  });

  it('produces a different blob each time, so equal tokens are not correlatable', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const a = await seal(key, 'same-token', AAD);
    const b = await seal(key, 'same-token', AAD);
    expect(a).not.toBe(b);
    // ...and both still open to the same plaintext.
    expect(await open(key, a, AAD)).toBe(await open(key, b, AAD));
  });

  it('fails to open under a different key', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const other = await importEncryptionKey(OTHER_KEY_B64);
    const sealed = await seal(key, 'token', AAD);
    await expect(open(other, sealed, AAD)).rejects.toThrow(/failed to open/);
  });

  it('fails to open under a different aad — a blob moved between accounts is useless', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const sealed = await seal(key, 'token', credentialAad('acct-1', 'gsc'));
    await expect(open(key, sealed, credentialAad('acct-2', 'gsc'))).rejects.toThrow(/failed to open/);
  });

  it('fails to open when the provider half of the aad differs', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const sealed = await seal(key, 'token', credentialAad('acct-1', 'gsc'));
    await expect(open(key, sealed, credentialAad('acct-1', 'gbp'))).rejects.toThrow(/failed to open/);
  });

  it('detects a tampered ciphertext instead of returning garbage', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const sealed = await seal(key, 'token', AAD);
    const [v, iv, ct] = sealed.split('.');
    // Flip a character in the ciphertext.
    const flipped = ct[0] === 'A' ? `B${ct.slice(1)}` : `A${ct.slice(1)}`;
    await expect(open(key, `${v}.${iv}.${flipped}`, AAD)).rejects.toThrow(/failed to open/);
  });

  it('rejects an unknown version rather than guessing the format', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const sealed = await seal(key, 'token', AAD);
    const rest = sealed.split('.').slice(1).join('.');
    await expect(open(key, `v2.${rest}`, AAD)).rejects.toThrow(/unsupported sealed-credential version/);
  });

  it('rejects a malformed blob', async () => {
    const key = await importEncryptionKey(KEY_B64);
    await expect(open(key, 'not-a-sealed-blob', AAD)).rejects.toThrow(/malformed/);
  });

  it('round-trips a long token and unicode', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const value = `${'x'.repeat(2048)}·café·🔐`;
    expect(await open(key, await seal(key, value, AAD), AAD)).toBe(value);
  });
});
