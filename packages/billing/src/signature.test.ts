import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from './signature.js';

const SECRET = 'whsec_test_secret';
const PAYLOAD = JSON.stringify({ id: 'evt_test_webhook', type: 'customer.subscription.updated' });

/** Built independently of the implementation under test (node:crypto, not Web Crypto) as a cross-check. */
function sign(payload: string, secret: string, timestamp: number): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

describe('verifyStripeSignature', () => {
  it('accepts a correctly signed payload within the tolerance window', async () => {
    const now = 1_700_000_000;
    const sig = sign(PAYLOAD, SECRET, now);
    const header = `t=${now},v1=${sig}`;
    await expect(verifyStripeSignature(PAYLOAD, header, SECRET, 300, now)).resolves.toBe(true);
  });

  it('accepts when one of several v1 signatures matches (secret rotation)', async () => {
    const now = 1_700_000_000;
    const sig = sign(PAYLOAD, SECRET, now);
    const header = `t=${now},v1=deadbeef,v1=${sig}`;
    await expect(verifyStripeSignature(PAYLOAD, header, SECRET, 300, now)).resolves.toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const now = 1_700_000_000;
    const sig = sign(PAYLOAD, SECRET, now);
    const header = `t=${now},v1=${sig}`;
    await expect(verifyStripeSignature(PAYLOAD + 'tampered', header, SECRET, 300, now)).resolves.toBe(false);
  });

  it('rejects the wrong secret', async () => {
    const now = 1_700_000_000;
    const sig = sign(PAYLOAD, SECRET, now);
    const header = `t=${now},v1=${sig}`;
    await expect(verifyStripeSignature(PAYLOAD, header, 'whsec_wrong', 300, now)).resolves.toBe(false);
  });

  it('rejects a timestamp outside the replay-tolerance window', async () => {
    const signedAt = 1_700_000_000;
    const sig = sign(PAYLOAD, SECRET, signedAt);
    const header = `t=${signedAt},v1=${sig}`;
    const now = signedAt + 301;
    await expect(verifyStripeSignature(PAYLOAD, header, SECRET, 300, now)).resolves.toBe(false);
  });

  it('rejects a malformed header', async () => {
    await expect(verifyStripeSignature(PAYLOAD, 'not-a-real-header', SECRET)).resolves.toBe(false);
  });
});
