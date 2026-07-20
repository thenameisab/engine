/**
 * C3.1 "AI-drafted extractability rewrites" — the executor for B2's content
 * findings (`not-answer-first`, `poor-self-containment`, `weak-eeat`,
 * `weak-entity-coverage`), which have carried a `'content'` `ActionTemplate`
 * since `@engine/content` shipped with nothing to execute it
 * (`generate.ts`'s own comment: "'content' | 'gbp' are not generated in the
 * MVP").
 *
 * Deliberately **not** wired into `generateActions`'s synchronous dispatcher:
 * every other generator (schema/meta/robots/redirect/hreflang) is a pure,
 * free, instant string transform — this one is a real, costed LLM call. That
 * asymmetry belongs in the caller's control (a dedicated route/opt-in), not
 * silently folded into the same call that produces free deterministic
 * fixes. Calls OpenAI's Chat Completions API directly via `fetch` — same
 * approach as `packages/billing/checkout.ts` and `packages/deploy/
 * githubPr.ts` — no SDK, `fetchImpl` injectable for testing.
 */
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
}

/** Which B2 finding is being fixed determines the editing instruction — the rewrite target differs per issue. */
const REWRITE_INSTRUCTIONS: Record<string, string> = {
  'not-answer-first': 'Rewrite the opening so the first paragraph directly and completely answers the page\'s core question in the first 1-2 sentences, before any preamble.',
  'poor-self-containment': 'Restructure the passages so each paragraph stands alone as a complete, quotable answer — remove references to "this"/"it"/"they" that depend on a prior paragraph for meaning.',
  'weak-eeat': 'Add a byline, a publish/updated date, and at least one credible citation or source reference, without inventing false claims of authorship.',
  'weak-entity-coverage': 'Expand the content to explicitly cover the named entity and its listed attributes/keywords, grounded only in facts already present or supplied — do not fabricate new facts.',
};

/** Build the system + user prompt for a rewrite. Pure — testable without any network call. */
export function buildRewritePrompt(issueType: string, currentText: string, entity?: { name: string; keywords?: string[] }): {
  system: string;
  user: string;
} {
  const instruction = REWRITE_INSTRUCTIONS[issueType] ?? 'Improve this content for AI-search extractability.';
  const entityLine = entity
    ? `The page is about: ${entity.name}${entity.keywords?.length ? ` (related terms: ${entity.keywords.join(', ')})` : ''}.`
    : '';
  return {
    system:
      'You are an SEO/GEO content editor. Rewrite the given page content per the instruction. ' +
      'Preserve all facts already present; never invent new facts, statistics, names, or dates. ' +
      'Return only the rewritten content, no preamble or explanation.',
    user: [entityLine, `Instruction: ${instruction}`, '', 'Current content:', currentText].filter(Boolean).join('\n'),
  };
}

export interface GenerateRewriteOptions {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/** Call OpenAI to produce the rewritten text. Throws on a non-2xx response, same as the other real-API integrations in this repo. */
export async function generateRewrite(
  issueType: string,
  currentText: string,
  entity: { name: string; keywords?: string[] } | undefined,
  options: GenerateRewriteOptions,
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const prompt = buildRewritePrompt(issueType, currentText, entity);
  const res = await fetchImpl(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: options.model ?? DEFAULT_MODEL,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI rewrite request failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as OpenAIChatResponse;
  const rewritten = body.choices?.[0]?.message?.content?.trim();
  if (!rewritten) throw new Error('OpenAI rewrite returned no content');
  return rewritten;
}

/**
 * Generate a `'content'` Action for a B2 finding. Requires `ctx.currentBodyText`
 * (nothing to rewrite without it) — returns null rather than calling the LLM
 * with empty input, same "nothing to do" shape as the other generators'
 * null-return cases.
 */
export async function generateContentAction(
  finding: Pick<Finding, 'id' | 'issueType'>,
  ctx: ActionContext,
  options: GenerateRewriteOptions,
  env: BuildEnv,
): Promise<Action | null> {
  if (!ctx.currentBodyText || ctx.currentBodyText.trim() === '') return null;

  const entity = ctx.entity ? { name: ctx.entity.name } : undefined;
  const after = await generateRewrite(finding.issueType, ctx.currentBodyText, entity, options);

  return buildAction({
    findingId: finding.id,
    type: 'content',
    target: ctx.target,
    diff: { before: ctx.currentBodyText, after, format: 'text' },
    env,
  });
}
