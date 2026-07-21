import type { CopilotIntentType, ParsedIntent } from './types.js';

/**
 * Deterministic NL -> intent parser. No model call: the taxonomy is small and
 * closed (see types.ts), so keyword rules resolve it in microseconds, which is
 * how the <3s budget is met with room to spare and how the whole path stays
 * runnable without an LLM key. The optional phrasing model only rewords the
 * final prose — it never decides what was asked or what the numbers are.
 */

export interface EntityRef {
  id: string;
  canonicalName: string;
}

/** Lowercased word tokens, punctuation stripped. */
function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Resolve the entity a question is about by scoring each known entity against
 * the question's tokens. A full canonical-name substring match wins outright;
 * otherwise the entity sharing the most name-tokens with the question wins. A
 * single shared token is enough (many entities are one word), but a tie or no
 * overlap resolves to nothing rather than guessing — an unresolved entity is a
 * graceful `unknown`, not a wrong answer about the wrong brand.
 */
export function resolveEntity(question: string, entities: EntityRef[]): EntityRef | undefined {
  const q = question.toLowerCase();
  const qTokens = new Set(tokens(question));

  let best: EntityRef | undefined;
  let bestScore = 0;
  let tie = false;

  for (const e of entities) {
    const name = e.canonicalName.toLowerCase();
    let score = 0;
    if (name.length >= 2 && q.includes(name)) {
      // Whole-name substring: strongest signal, weighted by name length so a
      // longer, more specific name beats a short one also present.
      score = 1000 + name.length;
    } else {
      const nameTokens = tokens(e.canonicalName);
      for (const t of nameTokens) if (qTokens.has(t)) score += 1;
    }
    if (score > bestScore) {
      best = e;
      bestScore = score;
      tie = false;
    } else if (score === bestScore && score > 0) {
      tie = true;
    }
  }

  if (bestScore === 0 || tie) return undefined;
  return best;
}

const FINDING_WORDS = ['fix', 'fixes', 'problem', 'problems', 'issue', 'issues', 'wrong', 'improve', 'finding', 'findings', 'broken', 'errors', 'error'];
const RANK_WORDS = ['rank', 'ranking', 'rankings', 'position', 'positions', 'serp'];
const COMPARE_WORDS = ['vs', 'versus', 'compare', 'comparison', 'better', 'stronger', 'organic', 'google'];

function hasAny(qTokens: Set<string>, words: string[]): boolean {
  return words.some((w) => qTokens.has(w));
}

/**
 * Pull the keyword a "where do I rank for X" question is asking about. Prefers
 * a quoted phrase; else takes the tail after the last "for". Returns undefined
 * when neither is present (the caller then falls back off keyword_rank).
 */
export function extractKeyword(question: string): string | undefined {
  const quoted = question.match(/["'“”‘’](.+?)["'“”‘’]/);
  if (quoted && quoted[1].trim()) return quoted[1].trim();
  const forMatch = question.match(/\bfor\s+(.+?)[?.!]*$/i);
  if (forMatch && forMatch[1].trim()) return forMatch[1].trim();
  return undefined;
}

/**
 * Classify a question into one intent. Order matters: an explicit fix/rank/
 * compare request beats the generic "how is X doing" catch-all, which is the
 * default whenever an entity resolved but no sharper signal is present.
 */
export function parseIntent(question: string, entities: EntityRef[]): ParsedIntent {
  const entity = resolveEntity(question, entities);
  const raw = question;
  const qTokens = new Set(tokens(question));

  if (!entity) {
    return { type: 'unknown', raw };
  }

  const base = { entityId: entity.id, entityName: entity.canonicalName, raw };

  let type: CopilotIntentType;
  let keyword: string | undefined;

  if (hasAny(qTokens, FINDING_WORDS)) {
    type = 'top_findings';
  } else if (hasAny(qTokens, RANK_WORDS)) {
    const kw = extractKeyword(question);
    if (kw) {
      type = 'keyword_rank';
      keyword = kw;
    } else {
      // "how are my rankings for X" with no specific keyword -> the SoV view.
      type = 'entity_visibility';
    }
  } else if (hasAny(qTokens, COMPARE_WORDS)) {
    type = 'organic_vs_ai';
  } else {
    type = 'entity_visibility';
  }

  return keyword ? { type, keyword, ...base } : { type, ...base };
}
