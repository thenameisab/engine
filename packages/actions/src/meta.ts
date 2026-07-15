/**
 * Meta title / description regeneration — the C3.2 executable action (the second
 * MVP fix type). The MVP path is a deterministic heuristic derived from the
 * page's lead heading + entity name, kept behind a clear seam so an LLM-backed
 * copywriter can be swapped in later without changing the Action contract.
 */
import type { Action } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

/** SEO length guidance: titles ~60 chars, descriptions ~155 chars. */
export const TITLE_MAX = 60;
export const DESC_MAX = 155;

function truncate(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Heuristic proposed title: "<lead heading> — <entity name>" within length budget. */
export function proposeTitle(ctx: ActionContext): string {
  const parts = [ctx.leadHeading, ctx.entity?.name].filter((p): p is string => Boolean(p && p.trim()));
  return truncate(parts.join(' — ') || ctx.url, TITLE_MAX);
}

/** Heuristic proposed description from the entity description or lead heading. */
export function proposeDescription(ctx: ActionContext): string {
  const base = ctx.entity?.description || ctx.leadHeading || ctx.entity?.name || '';
  return truncate(base, DESC_MAX);
}

export function generateMetaTitleAction(findingId: string, ctx: ActionContext, env: BuildEnv): Action {
  return buildAction({
    findingId,
    type: 'meta',
    target: ctx.target,
    diff: { before: ctx.currentTitle ?? '', after: proposeTitle(ctx), format: 'text', field: 'title' },
    env,
  });
}

export function generateMetaDescriptionAction(findingId: string, ctx: ActionContext, env: BuildEnv): Action {
  return buildAction({
    findingId,
    type: 'meta',
    target: ctx.target,
    diff: { before: ctx.currentMetaDescription ?? '', after: proposeDescription(ctx), format: 'text', field: 'description' },
    env,
  });
}
