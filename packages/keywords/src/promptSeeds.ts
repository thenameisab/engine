/**
 * A4.8 prompt research (MVP seed step).
 *
 * The spec's full version mines prompts from an answer archive and expands
 * them with an LLM (A2's actual capture, once it has volume). Before that
 * archive has enough history to mine, a topic still needs a starting prompt
 * bank — this generates candidate prompts from a seed keyword via fixed
 * templates covering the intent categories A4.3 classifies, so the seed set
 * itself is intent-diverse rather than nine variations on one phrasing.
 * Deterministic and free (no LLM call): a real, if narrower, version of
 * "populate the prompt bank" rather than a stub.
 */
const TEMPLATES: readonly string[] = [
  'what is {topic}',
  'best {topic}',
  '{topic} vs alternatives',
  'how does {topic} work',
  'is {topic} worth it',
  '{topic} pricing',
  '{topic} reviews',
];

export function generatePromptSeeds(topic: string): string[] {
  const clean = topic.trim();
  if (!clean) return [];
  return TEMPLATES.map((t) => t.replace('{topic}', clean));
}
