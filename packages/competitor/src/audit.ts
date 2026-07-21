/**
 * Top-level A5 competitor gap analysis: compute the five gap dimensions for a
 * project's self-entity against its competitor set and emit scored `Finding`
 * objects — mirroring `runAudit` (B1), `runContentAudit` (B2) and
 * `runEntityAudit` (B3) so A5 sits in the same pipeline with the same
 * reproducibility contract (injectable clock/id). Each gap becomes at most one
 * Finding; the ranked gap list itself is the lead metric (spec §8) and is
 * persisted separately by the API, the way B3 persists strengths.
 */
import type { Finding } from '@engine/core';
import type { CompetitorFacts, Gap } from './types.js';
import { computeGaps } from './gaps.js';
import { actionTemplatesFor, findingSourceFor } from './actions.js';

export interface CompetitorAuditOptions {
  now?: () => string;
  makeId?: (selfEntityId: string, gap: Gap) => string;
  /**
   * Only gaps at or above this impact emit a Finding — keeps the Fix Queue
   * focused on the gaps worth acting on while the full ranked list still shows
   * in the gap tables. Default 0 (every gap emits).
   */
  minImpactForFinding?: number;
}

export interface CompetitorAuditResult {
  gaps: Gap[];
  byType: ReturnType<typeof computeGaps>['byType'];
  findings: Finding[];
}

function defaultId(selfEntityId: string, gap: Gap): string {
  const key = `${selfEntityId}|${gap.type}|${gap.item.trim().toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_c_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function toFinding(selfEntityId: string, gap: Gap, opts: Required<CompetitorAuditOptions>): Finding {
  return {
    id: opts.makeId(selfEntityId, gap),
    entityId: selfEntityId,
    source: findingSourceFor(gap.type),
    issueType: gap.type,
    // Continuous severity from the gap's own impact (share of the field that
    // beats you / strength delta), like B2/B3 rather than a fixed weight table.
    severity: gap.impact,
    predictedImpact: gap.impact,
    evidence: { item: gap.item, heldBy: gap.heldBy, ...gap.evidence },
    actionTemplates: actionTemplatesFor(gap.type),
    createdAt: opts.now(),
  };
}

export function runCompetitorAudit(
  self: CompetitorFacts,
  competitors: readonly CompetitorFacts[],
  options: CompetitorAuditOptions = {},
): CompetitorAuditResult {
  const opts: Required<CompetitorAuditOptions> = {
    now: options.now ?? (() => new Date().toISOString()),
    makeId: options.makeId ?? defaultId,
    minImpactForFinding: options.minImpactForFinding ?? 0,
  };

  const { gaps, byType } = computeGaps(self, competitors);
  const findings = gaps
    .filter((g) => g.impact >= opts.minImpactForFinding)
    .map((g) => toFinding(self.entityId, g, opts));

  return { gaps, byType, findings };
}
