/**
 * Validating what the model sent against what the tool declared.
 *
 * `@engine/connectors` deliberately hands over tool-call arguments as an
 * unparsed JSON string, on the reasoning that the layer which knows the tool's
 * schema is the layer that should decide what a malformed argument means. This
 * is that layer.
 *
 * The vendor validates nothing. A model can emit malformed JSON, arguments that
 * do not match the schema, extra properties, a string where a number belongs, or
 * an enum value it invented. Every one of those has to become a message the
 * model can act on — "you sent `days: \"last month\"`, it must be an integer" —
 * rather than an exception, because the loop's correct response to a bad call is
 * to tell the model and let it try again.
 *
 * Deliberately not a JSON Schema library. The catalogue uses six keywords
 * (`type`, `enum`, `minimum`, `maximum`, `default`, `required`) and a dependency
 * that implements three hundred would be more code to audit, not less. The
 * validator rejects any keyword it does not implement when the catalogue is
 * built, so this file cannot silently ignore a constraint a tool thought it had.
 */
import type { JsonSchema, ToolDefinition } from './types.js';

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string };

/** Schema keywords this validator understands. Anything else is a build error. */
const SUPPORTED = new Set(['type', 'enum', 'minimum', 'maximum', 'default', 'description']);

/**
 * Throws when a tool declares a constraint this validator would silently drop.
 *
 * The failure this prevents is quiet: a tool adds `maxLength` believing it is
 * enforced, the validator ignores it, and the constraint exists only in the
 * description the model is free to disregard.
 */
export function assertSchemaIsSupported(tool: ToolDefinition): void {
  const properties = tool.parameters.properties as Record<string, JsonSchema> | undefined;
  if (!properties) return;

  for (const [name, property] of Object.entries(properties)) {
    for (const keyword of Object.keys(property)) {
      if (!SUPPORTED.has(keyword)) {
        throw new Error(
          `Tool "${tool.name}" parameter "${name}" uses JSON Schema keyword "${keyword}", ` +
            `which validate.ts does not enforce. Implement it or remove it — a constraint that ` +
            `is declared and not checked is worse than one that was never declared.`,
        );
      }
    }
  }
}

/** One property's check. Returns an error sentence, or null when it passes. */
function checkProperty(name: string, value: unknown, property: JsonSchema): string | null {
  const type = property.type;

  if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      return `"${name}" must be a ${type}, received ${JSON.stringify(value)}.`;
    }
    if (type === 'integer' && !Number.isInteger(value)) {
      return `"${name}" must be a whole number, received ${value}.`;
    }
    if (typeof property.minimum === 'number' && value < property.minimum) {
      return `"${name}" must be at least ${property.minimum}, received ${value}.`;
    }
    if (typeof property.maximum === 'number' && value > property.maximum) {
      return `"${name}" must be at most ${property.maximum}, received ${value}.`;
    }
    return null;
  }

  if (type === 'boolean') {
    return typeof value === 'boolean'
      ? null
      : `"${name}" must be true or false, received ${JSON.stringify(value)}.`;
  }

  if (type === 'string') {
    if (typeof value !== 'string') {
      return `"${name}" must be a string, received ${JSON.stringify(value)}.`;
    }
    const options = property.enum;
    if (Array.isArray(options) && !options.includes(value)) {
      return `"${name}" must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}, received ${JSON.stringify(value)}.`;
    }
    return null;
  }

  return null;
}

/**
 * Parse and validate the model's arguments for one tool.
 *
 * Applies declared defaults for properties the model omitted, so a handler reads
 * `args.days` and gets 28 rather than having to restate the default the schema
 * already told the model about. Two statements of the same default is how the
 * model's idea of a period and the handler's drift apart.
 *
 * `null` is treated as omitted. Models routinely send `{"keyword": null}` for an
 * optional argument they decided not to use, and rejecting that would fail a
 * call that was correct in intent.
 */
export function validateToolArguments(tool: ToolDefinition, raw: string): ValidationResult {
  let parsed: unknown;
  if (raw.trim() === '') {
    parsed = {};
  } else {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: `Arguments for ${tool.name} are not valid JSON.` };
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: `Arguments for ${tool.name} must be a JSON object.` };
  }

  const sent = parsed as Record<string, unknown>;
  const properties = (tool.parameters.properties ?? {}) as Record<string, JsonSchema>;
  const required = (tool.parameters.required ?? []) as string[];

  const unknown = Object.keys(sent).filter((key) => !(key in properties));
  if (unknown.length > 0) {
    const accepted = Object.keys(properties);
    return {
      ok: false,
      error:
        `${tool.name} does not accept ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
        (accepted.length > 0
          ? `It accepts ${accepted.map((a) => `"${a}"`).join(', ')}.`
          : 'It takes no arguments.'),
    };
  }

  const args: Record<string, unknown> = {};

  for (const [name, property] of Object.entries(properties)) {
    const value = sent[name];

    if (value === undefined || value === null) {
      if (required.includes(name)) {
        return { ok: false, error: `${tool.name} requires "${name}".` };
      }
      if (property.default !== undefined) args[name] = property.default;
      continue;
    }

    const error = checkProperty(name, value, property);
    if (error) return { ok: false, error };
    args[name] = value;
  }

  return { ok: true, args };
}
