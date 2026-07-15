import type { PlanTier, Subscription, SubscriptionStatus, UsageCounters } from '@engine/core';
import type { SubscriptionUpdate } from '@engine/billing';
import type { Db } from '../db.js';

interface SubRow {
  id: string;
  account_id: string;
  plan_tier: PlanTier;
  status: SubscriptionStatus;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  updated_at: Date;
}

function toSubscription(row: SubRow): Subscription {
  return {
    id: row.id,
    accountId: row.account_id,
    planTier: row.plan_tier,
    status: row.status,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getSubscription(db: Db, accountId: string): Promise<Subscription | null> {
  const rows = await db<SubRow[]>`select * from subscriptions where account_id = ${accountId}`;
  return rows[0] ? toSubscription(rows[0]) : null;
}

/** Upsert the Stripe-sourced subscription state for an account (G3 webhook sync). */
export async function upsertSubscription(
  db: Db,
  accountId: string,
  update: SubscriptionUpdate,
): Promise<Subscription> {
  const [row] = await db<SubRow[]>`
    insert into subscriptions (account_id, plan_tier, status, stripe_customer_id, stripe_subscription_id, current_period_end)
    values (
      ${accountId}, ${update.planTier}, ${update.status}, ${update.stripeCustomerId},
      ${update.stripeSubscriptionId}, ${update.currentPeriodEnd}
    )
    on conflict (account_id) do update set
      plan_tier = excluded.plan_tier,
      status = excluded.status,
      stripe_customer_id = excluded.stripe_customer_id,
      stripe_subscription_id = excluded.stripe_subscription_id,
      current_period_end = excluded.current_period_end,
      updated_at = now()
    returning *
  `;
  return toSubscription(row);
}

/** G4 usage metering: live counts, not a cached snapshot — cheap enough at MVP scale. */
export async function getUsageCounters(db: Db, accountId: string): Promise<UsageCounters> {
  const [row] = await db<{ projects: number; keywords: number; prompts: number }[]>`
    select
      (select count(*)::int from projects where account_id = ${accountId}) as projects,
      (select count(*)::int from keyword_configs kc
         join entities e on e.id = kc.entity_id
         join projects p on p.id = e.project_id
         where p.account_id = ${accountId}) as keywords,
      (select coalesce(sum(array_length(e.prompts, 1)), 0)::int from entities e
         join projects p on p.id = e.project_id
         where p.account_id = ${accountId}) as prompts
  `;
  return row;
}
