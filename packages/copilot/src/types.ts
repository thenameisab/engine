import type { ConfidenceBand, Finding } from '@engine/core';

/**
 * M2.4 "Copilot GA": NL question -> cited, drill-downable answer <3s.
 *
 * The intent taxonomy is deliberately small and closed. The Copilot answers
 * over data three pillars already produce, joined entity-first (A1 organic
 * rank, A2 AI citation band, B1 findings) — so an intent is a *route into an
 * existing query*, never an open-ended generator. A question we can't map to
 * one of these is answered honestly as `unknown` rather than hallucinated.
 */
export type CopilotIntentType =
  | 'entity_visibility' // "how is X doing" -> full cross-SEO/GEO summary
  | 'organic_vs_ai' // "am I stronger in Google or AI for X"
  | 'top_findings' // "what should I fix for X"
  | 'keyword_rank' // "where do I rank for <kw>" (entity-scoped)
  | 'unknown';

export interface ParsedIntent {
  type: CopilotIntentType;
  entityId?: string;
  entityName?: string;
  /** Only set for keyword_rank: the phrase the user asked to rank-check. */
  keyword?: string;
  raw: string;
}

/**
 * Every numeric claim in an answer carries one of these, naming the exact
 * table the number came from and (where drill-down applies) the row id. This
 * is the anti-hallucination contract: the phrasing layer may reword the prose
 * but can never introduce a figure that isn't backed by a citation the
 * retrieval layer emitted.
 */
export interface Citation {
  source: 'serp_positions' | 'citation_events' | 'findings';
  /** Human-readable, e.g. "12 keywords tracked (A1)". */
  label: string;
  /** Row id for drill-down (findingId / entityId), when the source has one. */
  ref?: string;
}

export interface DrilldownRef {
  kind: 'entity' | 'finding';
  id: string;
}

/**
 * The Finding -> Action bridge (roadmap house rule: every module ships its
 * mapping). When an answer surfaces a fixable finding, it also hands the UI
 * the exact call that turns diagnosis into a proposed fix — the M2.3
 * `POST /projects/:id/findings/:findingId/propose` route — so the Copilot is a
 * launch point for execution, not just a read surface.
 */
export interface SuggestedAction {
  findingId: string;
  issueType: string;
  actionType: string;
  /** The propose endpoint the dashboard POSTs to. */
  proposeHref: string;
  label: string;
}

export interface CopilotAnswer {
  intent: CopilotIntentType;
  entityId?: string;
  answer: string;
  citations: Citation[];
  drilldown: DrilldownRef[];
  suggestedAction?: SuggestedAction;
}

/**
 * The retrieved facts the answer builder phrases. Shape mirrors the M2.2
 * `EntityCopilotSummary` (so the same entity-first join feeds both), plus an
 * optional resolved keyword rank for `keyword_rank`.
 */
export interface CopilotData {
  entityId: string;
  canonicalName: string;
  organic: { sov: number; keywordsTracked: number };
  ai: { band: ConfidenceBand; samplesObserved: number };
  topFindings: Finding[];
  keywordRank?: { keyword: string; position: number | null };
}
