/**
 * Top-level B1 audit: run the rule engine over a crawl and emit scored `Finding`
 * objects plus the lead "technical health score" (§8). This is the M1.3 output —
 * the diagnosis feedstock the Fix Queue consumes.
 *
 * Deterministic and side-effect free: ids and timestamps are injected so the
 * whole audit is reproducible in tests. `runAudit(pages)` with no options uses
 * real time + content-hashed ids.
 */
import type { Finding } from '@engine/core';
import type { CrawledPage } from './page.js';
import { detectIssues, type RawIssue } from './rules.js';
import { actionTemplatesFor, nonExecutableReasonFor, type IssueType } from './actions.js';
import { severityFor, predictedImpact } from './severity.js';

export interface AuditOptions {
  /** Injected clock for reproducible `createdAt`. Defaults to `Date.now`-based ISO. */
  now?: () => string;
  /** Injected id factory. Defaults to a stable content hash of url+type. */
  makeId?: (page: CrawledPage, issue: RawIssue) => string;
}

export interface AuditResult {
  findings: Finding[];
  /** One-number technical health score, 0-100 (higher is healthier). */
  healthScore: number;
  /** Count of findings that carry at least one executable action template (§8). */
  autoFixableCount: number;
  /** Pages crawled, for context on the score. */
  pagesAudited: number;
}

/** Build a single scored Finding from a page + raw issue. */
function toFinding(page: CrawledPage, issue: RawIssue, opts: Required<AuditOptions>): Finding {
  const type = issue.type;
  const templates = actionTemplatesFor(type);
  const reason = nonExecutableReasonFor(type);

  // §7 contract guard: a finding must carry an action template OR a documented
  // reason it can't. This should be impossible to violate given the actions
  // table, but we fail loud rather than silently ship an unactionable finding.
  if (templates.length === 0 && !reason) {
    throw new Error(`Finding "${type}" has no action template and no documented reason (§7 violation)`);
  }

  return {
    id: opts.makeId(page, issue),
    entityId: page.entityId,
    source: 'technical',
    issueType: type,
    severity: severityFor(type),
    predictedImpact: predictedImpact(type, page.pageValue),
    evidence: reason ? { ...issue.evidence, nonExecutableReason: reason } : issue.evidence,
    actionTemplates: templates,
    createdAt: opts.now(),
  };
}

/**
 * Technical health score (§8), 0-100. We start at 100 and subtract a penalty per
 * finding proportional to its predicted impact (severity x page value), so a few
 * high-impact issues hurt more than many trivial ones. Normalized by pages
 * audited so the score is comparable across sites of different sizes and never
 * runs away below 0.
 */
function healthScore(findings: Finding[], pagesAudited: number): number {
  if (pagesAudited === 0) return 100;
  const totalPenalty = findings.reduce((sum, f) => sum + f.predictedImpact, 0);
  // Scale: average predicted-impact-per-page of 1.0 would zero the score.
  const normalized = (totalPenalty / pagesAudited) * 100;
  return Math.max(0, Math.round(100 - normalized));
}

function defaultId(page: CrawledPage, issue: RawIssue): string {
  const key = `${page.entityId}|${page.url}|${issue.type}`;
  // Small deterministic FNV-1a hash → hex; ids only need to be stable + unique
  // per (page, issue-type), not cryptographic.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function runAudit(pages: readonly CrawledPage[], options: AuditOptions = {}): AuditResult {
  const opts: Required<AuditOptions> = {
    now: options.now ?? (() => new Date().toISOString()),
    makeId: options.makeId ?? defaultId,
  };

  const findings: Finding[] = [];
  for (const page of pages) {
    for (const issue of detectIssues(page)) {
      findings.push(toFinding(page, issue, opts));
    }
  }

  // Lead the inventory with the most impactful issues first (§8).
  findings.sort((a, b) => b.predictedImpact - a.predictedImpact);

  const autoFixableCount = findings.filter((f) => f.actionTemplates.length > 0).length;

  return {
    findings,
    healthScore: healthScore(findings, pages.length),
    autoFixableCount,
    pagesAudited: pages.length,
  };
}

export type { IssueType };
