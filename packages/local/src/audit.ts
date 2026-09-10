/**
 * Top-level B5 local audit: run the deterministic GBP/NAP/review checks over a
 * location's profile facts and emit scored `Finding` objects (source `'local'`)
 * plus the location's local visibility breakdown — mirroring runAudit (B1),
 * runContentAudit (B2), runEntityAudit (B3) so B5 sits in the same pipeline
 * with the same reproducibility contract (injectable clock/id + now).
 */
import type { Finding } from '@engine/core';
import type { LocalIssueType, LocalProfileFacts, LocalVisibility } from './types.js';
import {
  blendedScore,
  gbpCompleteness,
  gbpFieldStatuses,
  napConsistency,
  reviewHealth,
  REVIEW_VELOCITY_TARGET,
} from './score.js';
import { actionTemplatesFor } from './actions.js';

export interface LocalAuditOptions {
  now?: () => string;
  clock?: () => number;
  makeId?: (entityId: string, type: LocalIssueType, item: string) => string;
}

export interface LocalAuditResult {
  findings: Finding[];
  visibility: LocalVisibility;
}

function defaultId(entityId: string, type: LocalIssueType, item: string): string {
  const key = `${entityId}|${type}|${item.trim().toLowerCase()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_l_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function runLocalAudit(facts: LocalProfileFacts, options: LocalAuditOptions = {}): LocalAuditResult {
  const opts: Required<LocalAuditOptions> = {
    now: options.now ?? (() => new Date().toISOString()),
    clock: options.clock ?? (() => Date.now()),
    makeId: options.makeId ?? defaultId,
  };

  const gbp = gbpCompleteness(facts);
  const nap = napConsistency(facts);
  const review = reviewHealth(facts.reviews, opts.clock);
  // Unmeasured, not zero: see `blendedScore`.
  const measuredReviewHealth = facts.reviewsSourced ? review.health : null;
  const score = blendedScore(gbp, nap.consistency, measuredReviewHealth);

  const findings: Finding[] = [];
  const push = (type: LocalIssueType, item: string, impact: number, evidence: object) => {
    findings.push({
      id: opts.makeId(facts.entityId, type, item),
      entityId: facts.entityId,
      source: 'local',
      issueType: type,
      severity: impact,
      predictedImpact: impact,
      evidence,
      actionTemplates: actionTemplatesFor(type),
      createdAt: opts.now(),
    });
  };

  // B5.1 GBP completeness — one finding per missing field.
  for (const s of gbpFieldStatuses(facts)) {
    if (!s.present) push('incomplete-gbp-field', s.field, 0.5, { field: s.field });
  }

  // B5.2 NAP consistency — one finding per inconsistent directory listing.
  for (const l of nap.inconsistent) {
    push('nap-inconsistency', l.source, 0.6, {
      source: l.source,
      listed: { name: l.name, address: l.address, phone: l.phone },
      canonical: { name: facts.name, address: facts.address, phone: facts.phone },
    });
  }

  // B5.3 reviews — unanswered cluster + low velocity.
  // No review findings when reviews were never sourced: "you have unanswered
  // reviews" is not something to tell an owner on the strength of an empty
  // list nobody filled.
  if (facts.reviewsSourced && review.unanswered > 0) {
    const impact = Math.min(0.7, 0.3 + 0.1 * review.unanswered);
    push('unanswered-reviews', facts.entityId, impact, { unanswered: review.unanswered, total: facts.reviews.length });
  }
  if (facts.reviewsSourced && review.recentCount < REVIEW_VELOCITY_TARGET) {
    push('low-review-velocity', facts.entityId, 0.4, { recentCount: review.recentCount, target: REVIEW_VELOCITY_TARGET });
  }

  findings.sort((a, b) => b.predictedImpact - a.predictedImpact);

  const visibility: LocalVisibility = {
    entityId: facts.entityId,
    canonicalName: facts.canonicalName,
    score,
    components: { gbpCompleteness: gbp, napConsistency: nap.consistency, reviewHealth: measuredReviewHealth },
    reviewsConsidered: facts.reviews.length,
  };

  return { findings, visibility };
}
