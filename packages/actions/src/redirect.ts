/**
 * C4.1/C4.2 redirect fixes — the 'redirect' `ActionType` `generate.ts` used to
 * fall through on ("not generated in the MVP"). Two B1.5 findings share this
 * template: a multi-hop redirect chain (collapse to one hop) and a canonical
 * conflict (consolidate the page into its declared canonical). Both reduce to
 * the same shape — redirect one URL to another — so one generator covers both,
 * dispatched on the finding's own evidence rather than needing a second
 * `ActionContext` field the way schema/meta/robots do.
 */
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

export interface RedirectPair {
  from: string;
  to: string;
}

/**
 * Resolve the (from, to) pair a redirect-shaped finding implies, or null if
 * its evidence doesn't carry one. `redirect-chain` evidence is `{ url, chain }`
 * where `url` is the final landing page (crawlPage.ts records `page.url` as
 * post-redirect) and `chain` is the intermediate hops, oldest first — the fix
 * is a single hop from the *original* entry point (`chain[0]`) straight to
 * `url`. `canonical-conflict` evidence is `{ url, canonical }` — the fix
 * consolidates the page into the canonical it already declares.
 */
export function resolveRedirectPair(finding: Pick<Finding, 'issueType' | 'evidence'>): RedirectPair | null {
  const evidence = finding.evidence as { url?: unknown; chain?: unknown; canonical?: unknown };

  if (finding.issueType === 'redirect-chain') {
    const to = evidence.url;
    const chain = evidence.chain;
    if (typeof to !== 'string' || !Array.isArray(chain) || chain.length === 0) return null;
    const from = chain[0];
    if (typeof from !== 'string' || from === to) return null;
    return { from, to };
  }

  if (finding.issueType === 'canonical-conflict') {
    const from = evidence.url;
    const to = evidence.canonical;
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) return null;
    return { from, to };
  }

  return null;
}

export function generateRedirectAction(finding: Finding, ctx: ActionContext, env: BuildEnv): Action | null {
  const pair = resolveRedirectPair(finding);
  if (!pair) return null;
  return buildAction({
    findingId: finding.id,
    type: 'redirect',
    target: ctx.target,
    diff: { before: pair.from, after: pair.to, format: 'text' },
    env,
  });
}
