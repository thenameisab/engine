/**
 * How often each kind of measurement runs, per account (issue 10).
 *
 * The rhythms differ because the costs and the underlying rates of change
 * differ. Rank positions move day to day and each lookup is billed by Serper.
 * AI answers come from a model's trained knowledge, which changes only when
 * the vendor ships a model, so polling often buys sampling precision rather
 * than fresher truth. A crawl is the expensive one, and the trigger that
 * matters is a content change. Deterministic audits call no vendor and run
 * nightly for everyone, so they are not a setting.
 */
import type { PlanTier } from './billing.js';

export type RankPollCadence = 'daily' | 'weekly';
export type AiPollCadence = 'weekly' | 'monthly';
export type CrawlCadence = 'weekly' | 'monthly' | 'on_demand';

export interface CadencePolicy {
  rankPoll: RankPollCadence;
  aiPoll: AiPollCadence;
  crawl: CrawlCadence;
}

/** An account with no subscription row is on the free tier. */
export type CadenceTier = PlanTier | 'free';

/**
 * The defaults from §5 of the 2026-09-10 action plan. Every paid tier shares
 * one rhythm; the free tier is slower on the two that cost money per call and
 * on the crawl.
 */
export const CADENCE_DEFAULTS: Record<CadenceTier, CadencePolicy> = {
  free: { rankPoll: 'weekly', aiPoll: 'monthly', crawl: 'monthly' },
  starter: { rankPoll: 'daily', aiPoll: 'weekly', crawl: 'weekly' },
  growth: { rankPoll: 'daily', aiPoll: 'weekly', crawl: 'weekly' },
  agency: { rankPoll: 'daily', aiPoll: 'weekly', crawl: 'weekly' },
  enterprise: { rankPoll: 'daily', aiPoll: 'weekly', crawl: 'weekly' },
};

/** A stored override: null means "use the plan default" for that field. */
export interface CadenceOverride {
  rankPoll: RankPollCadence | null;
  aiPoll: AiPollCadence | null;
  crawl: CrawlCadence | null;
}

export type CadenceSource = 'override' | 'plan-default';

/** The policy an account actually runs on, and where each value came from. */
export interface EffectiveCadence {
  tier: CadenceTier;
  policy: CadencePolicy;
  source: { rankPoll: CadenceSource; aiPoll: CadenceSource; crawl: CadenceSource };
}

export function effectiveCadence(tier: CadenceTier, override: CadenceOverride | null): EffectiveCadence {
  const base = CADENCE_DEFAULTS[tier];
  return {
    tier,
    policy: {
      rankPoll: override?.rankPoll ?? base.rankPoll,
      aiPoll: override?.aiPoll ?? base.aiPoll,
      crawl: override?.crawl ?? base.crawl,
    },
    source: {
      rankPoll: override?.rankPoll ? 'override' : 'plan-default',
      aiPoll: override?.aiPoll ? 'override' : 'plan-default',
      crawl: override?.crawl ? 'override' : 'plan-default',
    },
  };
}

/**
 * How long after the last measurement the next one is due, in hours.
 *
 * Each is short of its nominal period for the reason the rank poll's weekly
 * window is 6 days 12 hours rather than 7: a cron fires with drift, and
 * requiring the full period turns weekly into every-eighth-day.
 */
export const CADENCE_WINDOW_HOURS = {
  daily: 20,
  weekly: 6 * 24 + 12,
  monthly: 29 * 24 + 12,
} as const;
