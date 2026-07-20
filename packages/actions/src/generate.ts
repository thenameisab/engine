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
        // hreflang-missing (B1.9/C4.3) is a distinct fix from title/description
        // regeneration sharing the same 'meta' template type — dispatch on the
        // finding's own issue type rather than an ActionContext field, the
        // same reasoning 'redirect' already applies to its two source findings.
        if (finding.issueType === 'hreflang-missing') {
          const a = generateHreflangAction(finding.id, ctx, env);
          if (a) actions.push(a);
          break;
        }
        // Otherwise, emit whichever meta field is actually missing/empty in context.
        if (!ctx.currentTitle || ctx.currentTitle.trim() === '') {
          actions.push(generateMetaTitleAction(finding.id, ctx, env));
        }
        if (!ctx.currentMetaDescription || ctx.currentMetaDescription.trim() === '') {
          actions.push(generateMetaDescriptionAction(finding.id, ctx, env));
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
      // 'content' | 'gbp' are not generated in the MVP (no C3/C5 executor
      // yet); the diagnosis layer still surfaces those findings.
      default:
        break;
    }
  }
  return actions;
}
