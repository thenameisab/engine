/**
 * B2.2/B2.3/B2.4 heuristic extractability scoring — the v1 "beats a heuristic
 * baseline" the roadmap's M2.1 exit criterion is measured against
 * (`docs/feature-specs/B2-content-extractability.md` §6/§10: "start with
 * heuristic + few-shot LLM, swap to trained classifier as labels
 * accumulate"). No LLM, no embeddings, no training corpus — this package
 * *is* the baseline a future classifier has to beat, not the classifier.
 *
 * B2.1 entity/topic coverage is deliberately not scored here: it needs the
 * entity's known keyword set (from the entity graph, M2.2), which nothing
 * passes into this pure, page-only scorer yet. Wiring it is a documented
 * follow-up, not a silent gap — `extractabilityScore` reports
 * `entityCoverage: 'not-measured'` rather than guessing a 0 that would read
 * as "no coverage" instead of "not checked".
 */
import type { CrawledPage } from '@engine/diagnosis';

export interface ExtractabilityScore {
  /** 0-100 combined heuristic score (answer-first + self-containment + E-E-A-T, weighted). */
  score: number;
  breakdown: {
    answerFirst: number;
    selfContainment: number;
    eeat: number;
  };
  /** B2.1 — not scored by this package yet; see module doc comment. */
  entityCoverage: 'not-measured';
}

const FILLER_OPENERS = [
  'welcome to',
  'in this article',
  'in this post',
  'in today’s world',
  "in today's world",
  'have you ever wondered',
];

const DANGLING_OPENERS = new Set(['this', 'it', 'they', 'these', 'that', 'such', 'those']);

/** The text before the second heading (or the whole body, if there's one heading or none) — the page's "lead". */
function leadText(page: CrawledPage): string {
  const body = page.bodyText ?? '';
  const headings = page.headings ?? [];
  if (headings.length < 2 || !body) return body;
  const secondHeadingIdx = body.indexOf(headings[1].text);
  return secondHeadingIdx > 0 ? body.slice(0, secondHeadingIdx) : body;
}

/**
 * B2.2 "does the page lead with the answer?" A reasonable-length lead
 * paragraph, present shortly after an H1, that doesn't open with throat-
 * clearing filler, scores well. This can't detect whether the lead is
 * *correct* — only whether it's structurally positioned to be an answer.
 */
export function answerFirstScore(page: CrawledPage): number {
  const lead = leadText(page).trim();
  if (!lead || (page.headings ?? []).length === 0) return 0;

  const wordCount = lead.split(/\s+/).filter(Boolean).length;
  const lengthScore = wordCount >= 20 && wordCount <= 150 ? 1 : wordCount > 0 ? 0.4 : 0;

  const lower = lead.slice(0, 120).toLowerCase();
  const hasFiller = FILLER_OPENERS.some((f) => lower.startsWith(f) || lower.includes(f));
  const fillerScore = hasFiller ? 0 : 1;

  return clamp01(lengthScore * 0.6 + fillerScore * 0.4);
}

/**
 * B2.3 "can a passage stand alone as a quote?" Splits on blank lines /
 * sentence-like breaks and scores the fraction of substantial paragraphs
 * that don't open with a pronoun referring back to prior context — a
 * paragraph an AI engine could lift as a self-contained citation shouldn't
 * need "this"/"it"/"they" resolved from the paragraph before it.
 */
export function selfContainmentScore(page: CrawledPage): number {
  const body = page.bodyText ?? '';
  if (!body) return 0;

  const paragraphs = body
    .split(/\n{2,}|(?<=[.!?])\s{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.split(/\s+/).length >= 8);

  if (paragraphs.length === 0) return 0;

  const selfContained = paragraphs.filter((p) => {
    const firstWord = p.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, '');
    return !DANGLING_OPENERS.has(firstWord);
  });

  return clamp01(selfContained.length / paragraphs.length);
}

const BYLINE_RE = /\b[Bb]y\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+/;
const DATE_RE = /\b(published|updated|last modified)\b/i;
const AUTHOR_SCHEMA_TYPES = new Set(['Person', 'Article', 'NewsArticle', 'BlogPosting']);

/**
 * B2.4 E-E-A-T signal detection: byline, a published/updated date, and
 * authorship-carrying structured data — presence heuristics, not a
 * credibility judgment (which needs a model this package deliberately
 * doesn't have).
 */
export function eeatScore(page: CrawledPage): number {
  const body = page.bodyText ?? '';
  const hasByline = BYLINE_RE.test(body);
  const hasDate = DATE_RE.test(body);
  const hasAuthorSchema = page.structuredData.some((sd) => sd.valid && AUTHOR_SCHEMA_TYPES.has(sd.type));

  const signals = [hasByline, hasDate, hasAuthorSchema].filter(Boolean).length;
  return clamp01(signals / 3);
}

/** Null when the page carries no captured content — nothing to score, not a 0 that would read as "extremely poor". */
export function extractabilityScore(page: CrawledPage): ExtractabilityScore | null {
  if (!page.bodyText) return null;

  const answerFirst = answerFirstScore(page);
  const selfContainment = selfContainmentScore(page);
  const eeat = eeatScore(page);

  const combined = answerFirst * 0.35 + selfContainment * 0.35 + eeat * 0.3;

  return {
    score: Math.round(combined * 100),
    breakdown: { answerFirst, selfContainment, eeat },
    entityCoverage: 'not-measured',
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
