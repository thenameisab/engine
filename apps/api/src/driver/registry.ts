/**
 * Binding each catalogue definition to exactly one handler.
 *
 * `@engine/driver` says what the tools mean; this directory says what they run.
 * That split is deliberate — it is what lets the Google handlers reuse
 * `googleMetrics.ts` instead of restating its definitions — but a split contract
 * can drift, and the failure mode is quiet: a tool whose description promises
 * one thing and whose SQL answers another is exactly the fabricated metric
 * definition that §4.2's semantic layer exists to prevent.
 *
 * `assertRegistryMatchesCatalogue` runs at module load. A definition with no
 * handler, or a handler with no definition, fails the deployment.
 */
import {
  READ_TOOLS,
  READ_TOOLS_BY_NAME,
  toolErrorEnvelope,
  toolResultEnvelope,
  validateToolArguments,
  type ToolResult,
} from '@engine/driver';
import { BRAND_HANDLERS } from './brand.js';
import { GOOGLE_HANDLERS } from './google.js';
import { SITE_HANDLERS } from './site.js';
import { VISIBILITY_HANDLERS } from './visibility.js';
import type { DriverToolContext, ToolHandler } from './context.js';

/** Every read tool that can actually run, by the name the model uses. */
export const READ_HANDLERS: Record<string, ToolHandler> = {
  ...GOOGLE_HANDLERS,
  ...VISIBILITY_HANDLERS,
  ...SITE_HANDLERS,
  ...BRAND_HANDLERS,
};

/**
 * Throws when the catalogue and the handler map are not the same set.
 *
 * Both directions matter. A definition with no handler is a tool the model will
 * be offered and cannot call. A handler with no definition is dead code at best,
 * and at worst a tool that can be invoked by name without ever having been
 * described, tiered, or checked for scope parameters.
 */
export function assertRegistryMatchesCatalogue(): void {
  const declared = new Set(READ_TOOLS.map((t) => t.name));
  const implemented = new Set(Object.keys(READ_HANDLERS));

  const missing = [...declared].filter((name) => !implemented.has(name));
  const orphaned = [...implemented].filter((name) => !declared.has(name));

  if (missing.length > 0 || orphaned.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`declared with no handler: ${missing.join(', ')}`);
    if (orphaned.length > 0) parts.push(`handlers with no definition: ${orphaned.join(', ')}`);
    throw new Error(`Driver tool registry does not match the catalogue — ${parts.join('; ')}.`);
  }
}

assertRegistryMatchesCatalogue();

/**
 * Run one tool call and return it as a `role: 'tool'` message body.
 *
 * The whole path from "the model asked for something" to "text goes back into
 * the conversation" is here, because every step of it is a place the loop could
 * otherwise get it subtly wrong:
 *
 *  - An unknown tool name is answered, not thrown. A model that hallucinates a
 *    tool needs to be told the tool does not exist so it can pick a real one.
 *  - Invalid arguments come back as the validator's sentence, for the same
 *    reason: "days must be an integer" is a message the model can act on.
 *  - A handler that throws is reported as `state="error"`, never as an empty
 *    result. A connection reset read as "no rows" becomes "you have no traffic",
 *    which is a wrong answer rather than a missing one.
 *  - Scope comes from `ctx` and nothing in `rawArguments` can reach it.
 */
export async function runToolCall(
  ctx: DriverToolContext,
  name: string,
  rawArguments: string,
): Promise<string> {
  const definition = READ_TOOLS_BY_NAME.get(name);
  const handler = READ_HANDLERS[name];

  if (!definition || !handler) {
    return toolErrorEnvelope(
      name,
      `There is no tool called "${name}". Available tools: ${READ_TOOLS.map((t) => t.name).join(', ')}.`,
    );
  }

  const validated = validateToolArguments(definition, rawArguments);
  if (!validated.ok) return toolErrorEnvelope(name, validated.error);

  let result: ToolResult;
  try {
    result = await handler(ctx, validated.args);
  } catch (error) {
    return toolErrorEnvelope(name, error instanceof Error ? error.message : String(error));
  }

  // Provenance is stamped from the definition rather than trusted from the
  // handler, so a handler cannot claim to have read a table the catalogue never
  // said it reads. The handler may narrow the list; it may not extend it.
  const declared = new Set(definition.tables);
  const tables = result.provenance.tables.filter((t) => declared.has(t));
  return toolResultEnvelope(name, {
    ...result,
    provenance: { ...result.provenance, tables: tables.length > 0 ? tables : definition.tables },
  });
}
