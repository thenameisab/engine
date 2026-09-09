/**
 * Finding → Action dispatcher: the executable half of the moat contract. Given a
 * `Finding` and the page context, emit the concrete `Action` object(s) the Fix
 * Queue will deploy. Dispatches on each attached `ActionTemplate.type`, so a
 * finding with no templates (a documented non-executable diagnosis) yields
 * nothing — by design, not by error.
 */
import type { Action, ActionType, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { defaultEnv, isSkipped, type BuildEnv, type Generated } from './build.js';
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
 * Why a template type produced nothing when it had no reason of its own to
 * give. The generators that return `null` do so for one cause each, so the
 * cause can be stated here rather than threaded through five signatures — and
 * a customer reads a sentence about their site instead of "no action could be
 * generated".
 */
const DEFAULT_SKIP_REASONS: Partial<Record<ActionType, string>> = {
  robots: 'This page’s robots.txt does not block any AI crawler Engine can unblock.',
  redirect: 'Engine could not read a redirect to fix from this finding.',
  meta: 'The page already has this tag, so there is nothing to replace.',
  'internal-link': 'Engine found no related page whose name appears in this page’s text, so it has nowhere to add a link.',
  gbp: 'This fix writes to a Google Business Profile. Connect one for this site, and supply the text to publish.',
};

function skipReason(type: ActionType): string {
  return DEFAULT_SKIP_REASONS[type] ?? 'Engine could not build this fix from what the last crawl captured.';
}

/** What one call to `generateActions` produced, and what it could not. */
export interface GeneratedActions {
  actions: Action[];
  /** One entry per fix the finding asked for that no Action came out of. */
  skipped: { type: ActionType; reason: string }[];
}

/**
 * Generate every executable Action for a finding. `ctx` supplies the page facts;
 * for a robots fix the blocked-crawler list is taken from the finding evidence
 * unless the caller already set `ctx.blockedCrawlers`.
 *
 * Returns the skipped fixes alongside the built ones. A finding whose fix
 * cannot be built is the normal case for a thin page or an unfinished brand
 * record, and the caller has to be able to say which.
 */
export function generateActions(finding: Finding, ctx: ActionContext, env: BuildEnv = defaultEnv()): GeneratedActions {
  const actions: Action[] = [];
  const skipped: GeneratedActions['skipped'] = [];
  const seen = new Set<string>();

  /**
   * Route one generator's outcome: an Action, a stated reason, or a null that
   * takes the type's default reason — `whenNull` overrides that default where
   * one ActionType covers two different fixes (hreflang rides on 'meta').
   */
  const take = (type: ActionType, result: Generated | null, whenNull?: string): void => {
    if (result === null) skipped.push({ type, reason: whenNull ?? skipReason(type) });
    else if (isSkipped(result)) skipped.push({ type, reason: result.reason });
    else actions.push(result);
  };

  for (const template of finding.actionTemplates) {
    // De-dupe repeated template types on one finding.
    if (seen.has(template.type)) continue;
    seen.add(template.type);

    switch (template.type) {
      case 'schema': {
        take('schema', generateSchemaAction(finding.id, ctx, env));
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
            take('meta', generateMetaTitleAction(finding.id, ctx, env));
          }
        } else if (finding.issueType === 'meta-description-missing') {
          if (!ctx.currentMetaDescription || ctx.currentMetaDescription.trim() === '') {
            take('meta', generateMetaDescriptionAction(finding.id, ctx, env));
          }
        } else if (finding.issueType === 'hreflang-missing') {
          take(
            'meta',
            generateHreflangAction(finding.id, ctx, env),
            'Engine does not know which language versions of this page exist, so it cannot link them to each other yet.',
          );
        }
        break;
      }
      case 'robots': {
        const withCrawlers: ActionContext = {
          ...ctx,
          blockedCrawlers: ctx.blockedCrawlers ?? blockedFromEvidence(finding),
        };
        take('robots', generateRobotsAction(finding.id, withCrawlers, env));
        break;
      }
      case 'redirect': {
        take('redirect', generateRedirectAction(finding, ctx, env));
        break;
      }
      case 'internal-link': {
        // C3 internal links: a free, deterministic markup transform, so it
        // belongs here (unlike the LLM-costed 'content' rewrite, which stays
        // in its own opt-in route). Suggestions come from ctx, not evidence —
        // same caller-owned shape as hreflang.
        take('internal-link', generateInternalLinkAction(finding, ctx, env));
        break;
      }
      case 'gbp': {
        // C5: deterministic + ctx-owned (the value to write comes from
        // ctx.gbp), so it belongs in this synchronous dispatcher — unlike the
        // LLM-costed 'content' rewrite, which stays in its own opt-in route
        // (generateContentAction). Emits nothing when the target isn't a GBP
        // location or no value was supplied.
        take('gbp', generateGbpAction(finding, ctx, env));
        break;
      }
      // 'content' is not generated here: it is a costed LLM call behind its own
      // route (generateContentAction). The diagnosis layer still surfaces it.
      default:
        break;
    }
  }
  return { actions, skipped };
}
