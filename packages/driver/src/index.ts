/**
 * Driver — the conversational surface's semantic layer.
 *
 * This package holds what the tools *mean*: their names, the questions they
 * answer, the arguments they accept, the tier they sit in, and the vocabulary
 * their results are reported in. It holds no SQL and opens no database
 * connection, which is the same division every other package in this repo
 * keeps — all nineteen of them are logic, and `apps/api/src/repositories/` is
 * where rows are read.
 *
 * The handlers that run these tools therefore live in `apps/api/src/driver/`,
 * next to the repositories they reuse. `registry.ts` there binds each
 * definition to exactly one handler and fails the build if the two sets ever
 * differ, so the split cannot drift into a tool that is described here and
 * answers something else there.
 */
export {
  assertNoScopeParameters,
  type JsonSchema,
  type ToolAccess,
  type ToolDefinition,
  type ToolNextStep,
  type ToolProvenance,
  type ToolResult,
  type ToolState,
  type ToolTier,
} from './types.js';

export { DEFERRED_TOOLS, READ_TOOLS, READ_TOOLS_BY_NAME } from './catalogue.js';

export { SYSTEM_PROMPT_RULE, toolErrorEnvelope, toolResultEnvelope } from './envelope.js';

export { assertSchemaIsSupported, validateToolArguments, type ValidationResult } from './validate.js';
