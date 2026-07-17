import { describe, it, expect, vi } from 'vitest';
import { resolvePriceId, buildCheckoutSessionBody, createCheckoutSession } from './checkout.js';
import type { PlanTier } from '@engine/core';

const priceToTier: Record<string, PlanTier> = {
  price_starter_monthly: 'starter',
  price_growth_monthly: 'growth',
};

describe('resolvePriceId', () => {
  it('finds the price id for a configured tier', () => {
    expect(resolvePriceId('growth', priceToTier)).toBe('price_growth_monthly');
  });

  it('returns null for a tier with no configured price (e.g. enterprise, contact-sales)', () => {
    expect(resolvePriceId('enterprise', priceToTier)).toBeNull();
  });
});

describe('buildCheckoutSessionBody', () => {
  it('stamps accountId onto subscription_data.metadata, not top-level metadata', () => {
    const body = buildCheckoutSessionBody({
      priceId: 'price_growth_monthly',
      accountId: 'acct_1',
      successUrl: 'https://app.example.com/billing/success',
      cancelUrl: 'https://app.example.com/billing/cancel',
    });

    // The webhook handler reads accountId off the *subscription* object
    // (mapStripeSubscriptionEvent), which only Checkout's subscription_data
    // metadata reaches — a regression here would silently break every
    // post-checkout webhook.
    expect(body.get('subscription_data[metadata][accountId]')).toBe('acct_1');
    expect(body.get('metadata[accountId]')).toBeNull();
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('line_items[0][price]')).toBe('price_growth_monthly');
    expect(body.get('line_items[0][quantity]')).toBe('1');
    expect(body.get('success_url')).toBe('https://app.example.com/billing/success');
    expect(body.get('cancel_url')).toBe('https://app.example.com/billing/cancel');
  });

  it('includes customer_email only when supplied', () => {
    const withoutEmail = buildCheckoutSessionBody({
      priceId: 'p',
      accountId: 'a',
      successUrl: 's',
      cancelUrl: 'c',
    });
    expect(withoutEmail.has('customer_email')).toBe(false);

    const withEmail = buildCheckoutSessionBody({
      priceId: 'p',
      accountId: 'a',
      successUrl: 's',
      cancelUrl: 'c',
      customerEmail: 'buyer@example.com',
    });
    expect(withEmail.get('customer_email')).toBe('buyer@example.com');
  });
});

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('createCheckoutSession', () => {
  it('posts form-encoded to the real Stripe endpoint with a bearer secret key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' }));
    const body = new URLSearchParams({ mode: 'subscription' });

    const session = await createCheckoutSession('sk_test_123', body, fetchImpl as unknown as typeof fetch);

    expect(session).toEqual({ id: 'cs_1', url: 'https://checkout.stripe.com/cs_1' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk_test_123');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    expect(init.body).toBe('mode=subscription');
  });

  it('throws naming the HTTP status and Stripe error body on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'No such price' } }, false, 400));
    await expect(
      createCheckoutSession('sk_test_123', new URLSearchParams(), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('HTTP 400');
  });
});
