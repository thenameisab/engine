/**
 * Top-level A6 off-site audit: mine the A2 citation archive for a category into
 * citation-domain intelligence + opportunities, summarize mention sentiment and
 * profile completeness for the self-entity, and emit scored `Finding` objects —
 * mirroring runAudit (B1)/runContentAudit (B2)/runEntityAudit (B3) so A6 sits in
 * the same pipeline with the same reproducibility contract (injectable clock/id).
 * The ranked opportunity list is the lead metric (spec §8), persisted separately
 * by the API the way B3 persists strengths.
 */
import type { Finding } from '@engine/core';
import type { CitationObservation, CitationOpportunity, DomainIntel, OffsiteIssueType } from './types.js';
import { buildDomainIntel, citationOpportunities, missingProfiles, sentimentSummary } from './intel.js';
import { actionTemplatesFor, findingSourceFor } from './actions.js';

export interface OffsiteAuditInput {
  selfEntityId: string;
  /** A2 archive observations across the category (self + competitors/peers). */
  observations: readonly CitationObservation[];
  /** Directory/review profile domains expected for the entity's category. */
  knownProfileDomains?: readonly string[];
  /** The self-entity's own mention URLs (for profile completeness). */
  selfMentionUrls?: readonly string[];
}

export interface OffsiteAuditOptions {
  now?: () => string;
  makeId?: (selfEntityId: string, type: OffsiteIssueType, item: string) => string;
}

export interface OffsiteAuditResult {
  domainIntel: DomainIntel[];
  opportunities: CitationOpportunity[];
  findings: Finding[];
}

function defaultId(selfEntityId: string, type: OffsiteIssueType, item: string): string {
  const key = `${selfEntityId}|${type}|${item.trim().toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_o_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function runOffsiteAudit(input: OffsiteAuditInput, options: OffsiteAuditOptions = {}): OffsiteAuditResult {
  const opts: Required<OffsiteAuditOptions> = {
    now: options.now ?? (() => new Date().toISOString()),
    makeId: options.makeId ?? defaultId,
  };

  const domainIntel = buildDomainIntel(input.observations, input.selfEntityId);
  const opportunities = citationOpportunities(domainIntel);
  const sentiment = sentimentSummary(input.observations, input.selfEntityId);
  const missing = missingProfiles(input.knownProfileDomains ?? [], input.selfMentionUrls ?? []);

  const findings: Finding[] = [];

  const push = (type: OffsiteIssueType, item: string, impact: number, evidence: object) => {
    findings.push({
      id: opts.makeId(input.selfEntityId, type, item),
      entityId: input.selfEntityId,
      source: findingSourceFor(type),
      issueType: type,
      severity: impact,
      predictedImpact: impact,
      evidence,
      actionTemplates: actionTemplatesFor(type),
      createdAt: opts.now(),
    });
  };

  for (const o of opportunities) {
    push('absent-from-citation-domain', o.domain, o.impact, {
      domain: o.domain,
      authority: o.authority,
      citationCount: o.citationCount,
      distinctEntities: o.distinctEntities,
    });
  }
  for (const d of missing) {
    // Profile completeness is a fixed, actionable gap — a mid floor so it isn't
    // buried under a single low-authority citation opportunity.
    push('incomplete-third-party-profile', d, 0.5, { profileDomain: d });
  }
  if (sentiment.isCluster) {
    push('negative-mention-cluster', input.selfEntityId, sentiment.share, {
      negative: sentiment.negative,
      total: sentiment.total,
      share: sentiment.share,
    });
  }

  findings.sort((a, b) => b.predictedImpact - a.predictedImpact);
  return { domainIntel, opportunities, findings };
}
