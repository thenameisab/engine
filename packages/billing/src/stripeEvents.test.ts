import { describe, expect, it } from 'vitest';
import { mapStripeSubscriptionEvent, type StripeWebhookEvent } from './stripeEvents.js';

const PRICE_TO_TIER = { price_growth_monthly: 'growth' } as const;

function event(overrides: Record<string, unknown> = {}): StripeWebhookEvent {
  return {
    id: 'evt_1',
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        current_period_end: 1_700_000_000,
        items: { data: [{ price: { id: 'price_growth_monthly' } }] },
        metadata: { accountId: 'acct_1' },
        ...overrides,
      },
    },
  };
}

describe('mapStripeSubscriptionEvent', () => {
  it('maps an active subscription to our Subscription update shape', () => {
    const result = mapStripeSubscriptionEvent(event(), PRICE_TO_TIER);
    expect(result).toEqual({
      accountId: 'acct_1',
      update: {
        planTier: 'growth',
        status: 'active',
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        currentPeriodEnd: new Date(1_700_000_000 * 1000).toISOString(),
      },
    });
  });

  it('maps Stripe statuses onto our SubscriptionStatus union', () => {
    expect(mapStripeSubscriptionEvent(event({ status: 'past_due' }), PRICE_TO_TIER)?.update.status).toBe('past_due');
    expect(mapStripeSubscriptionEvent(event({ status: 'unpaid' }), PRICE_TO_TIER)?.update.status).toBe('past_due');
    expect(mapStripeSubscriptionEvent(event({ status: 'paused' }), PRICE_TO_TIER)?.update.status).toBe('canceled');
  });

  it('falls back to starter for an unrecognized price id', () => {
    const result = mapStripeSubscriptionEvent(event({ items: { data: [{ price: { id: 'price_unknown' } }] } }), PRICE_TO_TIER);
    expect(result?.update.planTier).toBe('starter');
  });

  it('ignores events with no accountId metadata (nothing to key the upsert on)', () => {
    expect(mapStripeSubscriptionEvent(event({ metadata: {} }), PRICE_TO_TIER)).toBeNull();
  });

  it('ignores non-subscription event types', () => {
    const other: StripeWebhookEvent = { ...event(), type: 'invoice.paid' };
    expect(mapStripeSubscriptionEvent(other, PRICE_TO_TIER)).toBeNull();
  });
});
