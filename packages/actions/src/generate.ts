/**
 * Finding → Action dispatcher: the executable half of the moat contract. Given a
 * `Finding` and the page context, emit the concrete `Action` object(s) the Fix
 * Queue will deploy. Dispatches on each attached `ActionTemplate.type`, so a
 * finding with no templates (a documented non-executable diagnosis) yields
 * nothing — by design, not by error.
 */
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { defaultEnv, type BuildEnv } from './build.js';
import { generateSchemaAction } from './schema.js';
import { generateMetaTitleAction, generateMetaDescriptionAction } from './meta.js';
import { generateRobotsAction } from './robots.js';
import { generateRedirectAction } from './redirect.js';
import { generateHreflangAction } from './hreflang.js';
import { generateInternalLinkAction } from './internalLink.js';
import { generateGbpAction } from './gbp.js';

/** Pull the blocked-crawler list out of a finding's evidence, if present. */
function blockedFromEvidence(finding: Finding): string[] | undefined {
  const blocked = (finding.evidence as { blocked?: unknown }).blocked;
  return Array.isArray(blocked) ? blocked.filter((b): b is string => typeof b === 'string') : undefined;
}

/**
 * Generate every executable Action for a finding. `ctx` supplies the page facts;
 * for a robots fix the blocked-crawler list is taken from the finding evidence
 * unless the caller already set `ctx.blockedCrawlers`.
 */
export function generateActions(finding: Finding, ctx: ActionContext, env: BuildEnv = defaultEnv()): Action[] {
  const actions: Action[] = [];
  const seen = new Set<string>();

  for (const template of finding.actionTemplates) {
    // De-dupe repeated template types on one finding.
    if (seen.has(template.type)) continue;
    seen.add(template.type);

    switch (template.type) {
      case 'schema': {
        const a = generateSchemaAction(finding.id, ctx, env);
        if (a) actions.push(a);
        break;
      }
      case 'meta': {
        // Three distinct B1 findings share the 'meta' template type
        // (title-missing, description-missing, hreflang-missing) — dispatch
        // on the finding's own issue type, not an ActionContext field. Doing
        // this by ctx state alone (as this used to) double-counted: two
        // findings for the same page (one per missing field) would each
        // blindly re-check *both* ctx.currentTitle and
        // ctx.currentMetaDescription and each emit both actions, producing
        // duplicate title/description proposals the moment more than one
        // meta finding on a page was processed in the same pass — exactly
        // what auto-proposing "at scale" across a whole crawl does (C3.2).
        if (finding.issueType === 'meta-title-missing') {
          if (!ctx.currentTitle || ctx.currentTitle.trim() === '') {
            actions.push(generateMetaTitleAction(finding.id, ctx, env));
          }
        } else if (finding.issueType === 'meta-description-missing') {
          if (!ctx.currentMetaDescription || ctx.currentMetaDescription.trim() === '') {
            actions.push(generateMetaDescriptionAction(finding.id, ctx, env));
          }
        } else if (finding.issueType === 'hreflang-missing') {
          const a = generateHreflangAction(finding.id, ctx, env);
          if (a) actions.push(a);
        }
        break;
      }
      case 'robots': {
        const withCrawlers: ActionContext = {
          ...ctx,
          blockedCrawlers: ctx.blockedCrawlers ?? blockedFromEvidence(finding),
        };
        const a = generateRobotsAction(finding.id, withCrawlers, env);
        if (a) actions.push(a);
        break;
      }
      case 'redirect': {
        const a = generateRedirectAction(finding, ctx, env);
        if (a) actions.push(a);
        break;
      }
      case 'internal-link': {
        // C3 internal links: a free, deterministic markup transform, so it
        // belongs here (unlike the LLM-costed 'content' rewrite, which stays
        // in its own opt-in route). Suggestions come from ctx, not evidence —
        // same caller-owned shape as hreflang.
        const a = generateInternalLinkAction(finding, ctx, env);
        if (a) actions.push(a);
        break;
      }
      case 'gbp': {
        // C5: deterministic + ctx-owned (the value to write comes from
        // ctx.gbp), so it belongs in this synchronous dispatcher — unlike the
        // LLM-costed 'content' rewrite, which stays in its own opt-in route
        // (generateContentAction). Emits nothing when the target isn't a GBP
        // location or no value was supplied.
        const a = generateGbpAction(finding, ctx, env);
        if (a) actions.push(a);
        break;
      }
      // 'content' is not generated here: it is a costed LLM call behind its own
      // route (generateContentAction). The diagnosis layer still surfaces it.
      default:
        break;
    }
  }
  return actions;
}
