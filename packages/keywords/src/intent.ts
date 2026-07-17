/**
 * A4.3 intent classification.
 *
 * The full spec routes this through an LLM gateway; this MVP slice is a
 * deterministic rule-based classifier instead — no LLM call, no API key,
 * fully unit-testable, and honest about what it is: a keyword-signal
 * heuristic, not a trained classifier. It exists so A4 has *something* real
 * behind "classify intent" today rather than nothing; swapping in an
 * LLM-backed classifier later is additive, not a rewrite (same return type).
 */
export type SearchIntent = 'transactional' | 'commercial' | 'navigational' | 'informational';

interface Rule {
  intent: SearchIntent;
  pattern: RegExp;
}

/**
 * Checked in order, most specific first: "buy running shoes" should read as
 * transactional even though it also contains no commercial-comparison words.
 * A keyword matching none of these defaults to informational — the largest,
 * catch-all intent category, and the safest default when signal is absent.
 */
const RULES: readonly Rule[] = [
  { intent: 'transactional', pattern: /\b(buy|price|pricing|cost|order|purchase|deal|discount|coupon|for sale|cheap|near me)\b/i },
  { intent: 'commercial', pattern: /\b(best|top|review|reviews|vs|versus|compare|comparison|alternative|alternatives)\b/i },
  { intent: 'navigational', pattern: /\b(login|log in|sign in|signin|official|website|homepage|download)\b/i },
  { intent: 'informational', pattern: /\b(how|what|why|when|where|who|guide|tutorial|meaning|definition|examples?)\b/i },
];

export function classifyIntent(keyword: string): SearchIntent {
  for (const rule of RULES) {
    if (rule.pattern.test(keyword)) return rule.intent;
  }
  return 'informational';
}
