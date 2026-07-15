/**
 * Shared, pure citation extraction for the LLM-engine adapters (A2).
 *
 * Given an answer's text, any structured grounding-source URLs the engine
 * returned, and the entity's citation targets, decide whether the entity was
 * cited and collect the full source list. Engine-agnostic so OpenAI, Gemini,
 * and any later engine share identical "was I cited?" semantics.
 *
 * Sentiment/accuracy are intentionally left `null`: classifying those needs a
 * separate LLM-judge pass (A2.5) not built yet, and the `CitationEvent`
 * contract already allows null rather than a guessed value.
 */
import type { CitationEvent } from './llmEngine.js';

/** Extract bare URLs from free text, trimming trailing punctuation. */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)"'<>\]]+/g) ?? [];
  return [...new Set(matches.map((u) => u.replace(/[.,);:]+$/, '')))];
}

/** Host of a URL, lowercased and stripped of a leading www. Null if unparseable. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Normalize a domain target to a bare host for comparison. */
export function normalizeDomain(target: string): string {
  return target
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

function hostMatchesTarget(host: string, target: string): boolean {
  return host === target || host.endsWith(`.${target}`);
}

/**
 * Build a `CitationEvent` from an answer.
 * @param answerText   the model's answer text
 * @param groundingSources  source URLs the engine returned out-of-band (grounding metadata), if any
 * @param citationTargets   entity domains (with a dot) and/or brand names (no dot)
 */
export function buildCitationEvent(
  answerText: string,
  groundingSources: string[],
  citationTargets: string[] | undefined,
): CitationEvent {
  const sourcesCited = [...new Set([...groundingSources, ...extractUrls(answerText)])];

  if (!citationTargets || citationTargets.length === 0) {
    // No targets → we surface sources but honestly can't assert a citation.
    return { cited: false, sourcesCited, sentiment: null, accuracy: null };
  }

  const domainTargets = citationTargets.filter((t) => t.includes('.')).map(normalizeDomain).filter(Boolean);
  const nameTargets = citationTargets.filter((t) => !t.includes('.')).map((t) => t.trim().toLowerCase()).filter(Boolean);

  const citedHosts = sourcesCited.map(hostOf).filter((h): h is string => h !== null);
  const citedByDomain = citedHosts.some((host) => domainTargets.some((t) => hostMatchesTarget(host, t)));

  const lowerText = answerText.toLowerCase();
  const citedByName = nameTargets.some((name) => lowerText.includes(name));

  return { cited: citedByDomain || citedByName, sourcesCited, sentiment: null, accuracy: null };
}

/** Run `fn` n times (n-sampling, A2.6). Sequential to stay within provider rate limits. */
export async function runSamples<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(await fn(i));
  return out;
}
