/**
 * On-site JSON-LD inspection for B3.2 (schema entity mapping) and B3.1
 * (sameAs). Pure structural checks over the schema blocks the crawler already
 * resolved — no network, no parsing of raw HTML (that happened upstream).
 */

/** schema.org @types that identify a business/person entity (not a WebPage/Article). */
const ENTITY_TYPES = new Set([
  'Organization',
  'Corporation',
  'LocalBusiness',
  'Person',
  'Brand',
  'Store',
  'Restaurant',
  'ProfessionalService',
]);

function asRecord(block: unknown): Record<string, unknown> | null {
  return block && typeof block === 'object' && !Array.isArray(block) ? (block as Record<string, unknown>) : null;
}

/** The @type of a block, normalized to a lowercased string array (it may be a string or array). */
function typesOf(rec: Record<string, unknown>): string[] {
  const t = rec['@type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/** Whether a block identifies an entity of an org/person kind. */
function isEntityBlock(rec: Record<string, unknown>): boolean {
  return typesOf(rec).some((t) => ENTITY_TYPES.has(t));
}

/** Case/whitespace-insensitive name equality — schema names drift in casing. */
function nameMatches(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Find the on-site JSON-LD block that identifies this entity by name and an
 * org/person @type. Returns it (for sameAs inspection) or null when the crawl
 * carried no schema that names the entity — the B3.2 "missing-entity-schema"
 * signal.
 */
export function findEntityBlock(schema: object[], canonicalName: string): Record<string, unknown> | null {
  for (const block of schema) {
    const rec = asRecord(block);
    if (rec && isEntityBlock(rec) && nameMatches(rec.name, canonicalName)) return rec;
  }
  return null;
}

/** The sameAs URLs declared on an entity block, as a string array (sameAs may be a string or array). */
export function sameAsOf(rec: Record<string, unknown>): string[] {
  const s = rec.sameAs;
  if (typeof s === 'string') return [s];
  if (Array.isArray(s)) return s.filter((x): x is string => typeof x === 'string');
  return [];
}
