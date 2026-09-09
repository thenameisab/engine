/**
 * Everything a generator needs *beyond* the Finding to produce a concrete diff.
 *
 * A `Finding` (from @engine/core) says *what is wrong* and carries issue-specific
 * evidence, but generating a deployable `before → after` diff needs the page's
 * actual current content (title text, existing robots.txt, entity facts for the
 * JSON-LD body). The crawler already has all of this; rather than bloat the
 * Finding, we pass it alongside as `ActionContext`. Keeping generation a pure
 * function of (Finding, ActionContext) means the whole layer is unit-testable
 * with no I/O and no LLM dependency in the deterministic path.
 */
import type { DeployTarget } from '@engine/core';

/** Minimal entity facts used to populate a JSON-LD body. */
export interface EntityFacts {
  /** schema.org @type, e.g. "Product", "Organization", "Article". */
  schemaType: string;
  name: string;
  description?: string;
  /** Free-form extra JSON-LD properties (price, brand, sku, …). */
  properties?: Record<string, unknown>;
}

export interface ActionContext {
  /** The page the finding is about. */
  url: string;
  /** Where an approved fix would deploy (chosen by the caller / project config). */
  target: DeployTarget;

  /** Current <title>, for the meta-title action's `before`. */
  currentTitle?: string;
  /** Current meta description, for the meta-description action's `before`. */
  currentMetaDescription?: string;
  /** Page H1 / lead copy, used to derive a proposed title/description heuristically. */
  leadHeading?: string;

  /**
   * The page's visible headings in document order, as the crawl captured them.
   * The meta generator reads its subject from here when the caller has not
   * picked a `leadHeading` itself, which is what stops a proposed title from
   * collapsing to the brand name on every page of a site.
   */
  headings?: { level: number; text: string }[];

  /** Current robots.txt contents, for the AI-crawler-policy action's `before`. */
  currentRobotsTxt?: string;

  /** Entity facts for JSON-LD generation. */
  entity?: EntityFacts;

  /** AI crawlers reported blocked (from the finding evidence), for the robots fix. */
  blockedCrawlers?: string[];

  /**
   * The i18n cluster's language → URL alternates for the hreflang fix (C4.3).
   * Not observable from crawling this one page — `crawlPage`'s own
   * `expectsHreflang` doc comment says as much ("caller's i18n config") — so
   * the caller (onboarding config, sitemap-derived cluster mapping) supplies
   * it. Include this page's own entry if a self-referencing alternate is
   * wanted; the generator emits exactly what it's given, nothing inferred.
   */
  hreflangAlternates?: { lang: string; href: string }[];

  /** The page's current captured body text (B2's `CrawledPage.bodyText`) — the C3.1 content rewrite's `before`, and the source text the LLM edits. */
  currentBodyText?: string;

  /**
   * The page's current body markup — the block an internal-link fix (C3)
   * weaves anchors into, and the `before` a live deploy target locates and
   * replaces. Distinct from `currentBodyText` (visible text, for the LLM
   * rewrite): links can only be inserted into markup. Falls back to
   * `currentBodyText` when absent.
   */
  currentBodyHtml?: string;

  /**
   * Internal-link targets to weave into the page (C3 "internal links"). Like
   * `hreflangAlternates`, this is *not* observable from crawling the page in
   * isolation — which related pages deserve a link, and with what anchor, is
   * an entity-graph / related-content decision the caller owns. The generator
   * inserts exactly what it is given: the first unlinked occurrence of each
   * `anchor` becomes a link to `href`; suggestions whose anchor isn't found
   * (or is already linked) are skipped, nothing invented.
   */
  internalLinkSuggestions?: { anchor: string; href: string }[];

  /**
   * Caller-owned inputs for a C5 GBP fix (B5 findings). Like
   * `hreflangAlternates`/`internalLinkSuggestions`, the value to write is not
   * inferable from the finding alone — the new field text, the reply wording,
   * the post copy are authored by the caller (owner-approved, or an LLM draft
   * upstream) — so the generator emits exactly what it is given and produces
   * nothing when the matching input is absent. Which op a finding needs is
   * decided from its `issueType`; these supply that op's payload.
   */
  gbp?: {
    /** New value for an `incomplete-gbp-field` fix (paired with the finding's `evidence.field`). */
    fieldValue?: string;
    /** Owner reply for an `unanswered-reviews` fix. */
    reviewName?: string;
    reviewReply?: string;
    /** Post copy for a `low-review-velocity` fix (a GBP post to lift engagement). */
    postSummary?: string;
  };
}
