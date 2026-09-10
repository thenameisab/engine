/**
 * B3 detection rules. Deterministic checks over one entity's graph facts,
 * producing raw issues plus the component sub-scores that make up its
 * strength. Kept separate from `audit.ts` (which maps issues -> Findings) so
 * the thresholds are unit-testable in isolation.
 */
import type { EntityGraphFacts, EntityIssueType, EntityStrength } from './types.js';
import { findEntityBlock, sameAsOf } from './schema.js';
import { corroborationScore, distinctSourceDomains, registrableDomain } from './corroboration.js';

export interface RawEntityIssue {
  type: EntityIssueType;
  /** 0–1 severity: how bad this specific entity's gap is. */
  severity: number;
  evidence: Record<string, unknown>;
}

/** Below this corroboration score, an entity is flagged weak-corroboration. */
export const WEAK_CORROBORATION_BELOW = 0.5;

/**
 * Fraction of the entity's known official profiles that appear in its on-site
 * sameAs. 1 when there are no known profiles to check (nothing to be
 * inconsistent with) or all are present; lower as profiles are omitted.
 *
 * The entity's own site is excluded from the comparison. `sameAs` lists the
 * *other* places an entity is — schema.org states the entity's own site with
 * `url` — so counting it as a missing profile would flag every correctly
 * marked-up site the moment the crawler started recording which domain served
 * the pages.
 */
function sameAsConsistency(knownProfiles: string[], onSiteSameAs: string[], siteDomain: string | null): number {
  const own = siteDomain ? registrableDomain(siteDomain) : null;
  const known = new Set(
    knownProfiles
      .map((u) => registrableDomain(u))
      .filter((d): d is string => !!d && d !== own),
  );
  if (known.size === 0) return 1;
  const present = new Set(onSiteSameAs.map((u) => registrableDomain(u)).filter((d): d is string => !!d));
  let hit = 0;
  for (const d of known) if (present.has(d)) hit++;
  return hit / known.size;
}

export interface EntityInspection {
  issues: RawEntityIssue[];
  strength: EntityStrength;
}

/** Inspect one entity: emit its issues and its strength breakdown. */
export function inspectEntity(facts: EntityGraphFacts): EntityInspection {
  const issues: RawEntityIssue[] = [];

  // B3.1 Wikidata mapping.
  const hasWikidata = !!facts.wikidataId && facts.wikidataId.trim() !== '';
  if (!hasWikidata) {
    issues.push({ type: 'missing-wikidata-mapping', severity: 0.6, evidence: { canonicalName: facts.canonicalName } });
  }

  // B3.2 on-site entity schema.
  const entityBlock = findEntityBlock(facts.schema, facts.canonicalName);
  const hasSchema = entityBlock !== null;
  if (!hasSchema) {
    issues.push({
      type: 'missing-entity-schema',
      severity: 0.8,
      evidence: { canonicalName: facts.canonicalName, schemaBlocksSeen: facts.schema.length },
    });
  }

  // B3.1 sameAs consistency (only meaningful when there is a block carrying sameAs).
  const onSiteSameAs = entityBlock ? sameAsOf(entityBlock) : [];
  const consistency = sameAsConsistency(facts.urls, onSiteSameAs, facts.siteDomain);
  // Flag only when the entity actually has known profiles and a schema block to
  // carry them — a missing block is already reported as missing-entity-schema,
  // not double-counted here.
  if (hasSchema && consistency < 1) {
    const own = facts.siteDomain ? registrableDomain(facts.siteDomain) : null;
    const knownDomains = [...new Set(facts.urls.map((u) => registrableDomain(u)).filter((d) => d && d !== own))];
    const presentDomains = [...new Set(onSiteSameAs.map((u) => registrableDomain(u)).filter(Boolean))];
    issues.push({
      type: 'inconsistent-sameas',
      severity: 1 - consistency,
      evidence: { knownProfiles: knownDomains, onSiteSameAs: presentDomains, consistency },
    });
  }

  // B3.4 corroboration.
  const domains = distinctSourceDomains(facts.mentions, facts.citations, onSiteSameAs);
  const corroboration = corroborationScore(domains.size);
  if (corroboration < WEAK_CORROBORATION_BELOW) {
    issues.push({
      type: 'weak-corroboration',
      severity: 1 - corroboration,
      evidence: { distinctSourceDomains: domains.size, sources: [...domains] },
    });
  }

  const components = {
    wikidata: hasWikidata ? 1 : 0,
    schema: hasSchema ? 1 : 0,
    sameAsConsistency: consistency,
    corroboration,
  };
  // Weighted blend: schema + corroboration carry the most (they're the AI-facing
  // signals), wikidata and sameAs support them.
  const score =
    0.3 * components.schema +
    0.3 * components.corroboration +
    0.2 * components.wikidata +
    0.2 * components.sameAsConsistency;

  return {
    issues,
    strength: {
      entityId: facts.id,
      canonicalName: facts.canonicalName,
      score,
      components,
      corroboratingDomains: domains.size,
    },
  };
}
