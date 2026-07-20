/**
 * C4.3 hreflang generation — the executable half of B1.9's `hreflang-missing`
 * finding. Deterministic, no LLM: the alternates themselves aren't derived by
 * Engine (a page's i18n cluster isn't observable from crawling that one page
 * — see `ActionContext.hreflangAlternates`'s doc comment), only the markup
 * that expresses them is generated here.
 */
import type { Action } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

/** One `<link rel="alternate" hreflang="…">` tag per supplied alternate, newline-joined for insertion into `<head>`. */
export function buildHreflangTags(alternates: readonly { lang: string; href: string }[]): string {
  return alternates
    .map((a) => `<link rel="alternate" hreflang="${escapeAttr(a.lang)}" href="${escapeAttr(a.href)}">`)
    .join('\n');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** Null when the caller supplied no alternates — nothing to emit, and emitting an empty diff would silently "fix" nothing. */
export function generateHreflangAction(findingId: string, ctx: ActionContext, env: BuildEnv): Action | null {
  const alternates = ctx.hreflangAlternates;
  if (!alternates || alternates.length === 0) return null;
  return buildAction({
    findingId,
    type: 'meta',
    target: ctx.target,
    diff: { before: '', after: buildHreflangTags(alternates), format: 'html', field: 'hreflang' },
    env,
  });
}
