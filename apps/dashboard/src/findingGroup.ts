/**
 * One issue group, as it renders on Findings and in a Driver answer.
 *
 * Extracted from `views/audit.ts` so the two cannot drift. §4.5 is explicit
 * about why: "a finding shown in Driver should be the same row a customer
 * clicks in Findings, with the same actions on it. Two different renderings of
 * the same object is how a product starts to feel like two products." A shared
 * builder makes that true rather than asserted — a change to the row changes
 * both places, and a `.fgroup` built by hand in a second file could not.
 *
 * Actions are injected rather than built here, which is the whole reason this
 * split works. Findings passes its Propose-fix and Fix-all buttons, which need
 * an `AppContext` and a deploy target. Driver passes none: the `findings` tool
 * returns no `actionTemplates`, so nothing can honestly claim a fix exists,
 * and the write tools are step 7 anyway. The group renders identically either
 * way; only what is on it differs.
 */
import { el } from './dom.js';
import { issueExplanation, manualFixReason, pagePath } from './format.js';
import type { FindingGroup, FindingRow } from './types.js';

export interface FindingGroupOptions {
  /**
   * Controls for the whole group, placed before the show/hide toggle. Findings
   * passes "Fix all n pages"; Driver passes nothing.
   */
  actions?: HTMLElement[];
  /** Per-page control, built once per row. Findings passes "Propose fix". */
  rowAction?: (f: FindingRow) => HTMLElement | null;
  /**
   * Start with the page list open.
   *
   * Findings folds it away because the pages are the detail behind a decision,
   * not the decision. A Driver answer is already a scoped reply to a question
   * that may well have been about one page, and a fold there is one more click
   * between a question and its answer — so Driver opens a single-page group and
   * folds anything longer.
   */
  open?: boolean;
}

/** One page a group affects. */
export function findingPageRow(f: FindingRow, action?: HTMLElement | null): HTMLElement {
  return el('div', { class: 'frow' }, [
    el('div', { class: 'fmain' }, [
      el('div', { class: 't' }, [f.url ? pagePath(f.url) : 'Site-wide']),
      el('div', { class: 'm', title: f.url }, [f.url || 'Not tied to one page']),
    ]),
    el('span', { class: 'impact-n num' }, [`+${f.predictedImpact}`]),
    action ?? null,
  ]);
}

/**
 * One issue type with every page it affects.
 *
 * The issue is explained once, because "canonical-conflict" is a thing to look
 * up rather than a thing to decide about. The pages fold away, because they are
 * the detail behind the decision. A "Manual" pill with nothing after it is a
 * dead end, so the reason says what to do instead.
 */
export function findingGroupBlock(g: FindingGroup, opts: FindingGroupOptions = {}): HTMLElement {
  const pages = g.pageCount === 1 ? '1 page' : `${g.pageCount} pages`;
  const manual = manualFixReason(g.type);
  const explanation = issueExplanation(g.type);

  const list = el('div', { class: 'flist' }, g.findings.map((f) => findingPageRow(f, opts.rowAction?.(f))));
  const startOpen = opts.open ?? false;
  list.hidden = !startOpen;

  const toggle = el('button', {
    class: 'fgroup-toggle',
    type: 'button',
    'aria-expanded': String(startOpen),
  }, [startOpen ? `Hide ${pages}` : `Show ${pages}`]);
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    toggle.textContent = list.hidden ? `Show ${pages}` : `Hide ${pages}`;
  });

  const actions: HTMLElement[] = [...(opts.actions ?? []), toggle];

  return el('div', { class: 'fgroup' }, [
    el('div', { class: 'fgroup-head' }, [
      el('span', { class: `sev ${g.severity}` }, [g.severity]),
      el('div', { class: 'fmain' }, [
        el('div', { class: 't' }, [g.title]),
        el('div', { class: 'm' }, [pages]),
      ]),
      manual
        ? el('span', { class: 'pill effort', title: manual }, ['Manual'])
        : el('span', { class: 'pill impact' }, ['auto-fixable']),
    ]),
    ...(explanation ? [el('p', { class: 'fgroup-why' }, [explanation])] : []),
    ...(manual ? [el('p', { class: 'fgroup-manual' }, [manual])] : []),
    el('div', { class: 'fgroup-acts' }, actions),
    list,
  ]);
}
