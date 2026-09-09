/**
 * JSON-LD (schema.org) generation — the C2 executable action, and the highest-
 * value MVP fix (feeds AI answer extraction). Deterministic: builds a valid
 * JSON-LD block from the entity facts the crawler already resolved. No LLM.
 */
import type { ActionContext, EntityFacts } from './context.js';
import { buildAction, type BuildEnv, type Generated } from './build.js';

/**
 * schema.org's supertype. Valid, and worth nothing: `{"@type":"Thing"}` tells a
 * search engine or an assistant only that the page is about something. It was
 * the fallback when an entity declared no typed block, which meant a customer
 * could approve JSON-LD that said nothing about their business. Now it is the
 * one type the generator refuses to emit.
 */
const USELESS_TYPE = 'Thing';

/** Serialize entity facts into a schema.org JSON-LD object (stable key order). */
export function buildJsonLd(entity: EntityFacts): string {
  const doc: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': entity.schemaType,
    name: entity.name,
  };
  if (entity.description) doc.description = entity.description;
  for (const [k, v] of Object.entries(entity.properties ?? {})) doc[k] = v;
  return JSON.stringify(doc, null, 2);
}

/**
 * Generate a schema action. `before` is the existing (invalid or empty) JSON-LD
 * from the finding evidence; `after` is the freshly generated valid block.
 * Refuses when the entity has no meaningful schema.org type — see USELESS_TYPE.
 */
export function generateSchemaAction(
  findingId: string,
  ctx: ActionContext,
  env: BuildEnv,
  beforeJsonLd = '',
): Generated {
  if (!ctx.entity) {
    return { reason: 'Engine needs to know which brand this page is about before it can write structured data for it.' };
  }
  const type = ctx.entity.schemaType?.trim();
  if (!type || type === USELESS_TYPE) {
    return {
      reason:
        'Engine does not know what kind of business or thing this page describes, so any structured data it wrote would say nothing. Set the brand’s kind in Settings, then propose this fix again.',
    };
  }
  const after = buildJsonLd(ctx.entity);
  return buildAction({
    findingId,
    type: 'schema',
    target: ctx.target,
    diff: { before: beforeJsonLd, after, format: 'json-ld' },
    env,
  });
}
