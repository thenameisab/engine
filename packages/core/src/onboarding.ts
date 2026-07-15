/**
 * E1-E3 onboarding activation (PRD §"E — Onboarding & activation"). Every
 * timestamp here is set once, the first time that milestone happens, so the
 * record doubles as the KPI instrumentation the roadmap's exit criteria
 * depend on: **first insight <10 min** (E2) and **first proposed fix <48h**
 * (E3), measured from `domainConnectedAt`.
 */
export interface OnboardingProgress {
  projectId: string;
  domainConnectedAt: string | null;
  gscConnectedAt: string | null;
  firstCrawlAt: string | null;
  firstInsightAt: string | null;
  firstFixProposedAt: string | null;
  firstFixDeployedAt: string | null;
}

export type OnboardingStep =
  | 'domain_connected'
  | 'gsc_connected'
  | 'first_crawl'
  | 'first_insight'
  | 'first_fix_proposed'
  | 'first_fix_deployed';

/** Milliseconds between two ISO timestamps, or null if either hasn't happened yet. */
export function durationMs(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  return new Date(toIso).getTime() - new Date(fromIso).getTime();
}
