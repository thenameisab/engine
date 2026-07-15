/**
 * JSON-LD (schema.org) generation — the C2 executable action, and the highest-
 * value MVP fix (feeds AI answer extraction). Deterministic: builds a valid
 * JSON-LD block from the entity facts the crawler already resolved. No LLM.
 */
import type { Action } from '@engine/core';
import type { ActionContext, EntityFacts } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

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
 */
export function generateSchemaAction(
  findingId: string,
  ctx: ActionContext,
  env: BuildEnv,
  beforeJsonLd = '',
): Action | null {
  if (!ctx.entity) return null; // can't synthesize schema without entity facts
  const after = buildJsonLd(ctx.entity);
  return buildAction({
    findingId,
    type: 'schema',
    target: ctx.target,
    diff: { before: beforeJsonLd, after, format: 'json-ld' },
    env,
  });
}
