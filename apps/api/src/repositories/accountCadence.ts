/**
 * Per-account cadence policy (issue 10, migration 0034).
 *
 * The defaults live in `@engine/core`'s `CADENCE_DEFAULTS` and follow the
 * plan tier; a row in `account_cadence` holds only what an administrator has
 * overridden. `effectiveCadenceForAccount` is the one place the two are
 * combined, so every scheduler asks the same question the same way.
 */
import {
  effectiveCadence,
  type CadenceOverride,
  type CadenceTier,
  type EffectiveCadence,
  type PlanTier,
} from '@engine/core';
import type { Db } from '../db.js';

interface OverrideRow {
  account_id: string;
  rank_poll: CadenceOverride['rankPoll'];
  ai_poll: CadenceOverride['aiPoll'];
  crawl: CadenceOverride['crawl'];
  updated_by: string | null;
  updated_at: Date;
}

export async function getCadenceOverride(db: Db, accountId: string): Promise<CadenceOverride | null> {
  const rows = await db<OverrideRow[]>`
    select account_id, rank_poll, ai_poll, crawl, updated_by, updated_at
    from account_cadence where account_id = ${accountId}
  `;
  const r = rows[0];
  return r ? { rankPoll: r.rank_poll, aiPoll: r.ai_poll, crawl: r.crawl } : null;
}

/** The tier an account is on: its subscription's, or 'free' with no subscription row. */
export async function cadenceTierForAccount(db: Db, accountId: string): Promise<CadenceTier> {
  const rows = await db<{ plan_tier: PlanTier }[]>`select plan_tier from subscriptions where account_id = ${accountId}`;
  return rows[0]?.plan_tier ?? 'free';
}

export async function effectiveCadenceForAccount(db: Db, accountId: string): Promise<EffectiveCadence> {
  const [tier, override] = await Promise.all([cadenceTierForAccount(db, accountId), getCadenceOverride(db, accountId)]);
  return effectiveCadence(tier, override);
}

/**
 * Set an account's overrides. A null field clears that override back to the
 * plan default; an all-null row is deleted, so "no overrides" and "no row" stay
 * the same fact.
 */
export async function setCadenceOverride(
  db: Db,
  accountId: string,
  override: CadenceOverride,
  updatedBy: string,
): Promise<CadenceOverride | null> {
  if (!override.rankPoll && !override.aiPoll && !override.crawl) {
    await db`delete from account_cadence where account_id = ${accountId}`;
    return null;
  }
  await db`
    insert into account_cadence (account_id, rank_poll, ai_poll, crawl, updated_by, updated_at)
    values (${accountId}, ${override.rankPoll}, ${override.aiPoll}, ${override.crawl}, ${updatedBy}, now())
    on conflict (account_id) do update set
      rank_poll = excluded.rank_poll,
      ai_poll = excluded.ai_poll,
      crawl = excluded.crawl,
      updated_by = excluded.updated_by,
      updated_at = now()
  `;
  return override;
}

export interface AccountCadenceRow {
  accountId: string;
  name: string;
  effective: EffectiveCadence;
  override: CadenceOverride | null;
}

/** Every account with its effective policy — the administrator's cadence panel. */
export async function listAccountCadences(db: Db): Promise<AccountCadenceRow[]> {
  const rows = await db<
    {
      id: string;
      name: string;
      plan_tier: PlanTier | null;
      rank_poll: CadenceOverride['rankPoll'] | null;
      ai_poll: CadenceOverride['aiPoll'] | null;
      crawl: CadenceOverride['crawl'] | null;
      has_override: boolean;
    }[]
  >`
    select a.id, a.name, s.plan_tier, c.rank_poll, c.ai_poll, c.crawl, (c.account_id is not null) as has_override
    from accounts a
    left join subscriptions s on s.account_id = a.id
    left join account_cadence c on c.account_id = a.id
    order by a.created_at asc
  `;
  return rows.map((r) => {
    const override = r.has_override ? { rankPoll: r.rank_poll, aiPoll: r.ai_poll, crawl: r.crawl } : null;
    return { accountId: r.id, name: r.name, effective: effectiveCadence(r.plan_tier ?? 'free', override), override };
  });
}
