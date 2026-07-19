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
}
