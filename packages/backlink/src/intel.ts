/**
 * A6 citation-domain intelligence + quality scoring. Deterministic aggregation
 * of the A2 citation archive into per-domain intelligence, then the citation
 * opportunities the self-entity is absent from. Kept separate from `audit.ts`
 * (which maps opportunities/mentions -> Findings) so the math is unit-testable
 * in isolation.
 */
import type { CitationObservation, CitationOpportunity, DomainIntel } from './types.js';

/** Registrable domain of a URL/host — the citation-domain unit. */
export function registrableDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const host = s.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].replace(/^www\./, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length < 2) return host || null;
  return labels.slice(-2).join('.');
}

/**
 * Category authority for a domain: saturates on the number of *distinct*
 * entities whose answers cite it. One entity citing a domain 50 times is a
 * single relationship; five different entities citing it is a category-wide
 * authoritative source. Saturates at 5 distinct entities (like B3's
 * corroboration score), so the signal is "breadth of trust", not raw volume.
 */
export const AUTHORITY_SATURATION = 5;
export function authorityScore(distinctEntities: number): number {
  if (distinctEntities <= 0) return 0;
  return Math.min(1, distinctEntities / AUTHORITY_SATURATION);
}

/**
 * Build per-domain intelligence across a category of observations, marking
 * which domains the self-entity is present on. Domains are returned sorted by
 * authority desc, then citationCount desc, then domain for stable ordering.
 */
export function buildDomainIntel(
  observations: readonly CitationObservation[],
  selfEntityId: string,
): DomainIntel[] {
  const map = new Map<
    string,
    { count: number; entities: Set<string>; engines: Set<string>; self: boolean }
  >();

  for (const obs of observations) {
    const domains = new Set<string>();
    for (const raw of obs.citedDomains) {
      const d = registrableDomain(raw);
      if (d) domains.add(d);
    }
    for (const d of domains) {
      const e = map.get(d) ?? { count: 0, entities: new Set<string>(), engines: new Set<string>(), self: false };
      e.count += 1;
      e.entities.add(obs.entityId);
      e.engines.add(obs.engine);
      if (obs.entityId === selfEntityId) e.self = true;
      map.set(d, e);
    }
  }

  const intel: DomainIntel[] = [];
  for (const [domain, e] of map) {
    intel.push({
      domain,
      citationCount: e.count,
      distinctEntities: e.entities.size,
      engines: [...e.engines].sort(),
      authority: authorityScore(e.entities.size),
      selfPresent: e.self,
    });
  }
  intel.sort(
    (a, b) => b.authority - a.authority || b.citationCount - a.citationCount || a.domain.localeCompare(b.domain),
  );
  return intel;
}

/** Below this authority a domain is not worth flagging as an opportunity. */
export const OPPORTUNITY_MIN_AUTHORITY = 0.4;

/**
 * Citation opportunities: high-authority category citation domains the
 * self-entity is absent from, ranked by impact (authority weighted up when
 * more distinct entities already rely on the domain). These are the "where
 * digital PR would most move AI citation" targets for C6.
 */
export function citationOpportunities(intel: readonly DomainIntel[]): CitationOpportunity[] {
  const opps: CitationOpportunity[] = [];
  for (const d of intel) {
    if (d.selfPresent) continue; // already cited via this domain — not an opportunity
    if (d.authority < OPPORTUNITY_MIN_AUTHORITY) continue;
    opps.push({
      domain: d.domain,
      authority: d.authority,
      citationCount: d.citationCount,
      distinctEntities: d.distinctEntities,
      impact: d.authority,
    });
  }
  opps.sort((a, b) => b.impact - a.impact || b.citationCount - a.citationCount || a.domain.localeCompare(b.domain));
  return opps;
}

/** At/above this share of an entity's observations being negative, flag a cluster. */
export const NEGATIVE_CLUSTER_MIN_SHARE = 0.3;
export const NEGATIVE_CLUSTER_MIN_COUNT = 2;

export interface SentimentSummary {
  total: number;
  negative: number;
  share: number;
  isCluster: boolean;
}

/** Summarize the self-entity's answer sentiment; flags a negative cluster. */
export function sentimentSummary(observations: readonly CitationObservation[], selfEntityId: string): SentimentSummary {
  const own = observations.filter((o) => o.entityId === selfEntityId && o.sentiment !== null);
  const total = own.length;
  const negative = own.filter((o) => o.sentiment === 'negative').length;
  const share = total === 0 ? 0 : negative / total;
  const isCluster = negative >= NEGATIVE_CLUSTER_MIN_COUNT && share >= NEGATIVE_CLUSTER_MIN_SHARE;
  return { total, negative, share, isCluster };
}

/**
 * Profile-completeness gap: known directory/review profile domains (G2,
 * Capterra, JustDial, …) the entity has no mention on. Set-difference over the
 * entity's own mention domains, normalized to registrable domains.
 */
export function missingProfiles(knownProfileDomains: readonly string[], entityMentionUrls: readonly string[]): string[] {
  const have = new Set<string>();
  for (const u of entityMentionUrls) {
    const d = registrableDomain(u);
    if (d) have.add(d);
  }
  const missing: string[] = [];
  for (const raw of knownProfileDomains) {
    const d = registrableDomain(raw);
    if (d && !have.has(d)) missing.push(d);
  }
  return [...new Set(missing)].sort();
}
