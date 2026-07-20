/**
 * Top-level B2 content audit: run the heuristic scorer over a crawl and emit
 * scored `Finding` objects, mirroring `@engine/diagnosis`'s `runAudit` for
 * the technical pillar. Deterministic and side-effect free — same
 * reproducibility contract (injectable clock/id) as B1, so this can sit
 * alongside it in `/audit` without becoming a second untestable path.
 */
import type { Finding } from '@engine/core';
import type { CrawledPage } from '@engine/diagnosis';
import { detectContentIssues, type RawContentIssue } from './rules.js';
import { actionTemplatesFor } from './actions.js';
import type { ExtractabilityScore, EntityCoverageFacts } from './score.js';

export interface ContentAuditOptions {
  now?: () => string;
  makeId?: (page: CrawledPage, issue: RawContentIssue) => string;
  /** B2.1 entity coverage facts per entity id — the caller looks these up (this package has no DB access). Omitted entries score `entityCoverage: 'not-measured'`. */
  entities?: ReadonlyMap<string, EntityCoverageFacts>;
}

export interface PageExtractability {
  url: string;
  score: ExtractabilityScore;
}

export interface ContentAuditResult {
  findings: Finding[];
  /** Every scored page's breakdown, independent of whether it crossed a finding threshold — the dashboard needs the number, not just the alerts. */
  pageScores: PageExtractability[];
  /** Pages with no captured content (`bodyText` absent) — not scored, not silently treated as passing. */
  pagesWithoutContent: number;
}

function toFinding(page: CrawledPage, issue: RawContentIssue, opts: Required<Omit<ContentAuditOptions, 'entities'>>): Finding {
  return {
    id: opts.makeId(page, issue),
    entityId: page.entityId,
    source: 'content',
    issueType: issue.type,
    // The dimension score itself is the honesty signal here (0-1, continuous)
    // rather than a fixed per-type weight table like B1's: severity IS how
    // bad this specific page's heuristic score is, not an intrinsic property
    // of the issue type.
    severity: clamp01(1 - issue.evidence.score),
    predictedImpact: clamp01(1 - issue.evidence.score) * clamp01(page.pageValue ?? 0.5),
    evidence: issue.evidence,
    actionTemplates: actionTemplatesFor(issue.type),
    createdAt: opts.now(),
  };
}

function defaultId(page: CrawledPage, issue: RawContentIssue): string {
  const key = `${page.entityId}|${page.url}|${issue.type}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnd_c_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function runContentAudit(pages: readonly CrawledPage[], options: ContentAuditOptions = {}): ContentAuditResult {
  const opts: Required<Omit<ContentAuditOptions, 'entities'>> = {
    now: options.now ?? (() => new Date().toISOString()),
    makeId: options.makeId ?? defaultId,
  };
  const entities = options.entities;

  const findings: Finding[] = [];
  const pageScores: PageExtractability[] = [];
  let pagesWithoutContent = 0;

  for (const page of pages) {
    const { issues, score } = detectContentIssues(page, entities?.get(page.entityId));
    if (!score) {
      pagesWithoutContent++;
      continue;
    }
    pageScores.push({ url: page.url, score });
    for (const issue of issues) findings.push(toFinding(page, issue, opts));
  }

  findings.sort((a, b) => b.predictedImpact - a.predictedImpact);

  return { findings, pageScores, pagesWithoutContent };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
