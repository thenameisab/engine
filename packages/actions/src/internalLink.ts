/**
 * C3 "internal links" — the executor for a sparse-internal-linking content
 * finding. Weaves caller-supplied internal links (anchor → href, sourced from
 * the entity graph / related-content logic the caller owns, exactly like
 * `hreflangAlternates`) into the page's current body markup.
 *
 * Deterministic and free — a pure string transform, no LLM — so unlike the
 * C3.1 content rewrite it belongs in `generateActions`'s synchronous
 * dispatcher alongside schema/meta/robots/redirect. Insertion is deliberately
 * conservative: the first *unlinked, un-tagged* occurrence of each anchor
 * phrase becomes a single link; anchors already linked, not present, or only
 * present inside existing markup are skipped, so the fix never nests `<a>`
 * tags, never double-links, and never invents anchor text.
 */
import type { Action, Finding } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

const ATTR_ESCAPE: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' };

/** Escape a URL for safe use in an href attribute. */
function escapeAttr(url: string): string {
  return url.replace(/[&"<>]/g, (ch) => ATTR_ESCAPE[ch]);
}

/** Escape a string for use inside a regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tokenize markup into `<…>` tags and the text between them, so anchor
 * matching only ever touches text nodes — never tag names or attribute
 * values. Segments are re-joined verbatim, so whitespace and tags round-trip
 * exactly.
 */
function tokenize(html: string): { tag: boolean; text: string }[] {
  const parts: { tag: boolean; text: string }[] = [];
  const re = /<[^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m.index > last) parts.push({ tag: false, text: html.slice(last, m.index) });
    parts.push({ tag: true, text: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) parts.push({ tag: false, text: html.slice(last) });
  return parts;
}

/**
 * Insert one link per suggestion into the first eligible text node. A text
 * node sitting between `<a …>` and `</a>` is skipped so the fix never nests an
 * anchor or double-links an already-linked phrase. Matching is word-bounded so
 * "pricing" does not match inside "pricings".
 */
function insertLinks(html: string, suggestions: readonly { anchor: string; href: string }[]): { html: string; inserted: number } {
  const parts = tokenize(html);
  let inserted = 0;

  for (const { anchor, href } of suggestions) {
    const trimmed = anchor.trim();
    if (!trimmed) continue;
    const re = new RegExp(`(?<!\\w)${escapeRegExp(trimmed)}(?!\\w)`);

    let insideAnchor = false;
    for (const part of parts) {
      if (part.tag) {
        const lower = part.text.toLowerCase();
        if (/^<a[\s>]/.test(lower)) insideAnchor = true;
        else if (lower === '</a>') insideAnchor = false;
        continue;
      }
      if (insideAnchor) continue;
      const m = re.exec(part.text);
      if (m) {
        part.text =
          part.text.slice(0, m.index) +
          `<a href="${escapeAttr(href)}">${trimmed}</a>` +
          part.text.slice(m.index + trimmed.length);
        inserted++;
        break;
      }
    }
  }

  return { html: parts.map((p) => p.text).join(''), inserted };
}

/**
 * Generate an `internal-link` Action, or null when there is nothing to do:
 * no source markup, no suggestions, or none of the suggested anchors could be
 * placed. A null return is the same "nothing to fix" signal the other
 * generators use — not an error.
 */
export function generateInternalLinkAction(finding: Pick<Finding, 'id'>, ctx: ActionContext, env: BuildEnv): Action | null {
  const source = ctx.currentBodyHtml ?? ctx.currentBodyText;
  if (!source || source.trim() === '') return null;
  const suggestions = ctx.internalLinkSuggestions;
  if (!suggestions || suggestions.length === 0) return null;

  const { html, inserted } = insertLinks(source, suggestions);
  if (inserted === 0) return null;

  return buildAction({
    findingId: finding.id,
    type: 'internal-link',
    target: ctx.target,
    diff: { before: source, after: html, format: 'html' },
    env,
  });
}
