/**
 * A Driver answer on screen — the seven `ResponsePart` kinds and nothing else.
 *
 * The division of labour is §4.5's and it is the reason this file is short.
 * The model chose which tool to call; the tool declared its own render shape;
 * the server built typed parts from the tool's result. Nothing here decides
 * what an answer looks like — it renders what arrived, with the component each
 * kind deserves.
 *
 * **No figure is authored here.** §4.6 rule 1: every number in a `metric`,
 * `table` or `series` came out of a tool result. This file formats and never
 * computes: no totals, no percentages of one part against another, no derived
 * rows. A figure the reader sees has to be a figure a tool returned, or the
 * grounding contract is a promise rather than a property.
 *
 * **Bands stay bands.** §4.6 rule 4. A `metric` with a band renders three
 * numbers. There is deliberately no code path that shows a band's `point`
 * alone, however much narrower it would be.
 *
 * **Three absences, not one.** §4.2 rule 3, made load bearing by §9a decision
 * 6 shipping Driver with no gate on Google data: early on most search and
 * traffic answers are `not-connected`. `zero` is a measurement and keeps its
 * figures; the other two are absences and render the notice alone. The server
 * already enforces that split in `buildParts` — this file must not undo it by
 * styling the three the same, which is why the notice carries its own heading
 * per state rather than one "no data" box.
 */
import { el } from './dom.js';
import { icon, ICONS } from './icons.js';
import { findingGroupBlock } from './findingGroup.js';
import {
  driverFindingRows,
  driverFixRows,
  formatBand,
  formatPartCell,
  groupFindings,
  noticeHeading,
  provenanceLine,
  sparklineArea,
  sparklinePath,
} from './format.js';
import type { AppContext } from './context.js';
import type { PartUnit, ResponsePart } from './types.js';

/**
 * Where a figure came from, foldable.
 *
 * §4.6 rule 3 says every part carries provenance and the UI can show it
 * without a round trip. Shown on demand rather than always: the tables read
 * are the answer to "are you sure?", which is a question asked about one
 * figure occasionally, not about every figure every time. Printing
 * `gsc_site_daily, gsc_query_daily · 2026-08-14 to 2026-09-10` under six
 * metrics would bury the answer in its own footnotes.
 */
function provenance(p: { tables: string[]; period?: { from: string; to: string }; sampleCount?: number }): HTMLElement {
  const line = el('div', { class: 'dv-prov-line num' }, [provenanceLine(p)]);
  line.hidden = true;
  const toggle = el('button', { class: 'dv-prov-toggle', type: 'button', 'aria-expanded': 'false' }, ['Where this came from']);
  toggle.addEventListener('click', () => {
    line.hidden = !line.hidden;
    toggle.setAttribute('aria-expanded', String(!line.hidden));
  });
  return el('div', { class: 'dv-prov' }, [toggle, line]);
}

/** One figure, with its band when it has one. */
function metricPart(part: Extract<ResponsePart, { kind: 'metric' }>): HTMLElement {
  return el('div', { class: 'dv-metric' }, [
    el('div', { class: 'dv-metric-k' }, [part.label]),
    el('div', { class: 'dv-metric-v num' }, [formatPartCell(part.value, part.unit)]),
    // Three numbers, never one. A sampled figure that renders as a point reads
    // as a count, and the reader has no way to know the difference.
    ...(part.band
      ? [el('div', { class: 'dv-metric-band num' }, [`range ${formatBand(part.band, part.unit)}`])]
      : []),
  ]);
}

/**
 * Figures from one tool call, in a strip.
 *
 * Grouped rather than one box each because they came from one call and one
 * period — `search_performance` returns clicks, impressions, CTR and position
 * together, and four separately-bordered boxes would imply four lookups. The
 * strip is the existing `.cell`-row idiom's shape without its meter.
 */
function metricStrip(parts: Extract<ResponsePart, { kind: 'metric' }>[]): HTMLElement {
  return el('div', { class: 'dv-block' }, [
    el('div', { class: 'dv-metrics' }, parts.map(metricPart)),
    provenance(parts[0].provenance),
  ]);
}

/**
 * A table, as a real `<table>`.
 *
 * The product's list-row grammar is deliberately not used here. That grammar
 * sizes its tracks through `--lrow-cols` declared on a variant class, which
 * requires the column count to be known when the stylesheet is written — and a
 * Driver table's arity comes from whichever tool answered, between two and five
 * columns across the catalogue. A `<table>` also carries the header
 * relationship that a grid of divs only mimics, which matters more here than
 * anywhere else in the product: these columns are unfamiliar and unlabelled
 * cells would be unreadable.
 *
 * The wrapper scrolls on its own so a five-column table on a phone does not
 * make the page scroll sideways.
 */
function tablePart(part: Extract<ResponsePart, { kind: 'table' }>): HTMLElement {
  const head = el('tr', {}, part.columns.map((c) =>
    el('th', { class: c.unit === 'text' ? '' : 'num', scope: 'col' }, [c.label]),
  ));
  const body = part.rows.map((row) =>
    el('tr', {}, row.map((cell, i) => {
      const unit: PartUnit = part.columns[i]?.unit ?? 'text';
      return el('td', { class: unit === 'text' ? '' : 'num' }, [formatPartCell(cell, unit)]);
    })),
  );
  return el('div', { class: 'dv-block' }, [
    el('div', { class: 'dv-title' }, [part.title]),
    el('div', { class: 'dv-tablewrap' }, [
      el('table', { class: 'dv-table' }, [el('thead', {}, [head]), el('tbody', {}, body)]),
    ]),
    provenance(part.provenance),
  ]);
}

/**
 * A series, as the sparkline the product already draws.
 *
 * Same two paths and the same classes as Pulse's panels — `.spark` is the
 * geometry, `.gm-spark` the placement and paint — so a line in a Driver answer
 * is the same line the customer saw on Home. `preserveAspectRatio="none"`
 * distorts strokes, which is why the stylesheet's `.line` carries
 * `vector-effect: non-scaling-stroke`.
 *
 * One point is not a line. A single reading renders as its value rather than as
 * a flat segment across the width of the panel, which would read as "no change
 * over the period" when the period holds one day.
 */
function seriesPart(part: Extract<ResponsePart, { kind: 'series' }>): HTMLElement {
  const values = part.points.map((p) => p.value);
  const first = part.points[0];
  const last = part.points[part.points.length - 1];
  const range = `${first.at} to ${last.at}`;

  const block = el('div', { class: 'dv-block' }, [
    el('div', { class: 'dv-title' }, [part.title]),
  ]);

  if (values.length < 2) {
    block.append(el('div', { class: 'dv-metric' }, [
      el('div', { class: 'dv-metric-k' }, [first.at]),
      el('div', { class: 'dv-metric-v num' }, [formatPartCell(first.value, part.unit)]),
    ]));
  } else {
    // Built as markup rather than through `el`, because `el` calls
    // `document.createElement` and an SVG child needs the SVG namespace. The
    // paths come from `sparklinePath`/`sparklineArea`, which are the same
    // functions Home spends.
    const holder = el('div', { class: 'dv-spark-holder' });
    holder.innerHTML =
      '<svg class="spark gm-spark" viewBox="0 0 600 56" preserveAspectRatio="none" role="img">'
      + `<path class="area" d="${sparklineArea(values, 600, 56)}"/><path class="line" d="${sparklinePath(values, 600, 56)}"/></svg>`;
    // Set rather than interpolated. The title is authored in `RENDER_SPECS`,
    // but `range` is a date out of a tool result, and nothing that came back
    // from a tool goes into markup as a string — §4.7's rule that tool results
    // are data holds in the renderer as well as in the prompt.
    holder.firstElementChild?.setAttribute('aria-label', `${part.title}, ${range}`);
    block.append(holder, el('div', { class: 'dv-spark-range num' }, [range]));
  }

  block.append(provenance(part.provenance));
  return block;
}

/**
 * A tool that returned something other than data, and what would fill it.
 *
 * The heading distinguishes the three states, because they are three different
 * answers and this part carries the whole first impression of a new account.
 * The action line is the tool's own `nextStep`, written by the handler that
 * knows what is missing — "connect Search Console", not "no data".
 */
function noticePart(part: Extract<ResponsePart, { kind: 'notice' }>, ctx: AppContext): HTMLElement {
  const box = el('div', { class: `notebox framed dv-notice ${part.state}` }, [
    el('p', { class: 'dv-notice-h' }, [noticeHeading(part.state)]),
    el('p', {}, [part.reason]),
    el('p', { class: 'dv-notice-act' }, [part.action]),
  ]);
  // The one next step the product can take for them. Every other action in a
  // `nextStep` is a sentence about calling another tool, which is written for
  // the model and is not a thing a customer does.
  if (part.state === 'not-connected') {
    box.append(el('div', { class: 'dv-notice-btn' }, [
      el('button', { class: 'btn', onclick: () => ctx.navigate('integrations') }, ['Open Integrations']),
    ]));
  }
  return box;
}

/**
 * The model's prose.
 *
 * Rendered as text, deliberately, not as markdown. The model is asked for
 * prose and emits no part markers; running it through a markdown parser would
 * add a place for `**` and `|` to become structure the grounding contract never
 * approved — a model-authored table is exactly the thing §4.5 chose option (2)
 * to prevent. Paragraph breaks are the one structure honoured, because losing
 * them makes a four-sentence answer one block.
 */
function textPart(part: Extract<ResponsePart, { kind: 'text' }>): HTMLElement {
  const paragraphs = part.markdown.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return el('div', { class: 'dv-text' }, paragraphs.map((p) => el('p', {}, [p])));
}

/** The findings the tool returned, as the rows the Findings screen renders. */
function findingsPart(part: Extract<ResponsePart, { kind: 'findings' }>, ctx: AppContext): HTMLElement {
  const groups = groupFindings(driverFindingRows(part.findings));
  return el('div', { class: 'dv-block' }, [
    el('div', { class: 'dv-title' }, ['What the audit found']),
    el('div', { class: 'dv-findings' }, groups.map((g) => findingGroupBlock(g, { open: g.pageCount === 1 }))),
    el('div', { class: 'dv-block-act' }, [
      el('button', { class: 'card-link', onclick: () => ctx.navigate('findings') }, ['Open Findings']),
    ]),
    provenance(part.provenance),
  ]);
}

/**
 * The fixes the tool returned.
 *
 * Not the Fix Queue card, and it cannot be: that card's middle is the diff —
 * what is on the page now and what would replace it — and the `fix_queue` tool
 * returns the status and what the fix answers, with no diff. A card with its
 * evidence missing would be a worse lie than a summary that says where the
 * change is. So this reports what the tool returned, in the Fix Queue's
 * vocabulary, and sends the reader there for the change itself.
 */
function fixesPart(part: Extract<ResponsePart, { kind: 'fixes' }>, ctx: AppContext): HTMLElement {
  const rows = driverFixRows(part.fixes);
  return el('div', { class: 'dv-block' }, [
    el('div', { class: 'dv-title' }, ['Fixes in the queue']),
    el('div', { class: 'dv-fixes' }, rows.map((f) =>
      el('div', { class: 'card' }, [
        el('div', { class: 'kind' }, [f.kind]),
        el('div', { class: 'ttl' }, [f.answers]),
        el('div', { class: 'card-what' }, [f.entity]),
        el('div', { class: 'foot' }, [
          el('span', { class: 'pill effort' }, [f.status]),
          el('span', { class: 'dv-fix-when num' }, [f.changed]),
        ]),
      ]),
    )),
    el('div', { class: 'dv-block-act' }, [
      el('button', { class: 'card-link', onclick: () => ctx.navigate('fixes') }, ['Open Fixes to see the change']),
    ]),
    provenance(part.provenance),
  ]);
}

/**
 * A whole answer.
 *
 * Consecutive metrics are folded into one strip before rendering, because they
 * arrive as separate parts and came from one call. Everything else renders in
 * the order the server sent, which is prose first and the evidence under it —
 * the model emits no part markers, so interleaving a table into a sentence is
 * not available at any price.
 */
export function renderParts(parts: readonly ResponsePart[], ctx: AppContext): HTMLElement {
  const out = el('div', { class: 'dv-answer' });
  let metrics: Extract<ResponsePart, { kind: 'metric' }>[] = [];

  const flush = (): void => {
    if (metrics.length > 0) out.append(metricStrip(metrics));
    metrics = [];
  };

  for (const part of parts) {
    if (part.kind === 'metric') {
      metrics.push(part);
      continue;
    }
    flush();
    switch (part.kind) {
      case 'text':
        out.append(textPart(part));
        break;
      case 'table':
        out.append(tablePart(part));
        break;
      case 'series':
        out.append(seriesPart(part));
        break;
      case 'findings':
        out.append(findingsPart(part, ctx));
        break;
      case 'fixes':
        out.append(fixesPart(part, ctx));
        break;
      case 'notice':
        out.append(noticePart(part, ctx));
        break;
    }
  }
  flush();

  // A turn that produced neither prose nor a part. The loop cannot normally
  // reach it — a turn with no text falls back — but an answer box with nothing
  // in it is worse than a sentence saying so.
  if (out.childElementCount === 0) {
    out.append(el('div', { class: 'emptybox' }, ['That turn produced no answer and read nothing.']));
  }
  return out;
}

/** The icon the composer's send button wears. Exported so the palette can reuse it. */
export const SEND_ICON = icon(ICONS.arrowUp);
