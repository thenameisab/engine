/**
 * Runtime validation for caller-supplied request bodies.
 *
 * `await c.req.json<CrawledPage[]>()` is a *compile-time fiction*: the generic
 * asserts a shape onto bytes off the wire that TypeScript never checked and
 * cannot check. When a caller drifts from the contract the type says nothing and
 * the payload flows straight into code that trusts it — so `metaDescription`
 * missing surfaces as `TypeError: Cannot read properties of undefined (reading
 * 'trim')` from inside the rule engine, and a missing `target` surfaces as
 * postgres.js' `UNDEFINED_VALUE`. Both are 500s: we blame ourselves for the
 * caller's malformed body, and the response names neither the field nor the fix.
 *
 * These validators run at the route boundary and name the offending field, so a
 * contract drift between the crawler/dashboard and this API is a 400 that says
 * what is wrong rather than an opaque 500 someone has to reproduce locally.
 *
 * Deliberately vanilla: no schema library. The repo carries none (deps are Hono
 * and postgres.js), the surface is two request bodies, and the check we need —
 * "name the first field that is wrong" — is a few dozen lines of plain
 * predicates. Reach for a library when the schemas start earning their keep.
 *
 * Scope: each validator covers exactly the fields the route actually
 * dereferences or persists. Requiring more would reject bodies that work.
 */

/** A rejected field: the JSON path that is wrong, and why. `null` means valid. */
export interface Invalid {
  /** Dotted/indexed path from the request body root, e.g. `pages[3].vitals.lcpMs`. */
  field: string;
  message: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Describe what we actually got, for a message the caller can act on. */
function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function checkString(value: unknown, field: string): Invalid | null {
  return typeof value === 'string' ? null : { field, message: `expected a string, got ${describe(value)}` };
}

/** Rejects NaN/Infinity too: they survive JSON only as nulls, but not via a hand-rolled caller. */
function checkNumber(value: unknown, field: string): Invalid | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? null
    : { field, message: `expected a finite number, got ${describe(value)}` };
}

function checkBoolean(value: unknown, field: string): Invalid | null {
  return typeof value === 'boolean' ? null : { field, message: `expected a boolean, got ${describe(value)}` };
}

function checkObject(value: unknown, field: string): Invalid | null {
  return isObject(value) ? null : { field, message: `expected an object, got ${describe(value)}` };
}

function checkArray(value: unknown, field: string): Invalid | null {
  return Array.isArray(value) ? null : { field, message: `expected an array, got ${describe(value)}` };
}

function checkOneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): Invalid | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? null
    : { field, message: `expected one of ${allowed.map((a) => `"${a}"`).join(', ')}, got ${describe(value)}` };
}

/** Run checks in order, returning the first failure — callers fix one field at a time. */
function first(...checks: (Invalid | null)[]): Invalid | null {
  for (const check of checks) if (check) return check;
  return null;
}

/** Apply a per-item validator across an already-verified array. */
function each(
  items: readonly unknown[],
  field: string,
  check: (item: unknown, itemField: string) => Invalid | null,
): Invalid | null {
  for (let i = 0; i < items.length; i++) {
    const invalid = check(items[i], `${field}[${i}]`);
    if (invalid) return invalid;
  }
  return null;
}

/** Absent/undefined is fine (the field is optional); present-but-wrong is not. */
function optional(value: unknown, check: () => Invalid | null): Invalid | null {
  return value === undefined ? null : check();
}

// ── CrawledPage (POST /projects/:projectId/audit) ──────────────────────────

/**
 * The AI crawlers `checkAiCrawlerAccess` audits. All four are required because
 * `CrawledPage.aiCrawlerAccess` is a total `Record<AiCrawler, CrawlerAccess>`,
 * and a missing key would *not* throw — it reads back as `undefined`, compares
 * unequal to `'blocked'`, and the crawler is silently audited as allowed. That
 * is a false negative in a GEO-native check (B1.6): worse than a 500, because
 * nobody finds out. A partial verdict map is a broken crawl, so we say so.
 */
const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'] as const;
const CRAWLER_ACCESS = ['allowed', 'blocked'] as const;
const NOINDEX_SOURCES = ['meta', 'header', 'robots'] as const;

function checkVitals(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const v = value as Record<string, unknown>;
  return first(
    checkNumber(v.lcpMs, `${field}.lcpMs`),
    checkNumber(v.inpMs, `${field}.inpMs`),
    checkNumber(v.cls, `${field}.cls`),
    checkBoolean(v.field, `${field}.field`),
  );
}

function checkStructuredDataBlock(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const b = value as Record<string, unknown>;
  return first(
    checkString(b.type, `${field}.type`),
    checkBoolean(b.valid, `${field}.valid`),
    checkArray(b.errors, `${field}.errors`) ??
      each(b.errors as unknown[], `${field}.errors`, (e, f) => checkString(e, f)),
  );
}

function checkAiCrawlerAccess(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const access = value as Record<string, unknown>;
  return first(...AI_CRAWLERS.map((c) => checkOneOf(access[c], `${field}.${c}`, CRAWLER_ACCESS)));
}

function checkHreflangEntry(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const h = value as Record<string, unknown>;
  return first(checkString(h.lang, `${field}.lang`), checkString(h.href, `${field}.href`));
}

function checkHeadingEntry(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const h = value as Record<string, unknown>;
  return first(checkNumber(h.level, `${field}.level`), checkString(h.text, `${field}.text`));
}

function checkNoindex(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  return checkOneOf((value as Record<string, unknown>).source, `${field}.source`, NOINDEX_SOURCES);
}

/** Validate one `CrawledPage`. Every required field here is read by a detector. */
export function checkCrawledPage(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const p = value as Record<string, unknown>;

  return first(
    checkString(p.url, `${field}.url`),
    checkString(p.entityId, `${field}.entityId`),
    checkNumber(p.statusCode, `${field}.statusCode`),
    checkArray(p.redirectChain, `${field}.redirectChain`) ??
      each(p.redirectChain as unknown[], `${field}.redirectChain`, (r, f) => checkString(r, f)),
    optional(p.canonical, () => checkString(p.canonical, `${field}.canonical`)),
    checkBoolean(p.indexable, `${field}.indexable`),
    optional(p.noindex, () => checkNoindex(p.noindex, `${field}.noindex`)),
    checkBoolean(p.inSitemap, `${field}.inSitemap`),
    // The two that produced the reported 500: `.trim()` on undefined.
    checkString(p.title, `${field}.title`),
    checkString(p.metaDescription, `${field}.metaDescription`),
    checkVitals(p.vitals, `${field}.vitals`),
    checkArray(p.structuredData, `${field}.structuredData`) ??
      each(p.structuredData as unknown[], `${field}.structuredData`, checkStructuredDataBlock),
    checkAiCrawlerAccess(p.aiCrawlerAccess, `${field}.aiCrawlerAccess`),
    checkArray(p.hreflang, `${field}.hreflang`) ??
      each(p.hreflang as unknown[], `${field}.hreflang`, checkHreflangEntry),
    checkBoolean(p.expectsHreflang, `${field}.expectsHreflang`),
    optional(p.pageValue, () => checkNumber(p.pageValue, `${field}.pageValue`)),
    optional(
      p.headings,
      () =>
        checkArray(p.headings, `${field}.headings`) ??
        each(p.headings as unknown[], `${field}.headings`, checkHeadingEntry),
    ),
    optional(p.bodyText, () => checkString(p.bodyText, `${field}.bodyText`)),
  );
}

/**
 * Validate the `POST /audit` body. On success the cast is earned, not asserted.
 *
 * `target` is optional (C3.2 "at scale" opt-in): if supplied, `/audit` also
 * auto-proposes meta title/description fixes for every eligible finding in
 * this crawl, deployed to that target. Omitted, the route behaves exactly as
 * before — a caller who only wants findings never gets actions they didn't
 * ask for.
 */
export function checkAuditBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  const pagesInvalid =
    b.pages === undefined ? null : checkArray(b.pages, 'pages') ?? each(b.pages as unknown[], 'pages', checkCrawledPage);
  if (pagesInvalid) return pagesInvalid;
  return optional(b.target, () => checkDeployTarget(b.target, 'target'));
}

// ── Finding + ActionContext (POST /projects/:projectId/actions/generate) ────

const ACTION_TYPES = ['schema', 'meta', 'redirect', 'robots', 'content', 'internal-link', 'gbp'] as const;

/**
 * `DeployTarget` is a discriminated union, and it is persisted verbatim to a
 * jsonb column that the edge worker later reads to decide *where* to write a
 * fix. An unrecognized `kind` would store cleanly and only fail at deploy time,
 * far from the caller that caused it — so validate the variant here.
 */
function checkDeployTarget(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const t = value as Record<string, unknown>;

  switch (t.kind) {
    case 'cms-plugin':
      return first(
        checkOneOf(t.plugin, `${field}.plugin`, ['wordpress', 'shopify'] as const),
        checkString(t.siteId, `${field}.siteId`),
      );
    case 'edge-worker':
      return checkString(t.workerName, `${field}.workerName`);
    case 'github-pr':
      return first(
        checkString(t.repo, `${field}.repo`),
        checkString(t.branch, `${field}.branch`),
        checkString(t.path, `${field}.path`),
      );
    case 'gbp-api':
      return checkString(t.locationId, `${field}.locationId`);
    default:
      return checkOneOf(t.kind, `${field}.kind`, ['cms-plugin', 'edge-worker', 'github-pr', 'gbp-api'] as const);
  }
}

/**
 * Validate the `PUT /projects/:id/deploy-target` body. The target is persisted
 * to a jsonb column the edge worker later reads, so an unrecognized variant is
 * caught here (via the shared `checkDeployTarget`) rather than at deploy time.
 */
export function checkDeployTargetBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  return checkDeployTarget((body as Record<string, unknown>).target, 'target');
}

function checkActionTemplate(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  // `generateActions` dispatches on `type` alone; label/description are carried
  // for display and never read here, so requiring them would reject working bodies.
  return checkOneOf((value as Record<string, unknown>).type, `${field}.type`, ACTION_TYPES);
}

/**
 * Validate the `Finding` half of the generate body — the fields `generateActions`
 * reads and `createAction` persists:
 *  - `id` becomes `actions.finding_id`, a uuid FK. Undefined is the same
 *    `UNDEFINED_VALUE` 500 as a missing `target`.
 *  - `actionTemplates` is iterated; undefined throws before any of it runs.
 *  - `evidence` is read for the robots fix's blocked-crawler list.
 * `severity`/`predictedImpact`/`source`/`createdAt` belong to the Finding
 * contract but this route never reads them, so they are not required here.
 */
function checkFinding(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const f = value as Record<string, unknown>;

  return first(
    checkString(f.id, `${field}.id`),
    checkObject(f.evidence, `${field}.evidence`),
    checkArray(f.actionTemplates, `${field}.actionTemplates`) ??
      each(f.actionTemplates as unknown[], `${field}.actionTemplates`, checkActionTemplate),
  );
}

/**
 * Validate the `ActionContext`. Only `url` and `target` are required — the rest
 * are genuinely optional in the contract, and the generators already treat an
 * absent `currentTitle`/`entity` as "nothing to diff against" by design.
 */
function checkActionContext(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const ctx = value as Record<string, unknown>;

  return first(
    checkString(ctx.url, `${field}.url`),
    // The reported 500: absent `target` reaches postgres.js as UNDEFINED_VALUE.
    checkDeployTarget(ctx.target, `${field}.target`),
    optional(ctx.currentTitle, () => checkString(ctx.currentTitle, `${field}.currentTitle`)),
    optional(ctx.currentMetaDescription, () =>
      checkString(ctx.currentMetaDescription, `${field}.currentMetaDescription`),
    ),
    optional(ctx.leadHeading, () => checkString(ctx.leadHeading, `${field}.leadHeading`)),
    optional(ctx.currentRobotsTxt, () => checkString(ctx.currentRobotsTxt, `${field}.currentRobotsTxt`)),
    optional(ctx.entity, () => checkEntityFacts(ctx.entity, `${field}.entity`)),
    optional(ctx.blockedCrawlers, () =>
      first(
        checkArray(ctx.blockedCrawlers, `${field}.blockedCrawlers`),
        each(
          Array.isArray(ctx.blockedCrawlers) ? ctx.blockedCrawlers : [],
          `${field}.blockedCrawlers`,
          (c, cf) => checkString(c, cf),
        ),
      ),
    ),
  );
}

function checkEntityFacts(value: unknown, field: string): Invalid | null {
  const invalid = checkObject(value, field);
  if (invalid) return invalid;
  const e = value as Record<string, unknown>;
  return first(
    checkString(e.schemaType, `${field}.schemaType`),
    checkString(e.name, `${field}.name`),
    optional(e.description, () => checkString(e.description, `${field}.description`)),
    optional(e.properties, () => checkObject(e.properties, `${field}.properties`)),
  );
}

/** Validate the `POST /actions/generate` body. */
export function checkGenerateBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return first(checkFinding(b.finding, 'finding'), checkActionContext(b.context, 'context'));
}

// ── Keyword config (POST /projects/:projectId/entities/:entityId/keywords) ─

const DEVICES = ['desktop', 'mobile', 'tablet'] as const;
const RANK_ENGINES = ['google', 'bing'] as const;
const CADENCES = ['weekly', 'daily', 'on_demand'] as const;

/**
 * `device`/`engine`/`cadence` are all `check` constraints in the
 * `keyword_configs` table (migration 0001) — an unvalidated bad value would
 * reach Postgres and 500 as a constraint violation naming neither the field
 * nor the allowed values, same class of bug the audit/generate validators
 * above already fixed.
 */
export function checkCreateKeywordConfigBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return first(
    checkString(b.keyword, 'keyword'),
    checkString(b.geoCountry, 'geoCountry'),
    optional(b.geoCity, () => checkString(b.geoCity, 'geoCity')),
    optional(b.geoPostcode, () => checkString(b.geoPostcode, 'geoPostcode')),
    checkOneOf(b.device, 'device', DEVICES),
    checkString(b.language, 'language'),
    checkOneOf(b.engine, 'engine', RANK_ENGINES),
    optional(b.cadence, () => checkOneOf(b.cadence, 'cadence', CADENCES)),
  );
}

// ── Checkout (POST /accounts/:accountId/billing/checkout) ──────────────────

const PLAN_TIERS = ['starter', 'growth', 'agency', 'enterprise'] as const;

export function checkUrl(value: unknown, field: string): Invalid | null {
  const invalid = checkString(value, field);
  if (invalid) return invalid;
  let parsed: URL;
  try {
    parsed = new URL(value as string);
  } catch {
    return { field, message: `expected a valid URL, got ${JSON.stringify(value)}` };
  }
  // The WHATWG URL parser accepts any scheme ('javascript:', 'data:', ...) as
  // syntactically valid. Restricting to http(s) here, not just "parses",
  // closes an open-redirect-adjacent hole on a customer-facing checkout flow.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field, message: `expected an http(s) URL, got scheme "${parsed.protocol}"` };
  }
  return null;
}

/**
 * `successUrl`/`cancelUrl` are checked as real URLs (not just non-empty
 * strings) because Stripe's own 400 for a malformed one is opaque, and a
 * caller-supplied redirect target reaching Stripe unchecked is also an open
 * redirect risk this validator closes off at the boundary.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Path params flow straight into `uuid`-typed columns; a malformed one throws
 *  postgres.js' `invalid input syntax for type uuid` as an opaque 500 before
 *  any query logic runs. Check it at the boundary instead. */
export function checkUuidParam(value: string, field: string): Invalid | null {
  if (!UUID_RE.test(value)) return { field, message: 'must be a uuid' };
  return null;
}

export function checkCreateCheckoutBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return first(
    checkOneOf(b.tier, 'tier', PLAN_TIERS),
    checkUrl(b.successUrl, 'successUrl'),
    checkUrl(b.cancelUrl, 'cancelUrl'),
    optional(b.customerEmail, () => checkString(b.customerEmail, 'customerEmail')),
  );
}

// ── M2.5 agency white-label (POST /accounts, POST /accounts/:id/projects,
// PATCH /accounts/:id/branding) ─────────────────────────────────────────────

export function checkCreateAccountBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return checkString(b.name, 'name');
}

export function checkCreateProjectBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return first(checkString(b.name, 'name'), checkString(b.domain, 'domain'));
}

/**
 * `logoUrl` gets the same http(s)-only check as `successUrl`/`cancelUrl`: it
 * is caller-supplied and rendered back into a branded report page, so the
 * same open-redirect-adjacent reasoning applies. `companyName`/`primaryColor`
 * are free text — nothing downstream executes them as a URL or a query.
 */
export function checkBrandingBody(body: unknown): Invalid | null {
  const invalid = checkObject(body, 'body');
  if (invalid) return invalid;
  const b = body as Record<string, unknown>;
  return first(
    optional(b.companyName, () => checkString(b.companyName, 'companyName')),
    optional(b.logoUrl, () => checkUrl(b.logoUrl, 'logoUrl')),
    optional(b.primaryColor, () => checkString(b.primaryColor, 'primaryColor')),
  );
}
