/**
 * Meta title / description regeneration — the C3.2 executable action.
 *
 * The proposal is deterministic and built from what the crawl saw on *this
 * page*: its lead heading and its opening sentences. It used to be
 * `[leadHeading, entityName].join(' — ')`, and the API never passed a lead
 * heading, so every page of a site got the brand name as its title and its
 * description — "Acme Dental" proposed as the title of eight different pages.
 * A customer cannot tell a good proposal from that one, so the generator now
 * refuses rather than proposing it: `proposeTitle`/`proposeDescription` return
 * a `reason` when the page gives them nothing to write from, and the caller
 * reports that reason instead of queueing a fix.
 */
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv, type Generated, type Skipped } from './build.js';

/** SEO length guidance: titles ~60 chars, descriptions ~155 chars. */
export const TITLE_MAX = 60;
export const DESC_MAX = 155;

/**
 * Below this a description says nothing a search result or an AI answer can
 * use. Short enough to admit a genuinely terse page ("We repair bicycles in
 * Leeds."), long enough to exclude a bare brand name.
 */
export const DESC_MIN = 40;

/** A proposal, or the reason this page cannot produce one. */
export type Proposal = { text: string } | Skipped;

export function isProposal(p: Proposal): p is { text: string } {
  return 'text' in p;
}

function tidy(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

function truncate(s: string, max: number): string {
  const t = tidy(s);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function same(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && tidy(a).toLowerCase() === tidy(b).toLowerCase());
}

function mentions(haystack: string, needle: string | undefined): boolean {
  return Boolean(needle && haystack.toLowerCase().includes(tidy(needle).toLowerCase()));
}

/**
 * The page's own heading: `leadHeading` when the caller supplies one, else the
 * first (shallowest, earliest) heading the crawl captured. Chrome-only pages
 * have none, and that is a reason to refuse, not to fall back to the brand.
 */
export function pageHeading(ctx: ActionContext): string | undefined {
  if (ctx.leadHeading && tidy(ctx.leadHeading)) return tidy(ctx.leadHeading);
  const headings = ctx.headings ?? [];
  const best = headings.find((h) => h.level === 1 && tidy(h.text)) ?? headings.find((h) => tidy(h.text));
  return best ? tidy(best.text) : undefined;
}

/** Split visible body text into sentences, dropping fragments too short to mean anything. */
function sentences(bodyText: string | undefined): string[] {
  if (!bodyText) return [];
  return tidy(bodyText)
    .split(/(?<=[.!?])\s+/)
    .map(tidy)
    .filter((s) => s.length >= 20);
}

/** The page's opening sentence — what it says it is about, in its own words. */
export function leadSentence(ctx: ActionContext): string | undefined {
  return sentences(ctx.currentBodyText)[0];
}

/**
 * Proposed <title>: what this page is about, then the brand.
 *
 * The page's heading leads, because that is the page's own claim about itself.
 * When the heading is just the brand (common on a homepage), the opening
 * sentence carries the meaning instead and the brand becomes the suffix. With
 * neither, there is nothing page-specific to say and the generator refuses.
 */
export function proposeTitle(ctx: ActionContext): Proposal {
  const brand = ctx.entity?.name ? tidy(ctx.entity.name) : undefined;
  const heading = pageHeading(ctx);
  const lead = leadSentence(ctx);

  const subject = heading && !same(heading, brand) ? heading : lead ? truncate(lead, TITLE_MAX) : undefined;
  if (!subject) {
    return {
      reason:
        'This page has no heading or visible text to write a title from. Add a heading to the page, then run the audit again.',
    };
  }

  // The brand is a suffix, never a replacement: it is added only when it fits
  // beside the page's own subject, so a long heading keeps the whole title.
  const withBrand = brand && !mentions(subject, brand) ? `${subject} — ${brand}` : subject;
  const text = tidy(withBrand).length <= TITLE_MAX ? tidy(withBrand) : truncate(subject, TITLE_MAX);
  if (same(text, brand)) {
    return {
      reason:
        'The only text on this page is the brand name, so a proposed title would repeat it. Add a heading that says what the page is about.',
    };
  }
  return { text };
}

/**
 * Proposed meta description: the page's opening sentences up to the length
 * budget. Falls back to a supplied entity description (real prose about the
 * business), never to the entity's name on its own.
 */
export function proposeDescription(ctx: ActionContext): Proposal {
  const brand = ctx.entity?.name ? tidy(ctx.entity.name) : undefined;
  let text = '';
  for (const sentence of sentences(ctx.currentBodyText)) {
    const next = text ? `${text} ${sentence}` : sentence;
    if (tidy(next).length > DESC_MAX) break;
    text = next;
  }
  if (!text) {
    const first = sentences(ctx.currentBodyText)[0];
    // One long opening sentence: trim it rather than report an empty page.
    if (first) text = truncate(first, DESC_MAX);
  }
  if (!text && ctx.entity?.description) text = truncate(ctx.entity.description, DESC_MAX);

  if (tidy(text).length < DESC_MIN || same(text, brand)) {
    return {
      reason:
        'This page has too little text for Engine to describe it accurately. Add a sentence or two of visible copy, then run the audit again.',
    };
  }
  return { text: truncate(text, DESC_MAX) };
}

export function generateMetaTitleAction(findingId: string, ctx: ActionContext, env: BuildEnv): Generated {
  const proposed = proposeTitle(ctx);
  if (!isProposal(proposed)) return proposed;
  return buildAction({
    findingId,
    type: 'meta',
    target: ctx.target,
    diff: { before: ctx.currentTitle ?? '', after: proposed.text, format: 'text', field: 'title' },
    env,
  });
}

export function generateMetaDescriptionAction(findingId: string, ctx: ActionContext, env: BuildEnv): Generated {
  const proposed = proposeDescription(ctx);
  if (!isProposal(proposed)) return proposed;
  return buildAction({
    findingId,
    type: 'meta',
    target: ctx.target,
    diff: { before: ctx.currentMetaDescription ?? '', after: proposed.text, format: 'text', field: 'description' },
    env,
  });
}
