/**
 * G1/G5 plan tiers and their caps. Only Starter's numbers are pinned by the
 * blueprint (G5: free tier = 1 project, 25 keywords, 10 prompts, weekly
 * cadence) — Growth/Agency/Enterprise limits below are provisional
 * placeholders pending real pricing sign-off, kept generous so they never
 * block a design partner before that sign-off happens.
 */
import type { PlanLimits, PlanTier, UsageCounters } from '@engine/core';

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  starter: { projects: 1, keywords: 25, prompts: 10, cadence: 'weekly' },
  growth: { projects: 5, keywords: 250, prompts: 100, cadence: 'daily' },
  agency: { projects: 25, keywords: 1000, prompts: 500, cadence: 'daily' },
  enterprise: { projects: Infinity, keywords: Infinity, prompts: Infinity, cadence: 'daily' },
};

/** G4 usage metering vs. G5 caps — true if any counter has exceeded the plan's limit. */
export function isOverLimit(usage: UsageCounters, tier: PlanTier): boolean {
  const limits = PLAN_LIMITS[tier];
  return usage.projects > limits.projects || usage.keywords > limits.keywords || usage.prompts > limits.prompts;
}
