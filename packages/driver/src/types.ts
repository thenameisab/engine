/**
 * The tool contract: what a Driver tool is, what it may return, and what it is
 * never allowed to ask for.
 *
 * This file is the semantic layer's vocabulary. The scoping document's §4.2
 * gives four rules that separate a semantic layer from a query API, and three
 * of them are expressed as types here rather than as conventions:
 *
 *   - Rule 1, the model never supplies scope, is `assertNoScopeParameters`.
 *     A tool whose schema names a project or an account is rejected when the
 *     catalogue is built, not reviewed for at merge time.
 *   - Rule 2, every result carries provenance, is `ToolProvenance` being a
 *     required field of `ToolResult` rather than an optional one.
 *   - Rule 3, three distinct empty answers, is `ToolState`.
 *
 * Rule 4 — bands stay bands — cannot be a type, because a band flattened to a
 * point is still a number. It is enforced where the citation tools are
 * implemented and asserted in their tests.
 */

/**
 * Oversight tier, from §4.3. The tier is a property of the tool, declared once
 * here, so the loop never has to infer how dangerous a call is from its name.
 *
 * Tier 3 is deliberately not in this union. Driver never calls a Tier 3 route,
 * and a tier it cannot express is a tier it cannot be talked into.
 */
export type ToolTier = 0 | 1 | 2;

/**
 * Whether a tool reads or changes something.
 *
 * Redundant with `tier` today — every Tier 0 tool is a read and every Tier 1
 * and 2 tool is a write. It is declared separately because §9a decision 2 asks
 * for an admin control that sets read against write access for a whole
 * organisation, and that control needs a classification it can filter on that
 * is not "tier 0 or not". The control itself is not built here.
 */
export type ToolAccess = 'read' | 'write';

/**
 * What happened when a tool ran.
 *
 * The three non-`ok` states are §4.2's rule 3, and §9a decision 6 is what makes
 * them load bearing: Driver ships with no gate on Google data, so early on most
 * search and traffic answers are `not-connected`. Collapsing them into one
 * "no data" would make a product that has never been connected look identical
 * to one that is connected and genuinely has no clicks.
 *
 * - `ok`            the query ran and returned rows.
 * - `zero`          the query ran, the data source is live, and the true answer
 *                   is zero or an empty list. This is a real measurement.
 * - `not-connected` the integration that would fill this has not been connected,
 *                   so no measurement exists and none can.
 * - `no-data-yet`   the source is connected or applicable, but nothing has been
 *                   collected into it yet — a first sync that has not run, a
 *                   crawl never queued, a keyword never polled.
 */
export type ToolState = 'ok' | 'zero' | 'not-connected' | 'no-data-yet';

/**
 * Where a result's figures came from.
 *
 * Required on every result, including empty ones: "we looked in `gsc_site_daily`
 * for 2026-08-14 to 2026-09-10 and it was empty" is a provenance-carrying
 * answer, and it is the one a customer asking "are you sure?" needs.
 */
export interface ToolProvenance {
  /** The tables read, by their real names in `infra/migrations/postgres/`. */
  tables: string[];
  /** The period covered, inclusive, as ISO dates. Absent when a tool is not time-scoped. */
  period?: { from: string; to: string };
  /**
   * How many samples the figure rests on, for figures that are sampled rather
   * than counted. Present on the citation tools, whose numbers are bands over
   * n samples; absent on tools that count rows.
   */
  sampleCount?: number;
  /** Row ids, when a reader needs to point at exact rows rather than a table. */
  rowIds?: string[];
}

/**
 * What a customer would have to do to turn a non-`ok` state into data.
 *
 * §8's trust answer requires that a tool which returns nothing says which tool
 * returned nothing and what would fill it. A generic apology is the failure
 * this type exists to prevent, so both fields are required whenever it is
 * present.
 */
export interface ToolNextStep {
  /** Why there is nothing, in one sentence, stated as fact. */
  reason: string;
  /** The specific thing that would fill it. */
  action: string;
}

/**
 * One tool's answer.
 *
 * `data` is present in every state, empty rather than null when there is
 * nothing, so a caller never has to null-check before iterating. The state is
 * what says whether the emptiness is a measurement or an absence.
 */
export interface ToolResult<T = unknown> {
  state: ToolState;
  data: T;
  provenance: ToolProvenance;
  /** Required whenever `state` is not `'ok'`; meaningless when it is. */
  nextStep?: ToolNextStep;
}

/**
 * A JSON Schema object, sent to the vendor verbatim.
 *
 * Opaque for the same reason `LlmToolDefinition.parameters` in
 * `@engine/connectors` is opaque: the vendor validates nothing, so the model
 * can send arguments that do not match, and the schema's only jobs are to
 * describe the tool to the model and to drive our own validation.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * A named, project-scoped query with a documented meaning.
 *
 * The description is not documentation, it is the interface: it is the only
 * thing the model reads when it decides whether this tool answers the question
 * in front of it. A description that describes the table rather than the
 * question is how a model ends up calling the wrong tool confidently.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  tier: ToolTier;
  access: ToolAccess;
  /**
   * The tables this tool reads, declared here and copied into the result's
   * provenance rather than written out again at the call site. Two places to
   * state where a number came from is one place for them to disagree.
   */
  tables: string[];
}

/**
 * Parameter names a tool may never accept, in every spelling the model might
 * produce.
 *
 * §4.2 rule 1: "A tool signature that accepts a project id is a cross-tenant
 * read waiting to happen." Scope is injected server-side from the session, so a
 * schema that offers the model a place to put a project id is a defect even
 * when the handler ignores it — the model will fill it, the reader will see it
 * in the audit trail, and the next person to write a handler will use it.
 */
const FORBIDDEN_PARAMETERS: readonly string[] = [
  'projectid',
  'project_id',
  'project',
  'accountid',
  'account_id',
  'account',
  'tenantid',
  'tenant_id',
  'userid',
  'user_id',
];

/**
 * Throws when a tool's schema offers the model a way to choose its own scope.
 *
 * Runs over the schema's top-level properties when the catalogue is built, so a
 * tool that breaks rule 1 cannot reach a deployment. A test asserts it throws;
 * this is not test-only scaffolding, it runs in production at module load.
 */
export function assertNoScopeParameters(tool: ToolDefinition): void {
  const properties = tool.parameters.properties;
  if (!properties || typeof properties !== 'object') return;

  for (const name of Object.keys(properties)) {
    if (FORBIDDEN_PARAMETERS.includes(name.toLowerCase())) {
      throw new Error(
        `Tool "${tool.name}" declares parameter "${name}". Scope is injected server-side ` +
          `(driver scoping §4.2 rule 1); a tool that accepts it is a cross-tenant read.`,
      );
    }
  }
}
