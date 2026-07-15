/**
 * Edge-worker deploy target (C2/C3.2, Architecture §1 Layer 4 "Edge Workers") —
 * applies an Action's Diff to origin HTML text. Pure string transforms: the
 * worker fetches origin HTML, calls these, and returns the result. No I/O here
 * so the transform logic is unit-testable without the Workers runtime.
 */
import type { Action, Diff } from '@engine/core';

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Insert a schema.org JSON-LD block into <head>, or replace it if `diff.before` is present verbatim. */
export function applySchemaDiff(html: string, diff: Diff): string {
  if (diff.before && html.includes(diff.before)) {
    return html.replace(diff.before, diff.after);
  }
  const tag = `<script type="application/ld+json">\n${diff.after}\n</script>`;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}\n</head>`) : html + tag;
}

/** Replace (or insert) <title> / <meta name="description">, per `diff.field`. */
export function applyMetaDiff(html: string, diff: Diff): string {
  if (diff.field === 'title') return applyTitle(html, diff.after);
  if (diff.field === 'description') return applyDescription(html, diff.after);
  return html;
}

function applyTitle(html: string, title: string): string {
  const escaped = escapeHtml(title);
  if (/<title>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escaped}</title>`);
  }
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `<title>${escaped}</title>\n</head>`) : html;
}

function applyDescription(html: string, description: string): string {
  const escaped = escapeHtml(description);
  const metaTag = `<meta name="description" content="${escaped}">`;
  if (/<meta\s+name=["']description["'][^>]*>/i.test(html)) {
    return html.replace(/<meta\s+name=["']description["'][^>]*>/i, metaTag);
  }
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${metaTag}\n</head>`) : html;
}

/** Apply a single 'schema' or 'meta' Action's diff to HTML; other action types pass through untouched. */
export function applyHtmlDiff(html: string, action: Pick<Action, 'type' | 'diff'>): string {
  if (action.type === 'schema') return applySchemaDiff(html, action.diff);
  if (action.type === 'meta') return applyMetaDiff(html, action.diff);
  return html;
}

/** Fold every deployed schema/meta Action for a page into its HTML, in order. */
export function applyHtmlActions(html: string, actions: readonly Pick<Action, 'type' | 'diff'>[]): string {
  return actions.reduce((acc, action) => applyHtmlDiff(acc, action), html);
}
