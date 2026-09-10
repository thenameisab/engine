/**
 * What Engine may state as fact about an entity in generated JSON-LD.
 *
 * Lived inside `index.ts` until the batch propose path needed the same two
 * decisions. Duplicating them would have been the worse option: both encode a
 * refusal to guess, and a second copy is a second place for that refusal to be
 * relaxed by accident.
 */

/**
 * The schema.org @type for a schema fix's JSON-LD.
 *
 * A type already published on the site wins: it is the most specific true
 * statement about the entity (a dental practice's page may say `Dentist`,
 * which no picker of ours offers). Otherwise the kind the customer chose for
 * the brand is used. It used to fall back to 'Thing', which let a customer
 * approve `{"@type":"Thing","name":"Acme Dental"}` — valid, deployable, and
 * worth nothing. There is no fallback now; the generator refuses instead and
 * says why.
 */
export function entitySchemaType(entity: { schema: object[]; schemaType: string }): string {
  for (const block of entity.schema) {
    const t = (block as { '@type'?: unknown })['@type'];
    if (typeof t === 'string' && t.trim() !== '' && t.trim() !== 'Thing') return t.trim();
  }
  return entity.schemaType;
}

/**
 * The extra JSON-LD properties Engine can state as fact about an entity: the
 * page the block will live on, and the Wikidata record when the brand is
 * matched to one. Nothing here is inferred — a generated block that guessed an
 * address or a price would be the same trust problem as `@type: Thing`, one
 * layer down.
 */
export function entityJsonLdProperties(
  entity: { urls: string[]; wikidataId: string | null },
  pageUrl: string,
): Record<string, unknown> | undefined {
  const properties: Record<string, unknown> = {};
  const url = pageUrl || entity.urls[0];
  if (url) properties.url = url;
  if (entity.wikidataId) properties.sameAs = `https://www.wikidata.org/wiki/${entity.wikidataId}`;
  return Object.keys(properties).length > 0 ? properties : undefined;
}
