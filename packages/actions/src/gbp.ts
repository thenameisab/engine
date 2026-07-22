/**
 * C5 GBP action generator. Turns a B5 `source:'local'` finding into a
 * deployable `gbp` Action whose diff carries a structured `GbpOperation` (from
 * @engine/deploy) in `after` — the executor (`deployGbpAction`) is then a pure
 * function of the Action. Deterministic and ctx-owned (no LLM), so it lives in
 * `generateActions`' synchronous dispatcher like the hreflang/internal-link
 * generators: the value to write comes from `ctx.gbp`, and when the matching
 * input is absent it emits nothing rather than inventing content.
 */
import type { Action, Finding } from '@engine/core';
import { serializeGbpOperation, type GbpOperation } from '@engine/deploy';
import { buildAction, type BuildEnv } from './build.js';
import type { ActionContext } from './context.js';

/** The GBP location id from a `gbp-api` target, or null for any other target. */
function locationOf(ctx: ActionContext): string | null {
  return ctx.target.kind === 'gbp-api' ? ctx.target.locationId : null;
}

function buildGbp(finding: Pick<Finding, 'id'>, ctx: ActionContext, op: GbpOperation, before: string, env: BuildEnv): Action {
  return buildAction({
    findingId: finding.id,
    type: 'gbp',
    target: ctx.target,
    // The op is the deployable payload; `before` is the human-readable current
    // state for the Fix Queue preview, `after` the readable new value mirrored
    // out of the op so the card reads naturally.
    diff: { before, after: serializeGbpOperation(op), format: 'text' },
    env,
  });
}

/**
 * Generate the GBP action for one B5 local finding, or null when the target
 * isn't a GBP location or the caller supplied no value to write. The op is
 * chosen from the finding's issueType:
 *  - incomplete-gbp-field  → update the field named in `evidence.field`
 *  - unanswered-reviews    → reply to a review
 *  - low-review-velocity   → publish a GBP post
 */
export function generateGbpAction(
  finding: Pick<Finding, 'id' | 'issueType' | 'evidence'>,
  ctx: ActionContext,
  env: BuildEnv,
): Action | null {
  if (locationOf(ctx) === null) return null; // only deployable to a GBP location
  const g = ctx.gbp ?? {};

  switch (finding.issueType) {
    case 'incomplete-gbp-field': {
      const field = (finding.evidence as { field?: string }).field;
      const allowed = ['description', 'title', 'categories', 'regularHours', 'attributes'] as const;
      if (!field || !(allowed as readonly string[]).includes(field) || !g.fieldValue) return null;
      return buildGbp(
        finding,
        ctx,
        { kind: 'update-field', field: field as (typeof allowed)[number], value: g.fieldValue },
        `(${field} incomplete)`,
        env,
      );
    }
    case 'unanswered-reviews': {
      if (!g.reviewName || !g.reviewReply) return null;
      return buildGbp(finding, ctx, { kind: 'reply-review', reviewName: g.reviewName, comment: g.reviewReply }, '(no reply)', env);
    }
    case 'low-review-velocity': {
      if (!g.postSummary) return null;
      return buildGbp(finding, ctx, { kind: 'create-post', summary: g.postSummary }, '(no recent post)', env);
    }
    default:
      return null;
  }
}
