/**
 * M1.7 "Starter/Growth purchasable via Stripe" — the checkout half of G3.
 * `STRIPE_SECRET_KEY` was registered in `@engine/config`'s integration
 * registry as "only needed for outbound calls (creating checkout sessions /
 * portal links)" from the start, but nothing ever made that call: the
 * webhook handler could receive a subscription update, but no route could
 * create the subscription a customer would actually pay for.
 *
 * Calls Stripe's REST API directly via `fetch`, not the Stripe SDK — same
 * reasoning as `signature.ts`: this runs in Cloudflare Workers, where the
 * Node-targeted Stripe SDK doesn't fit cleanly, and Stripe's Checkout Sessions
 * endpoint is a plain form-encoded POST with no SDK-specific behavior worth
 * the dependency.
 */
import type { PlanTier } from '@engine/core';

/**
 * Find the Stripe price id for a tier from the same `STRIPE_PRICE_TO_TIER`
 * map the webhook handler already reads (price id -> tier) — inverted here
 * rather than introducing a second `STRIPE_PRICE_TO_TIER`-shaped env var,
 * which could drift out of sync with the one the webhook trusts. Returns
 * null if the tier has no price configured (e.g. 'enterprise', which is a
 * contact-sales tier, not self-serve).
 */
export function resolvePriceId(tier: PlanTier, priceToTier: Record<string, PlanTier>): string | null {
  for (const [priceId, t] of Object.entries(priceToTier)) {
    if (t === tier) return priceId;
  }
  return null;
}

export interface CheckoutSessionInput {
  priceId: string;
  accountId: string;
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}

/**
 * Build the form-encoded body Stripe's `POST /v1/checkout/sessions` expects.
 * Pure and unit-testable without a live Stripe account (same testability
 * goal as `stripeEvents.ts`/`signature.ts`).
 *
 * `subscription_data[metadata][accountId]`, not top-level `metadata`: the
 * webhook handler reads `accountId` off the *subscription* object
 * (`mapStripeSubscriptionEvent` -> `obj.metadata?.accountId`), and Checkout
 * only stamps `subscription_data.metadata` onto the subscription it creates —
 * a top-level session metadata field would never reach it, silently breaking
 * the exact link the webhook depends on.
 */
export function buildCheckoutSessionBody(input: CheckoutSessionInput): URLSearchParams {
  const params = new URLSearchParams();
  params.set('mode', 'subscription');
  params.set('line_items[0][price]', input.priceId);
  params.set('line_items[0][quantity]', '1');
  params.set('success_url', input.successUrl);
  params.set('cancel_url', input.cancelUrl);
  params.set('subscription_data[metadata][accountId]', input.accountId);
  if (input.customerEmail) params.set('customer_email', input.customerEmail);
  return params;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
}

/** Create the Checkout Session against Stripe's real API. `fetchImpl` is injectable for testing. */
export async function createCheckoutSession(
  secretKey: string,
  body: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSession> {
  const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Stripe checkout session creation failed: HTTP ${res.status} ${detail}`);
  }
  return (await res.json()) as CheckoutSession;
}
