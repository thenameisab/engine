/**
 * G — Billing & pricing (PRD §"G — Billing & pricing"). Plan/subscription
 * state is a thin mirror of Stripe's own state machine — Stripe is the
 * source of truth; we sync it via webhook (see @engine/billing) rather than
 * drive it, so this stays a read model, not a second state machine.
 */
export type PlanTier = 'starter' | 'growth' | 'agency' | 'enterprise';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export interface Subscription {
  id: string;
  accountId: string;
  planTier: PlanTier;
  status: SubscriptionStatus;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string;
}

/** G4 usage metering — the counters a plan's limits are checked against. */
export interface UsageCounters {
  projects: number;
  keywords: number;
  prompts: number;
}

/** G1/G5 per-tier caps, incl. the free tier (1 project, 25 kw, 10 prompts, weekly cadence). */
export interface PlanLimits {
  projects: number;
  keywords: number;
  prompts: number;
  cadence: 'weekly' | 'daily' | 'on_demand';
}
