/**
 * The response-part protocol — §4.5, and the grounding contract in §4.6.
 *
 * A Driver answer is not a blob of prose. It is a sequence of typed parts: the
 * model's text, and the figures the tools returned, each carrying where it came
 * from. The screen renders each kind with the component that kind deserves.
 *
 * **The model never picks a chart.** §4.5 weighed letting the model emit
 * markdown and having the client parse it, against each tool declaring its own
 * render shape, and chose the second: "a model that picks chart types will pick
 * badly and inconsistently, and the repo already has a house `dataviz`
 * discipline that a model does not know." So the model chooses which tool to
 * call, and the tool's declared shape decides what the answer looks like.
 *
 * **Figures are retrieval-built.** §4.6 rule 1: every number rendered as a
 * `metric`, `table` or `series` comes from a tool result. The model selects and
 * labels; it does not supply values. That is enforced structurally here — the
 * only part the model's output can reach is `text`, and `buildParts` takes a
 * `ToolResult`, never the model's prose.
 *
 * **Bands stay bands.** §4.6 rule 4. A `metric` carries an optional `band`, and
 * a tool that measures by sampling sets it. Nothing flattens a band to its
 * point, because there is no field to flatten it into.
 */
import type { ToolProvenance, ToolResult, ToolState } from './types.js';

/**
 * How to read a number, so the screen does not have to guess.
 *
 * Formatting lives on the part rather than in the renderer because the same
 * integer is a count in one tool and a position in another, and a position of
 * 4.7 rounded like a count reads as a rank of five when it is not.
 */
export type PartUnit = 'count' | 'percent' | 'position' | 'score' | 'date' | 'text';

export interface PartColumn {
  label: string;
  unit: PartUnit;
}

/** One cell. `null` is "not measured", which is not zero and not an empty string. */
export type PartCell = string | number | null;

/**
 * A figure that rests on a sample rather than a count.
 *
 * Three fields, never one. `citation_events` figures are bands by design, and a
 * band collapsed to `point` is the defect §4.6 rule 4 names.
 */
export interface PartBand {
  low: number;
  point: number;
  high: number;
}

export type ResponsePart =
  /** The model's prose. The only part whose content the model authored. */
  | { kind: 'text'; markdown: string }
  | {
      kind: 'metric';
      label: string;
      value: PartCell;
      unit: PartUnit;
      band?: PartBand;
      provenance: ToolProvenance;
    }
  | {
      kind: 'table';
      title: string;
      columns: PartColumn[];
      rows: PartCell[][];
      provenance: ToolProvenance;
    }
  | {
      kind: 'series';
      title: string;
      unit: PartUnit;
      points: { at: string; value: number }[];
      provenance: ToolProvenance;
    }
  /** Rows for the Findings component, so a finding looks the same in both places. */
  | { kind: 'findings'; findings: Record<string, unknown>[]; provenance: ToolProvenance }
  /** Cards for the Fix Queue component, for the same reason. */
  | { kind: 'fixes'; fixes: Record<string, unknown>[]; provenance: ToolProvenance }
  /**
   * A tool that returned something other than data, and what would fill it.
   *
   * Not in §4.5's list, and added deliberately. §4.2 rule 3 keeps "not
   * connected", "no data yet" and "zero" as three different answers, and §9a
   * decision 6 ships Driver with no gate on Google data — so on a new account
   * most tools return one of these and this part writes the whole first
   * impression. Rendering an empty table instead would say "you have no
   * traffic" when the truth is "nothing is connected yet".
   */
  | {
      kind: 'notice';
      tool: string;
      state: Exclude<ToolState, 'ok'> | 'error';
      reason: string;
      action: string;
      provenance: ToolProvenance;
    };

/* ── What a tool declares ─────────────────────────────────────────────────── */

/**
 * A dotted path into a tool's `data`.
 *
 * Stringly typed, which is the one real weakness of this design: `ToolResult`
 * carries `data: unknown`, so nothing at compile time catches `totals.click`
 * for `totals.clicks`. It is closed by a test rather than by the type system —
 * `parts.db.test.ts` runs every spec against seeded data and fails on any
 * declared path that resolves to `undefined` on an `ok` result. The trade buys
 * one readable file holding every tool's render shape, against nineteen
 * builders scattered beside nineteen handlers.
 */
export type DataPath = string;

export interface MetricSpec {
  label: string;
  at: DataPath;
  unit: PartUnit;
  /** Path to a `{low, point, high}` object, for sampled figures. */
  bandAt?: DataPath;
}

export interface TableSpec {
  title: string;
  /** Path to the array of rows. */
  at: DataPath;
  columns: { label: string; at: DataPath; unit: PartUnit }[];
  /** Cap on rendered rows. The model already asked for a limit; this is the screen's. */
  limit?: number;
}

export interface SeriesSpec {
  title: string;
  at: DataPath;
  /** Paths within each point, relative to the point. */
  xAt: DataPath;
  yAt: DataPath;
  unit: PartUnit;
}

/**
 * One tool's render shape.
 *
 * Every field is optional and a tool may set several: `search_performance`
 * answers with four metrics and a daily series, and both belong in the answer.
 */
export interface ToolRender {
  metrics?: MetricSpec[];
  table?: TableSpec;
  series?: SeriesSpec;
  /** Render the collection at this path with an existing product component. */
  component?: { kind: 'findings' | 'fixes'; at: DataPath };
}

/* ── Building ─────────────────────────────────────────────────────────────── */

/** Walk a dotted path. Returns `undefined` for any missing link, never throws. */
export function pick(data: unknown, path: DataPath): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || node === undefined || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[key];
  }, data);
}

/** A cell, normalised. Anything that is not a string or a finite number is "not measured". */
function toCell(value: unknown): PartCell {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  // Dates arrive from postgres.js as Date objects on some columns and ISO
  // strings on others. A cell has to be one thing.
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * A number, or nothing.
 *
 * Deliberately not `Number(value)`: that turns `null` into `0` and an empty
 * string into `0`, which is the "not measured reported as zero" confusion that
 * the three-state vocabulary exists to prevent. A day with no reading must
 * leave the series rather than sit on the axis at zero.
 *
 * Numeric strings are accepted because postgres.js returns `numeric` and
 * `bigint` columns as strings, and several handlers pass those straight
 * through.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function toBand(value: unknown): PartBand | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const b = value as Record<string, unknown>;
  const [low, point, high] = [b.low, b.point, b.high];
  if (typeof low !== 'number' || typeof point !== 'number' || typeof high !== 'number') return undefined;
  return { low, point, high };
}

function rowsAt(data: unknown, path: DataPath): Record<string, unknown>[] {
  const value = pick(data, path);
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

/**
 * One tool result, as the parts that render it.
 *
 * The three non-`ok` states are not one case, and treating them as one is the
 * mistake this function was written with and then corrected. §4.2 rule 3 says
 * "not connected", "no data yet" and "zero" are three different answers:
 *
 * - **`not-connected` and `no-data-yet` are absences.** Nothing was measured,
 *   so there is one thing to say and it is not an empty table. One notice, and
 *   no other parts.
 * - **`zero` is a measurement.** The query ran against live data and the true
 *   answer is nothing — but the result usually still carries real figures
 *   beside the empty collection. `site_health` on a site with a score of 73
 *   and no open findings is `zero`, and dropping its parts would throw away a
 *   measured score to report an absence that is not there. So a `zero` result
 *   gets its notice *and* its parts, the notice first because the emptiness is
 *   the headline.
 *
 * Empty collections take care of themselves: a table with no rows is omitted
 * below, so a `zero` result renders exactly the figures it does have.
 *
 * `nextStep` is required whenever the state is not `ok`, so the two strings are
 * always there; the fallbacks exist only because the type allows absence.
 */
export function buildParts(tool: string, render: ToolRender, result: ToolResult): ResponsePart[] {
  const parts: ResponsePart[] = [];
  const { data, provenance } = result;

  if (result.state !== 'ok') {
    parts.push({
      kind: 'notice',
      tool,
      state: result.state,
      reason: result.nextStep?.reason ?? `${tool} returned no data.`,
      action: result.nextStep?.action ?? 'No next step was recorded for this result.',
      provenance,
    });
    // An absence has nothing behind it. A measurement does.
    if (result.state !== 'zero') return parts;
  }

  for (const spec of render.metrics ?? []) {
    parts.push({
      kind: 'metric',
      label: spec.label,
      value: toCell(pick(data, spec.at)),
      unit: spec.unit,
      ...(spec.bandAt ? { band: toBand(pick(data, spec.bandAt)) } : {}),
      provenance,
    });
  }

  if (render.series) {
    const spec = render.series;
    const points = rowsAt(data, spec.at)
      .map((p) => ({ at: String(pick(p, spec.xAt) ?? ''), value: toNumber(pick(p, spec.yAt)) }))
      .filter((p): p is { at: string; value: number } => p.at !== '' && p.value !== undefined);
    if (points.length > 0) {
      parts.push({ kind: 'series', title: spec.title, unit: spec.unit, points, provenance });
    }
  }

  if (render.table) {
    const spec = render.table;
    const source = rowsAt(data, spec.at);
    const rows = (spec.limit ? source.slice(0, spec.limit) : source).map((row) =>
      spec.columns.map((c) => toCell(pick(row, c.at))),
    );
    if (rows.length > 0) {
      parts.push({
        kind: 'table',
        title: spec.title,
        columns: spec.columns.map((c) => ({ label: c.label, unit: c.unit })),
        rows,
        provenance,
      });
    }
  }

  if (render.component) {
    const { kind, at } = render.component;
    const items = rowsAt(data, at);
    if (items.length > 0) {
      parts.push(
        kind === 'findings'
          ? { kind: 'findings', findings: items, provenance }
          : { kind: 'fixes', fixes: items, provenance },
      );
    }
  }

  return parts;
}

/**
 * The whole answer: the model's prose, then the evidence behind it.
 *
 * Prose first because the model cannot say where a figure belongs — it emits no
 * part markers, so interleaving is not available at any price. Answer-then-
 * evidence is also the order the existing Copilot panel established, where the
 * grounded answer renders before anything else arrives.
 *
 * A turn with no text still returns its parts. That is the deadline case, and a
 * customer who sees the four tables Driver gathered has more than one who sees
 * an apology.
 */
export function assembleAnswer(text: string, toolParts: readonly ResponsePart[]): ResponsePart[] {
  return [...(text ? [{ kind: 'text' as const, markdown: text }] : []), ...toolParts];
}
