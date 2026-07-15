/**
 * Pure mapper from a Stripe `customer.subscription.*` webhook event to our
 * internal Subscription read model (G3). Stripe is the source of truth for
 * subscription state; we only mirror it, keyed by the `accountId` we require
 * callers to stash in the subscription's metadata at checkout time (Stripe's
 * documented pattern for linking objects back to your own IDs).
 */
import type { PlanTier, Subscription, SubscriptionStatus } from '@engine/core';

/** The subset of Stripe's Subscription object shape this mapper reads. */
export interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: string;
  current_period_end: number;
  items: { data: { price: { id: string } }[] };
  metadata?: Record<string, string>;
}

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

const STRIPE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  canceled: 'canceled',
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete',
  unpaid: 'past_due',
  paused: 'canceled',
};

export type SubscriptionUpdate = Omit<Subscription, 'id' | 'accountId' | 'updatedAt'>;

/**
 * Maps a `customer.subscription.created|updated|deleted` event to a
 * `{ accountId, update }` pair the caller can upsert. Returns null for event
 * types this mapper doesn't handle, or if the event is missing the
 * `accountId` metadata we require (nothing to key the upsert on).
 */
export function mapStripeSubscriptionEvent(
  event: StripeWebhookEvent,
  priceToTier: Record<string, PlanTier>,
): { accountId: string; update: SubscriptionUpdate } | null {
  if (!event.type.startsWith('customer.subscription.')) return null;

  const obj = event.data.object as StripeSubscriptionObject;
  const accountId = obj.metadata?.accountId;
  if (!accountId) return null;

  const priceId = obj.items?.data?.[0]?.price?.id;
  const planTier = (priceId && priceToTier[priceId]) || 'starter';

  return {
    accountId,
    update: {
      planTier,
      status: STRIPE_STATUS_MAP[obj.status] ?? 'incomplete',
      stripeCustomerId: obj.customer,
      stripeSubscriptionId: obj.id,
      currentPeriodEnd: new Date(obj.current_period_end * 1000).toISOString(),
    },
  };
}
