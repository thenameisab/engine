/**
 * The entity-first data model (Architecture §1, Layer 3).
 * All analytics join through `entityId`. A URL, a keyword, and an AI
 * citation are all facets of an Entity, not standalone records.
 * This is the join key the rest of the system is built around and is
 * explicitly called out as something that cannot be retrofitted later.
 */
export interface Entity {
  id: string;
  canonicalName: string;
  wikidataId: string | null;
  urls: string[];
  keywords: string[];
  prompts: string[];
  citations: string[];
  mentions: string[];
  schema: object[];
  /**
   * The schema.org type this entity is, e.g. `LocalBusiness`. Set from the
   * kind the customer picks when they add a site, and used as the `@type` of
   * any JSON-LD Engine proposes for it. Never `Thing`: the supertype is valid
   * and says nothing, and structured data that says nothing is not worth
   * asking anyone to approve. See `ENTITY_KINDS`.
   */
  schemaType: string;
  /**
   * Whose brand this is. `'self'` is one of the customer's own; `'competitor'`
   * is a rival, added by domain on the Competitors screen so the gap analysis
   * has something to compare against.
   *
   * Not the same axis as `schemaType`, which says what *sort of thing* the
   * entity is. A competitor is still an Organization or a Product; the role
   * says whether the customer's own numbers should include it. Several
   * readers — the visibility rollup, the entity audit, every brand picker —
   * must count only `'self'`, and a competitor silently folded into those is
   * a wrong number rather than a visible error.
   */
  role: EntityRole;
  createdAt: string;
  updatedAt: string;
}

/**
 * The kinds of thing a brand can be, in the customer's words, each mapped to
 * the schema.org type Engine writes into their structured data. The customer
 * never sees the right-hand side; the generator never invents one.
 *
 * Kept short on purpose. schema.org has hundreds of types and a customer
 * cannot rank them; these six cover what Engine's audits actually reason
 * about, and a site whose real type is more specific (a `Dentist`, say) keeps
 * that type anyway, because a type already published on the page wins over
 * this default.
 */
export const ENTITY_KINDS = [
  { value: 'LocalBusiness', label: 'A business people visit in person' },
  { value: 'Organization', label: 'An online business or organisation' },
  { value: 'Product', label: 'A product' },
  { value: 'Service', label: 'A service' },
  { value: 'SoftwareApplication', label: 'Software or an app' },
  { value: 'Person', label: 'A person' },
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number]['value'];

export const DEFAULT_ENTITY_KIND: EntityKind = 'Organization';

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && ENTITY_KINDS.some((k) => k.value === value);
}

/** Whose brand an entity is. See `Entity.role`. */
export const ENTITY_ROLES = ['self', 'competitor'] as const;

export type EntityRole = (typeof ENTITY_ROLES)[number];

export const DEFAULT_ENTITY_ROLE: EntityRole = 'self';

export function isEntityRole(value: unknown): value is EntityRole {
  return typeof value === 'string' && (ENTITY_ROLES as readonly string[]).includes(value);
}
