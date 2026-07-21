/**
 * Top-level B3 entity-graph audit: run the deterministic checks over a
 * project's entities and emit scored `Finding` objects (source `'entity'`)
 * plus each entity's strength breakdown — mirroring `runAudit` (B1) and
 * `runContentAudit` (B2) so B3 sits in the same pipeline with the same
 * reproducibility contract (injectable clock/id).
 */
import type { Finding } from '@engine/core';
import type { EntityGraphFacts, EntityStrength } from './types.js';
import { inspectEntity, type RawEntityIssue } from './rules.js';
import { actionTemplatesFor } from './actions.js';

export interface EntityAuditOptions {
  now?: () => string;
  makeId?: (facts: EntityGraphFacts, issue: RawEntityIssue) => string;
}

export interface EntityAuditResult {
  findings: Finding[];
  /** Every entity's strength breakdown, independent of whether it crossed a threshold. */
  strengths: EntityStrength[];
}

function defaultId(facts: EntityGraphFacts, issue: RawEntityIssue): string {
  const key = `${facts.id}|${issue.type}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_e_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

function toFinding(facts: EntityGraphFacts, issue: RawEntityIssue, opts: Required<EntityAuditOptions>): Finding {
  return {
    id: opts.makeId(facts, issue),
    entityId: facts.id,
    source: 'entity',
    issueType: issue.type,
    // Continuous severity — the gap's own badness, like B2 (not a fixed weight
    // table like B1). predictedImpact leans the same way; entity integrity
    // affects every downstream join, so a mid impact floor keeps these from
    // being ranked below a single low-value page's technical nit.
    severity: issue.severity,
    predictedImpact: Math.max(0.4, issue.severity),
    evidence: issue.evidence,
    actionTemplates: actionTemplatesFor(issue.type),
    createdAt: opts.now(),
  };
}

export function runEntityAudit(entities: readonly EntityGraphFacts[], options: EntityAuditOptions = {}): EntityAuditResult {
  const opts: Required<EntityAuditOptions> = {
    now: options.now ?? (() => new Date().toISOString()),
    makeId: options.makeId ?? defaultId,
  };

  const findings: Finding[] = [];
  const strengths: EntityStrength[] = [];

  for (const facts of entities) {
    const { issues, strength } = inspectEntity(facts);
    strengths.push(strength);
    for (const issue of issues) findings.push(toFinding(facts, issue, opts));
  }

  findings.sort((a, b) => b.predictedImpact - a.predictedImpact);
  return { findings, strengths };
}
