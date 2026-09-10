import { el } from '../dom.js';
import { fetchAudit, fetchDeployTarget, fetchLatestAuditRequest, proposeBatch, proposeFix, requestAudit } from '../api.js';
import { askForDeployTarget } from '../deployTargetForm.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import { auditRequestStatusLine, crawlCoverageLine, groupFindings, issueExplanation, manualFixReason, pagePath } from '../format.js';
import type { ApiAuditRequest, AuditData, DeployTarget, FindingGroup, FindingRow } from '../types.js';

/**
 * The "Propose fix" control for one page. It asks the API to generate the fix
 * and drop it into the Fix Queue. Disabled until the project has a deploy
 * target (where a fix would land), since the generator needs one.
 *
 * Its class is `frow-act`, not `card-act`: `card-act` is `width: 100%` for the
 * Fix Queue cards, and inside a flex row that took the whole row and squeezed
 * the title and URL to nothing.
 */
function proposeButton(f: FindingRow, hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): HTMLElement {
  const btn = el('button', {
    class: 'frow-act',
    // Not disabled when there is no target. A disabled button with a tooltip
    // pointing at another screen is a dead end; asking for the target here is
    // the same number of clicks and ends with the fix proposed.
    onclick: async (e: Event) => {
      e.stopPropagation();
      if (!(await ensureTarget(hasTarget, ctx, onTargetSaved))) return;
      btn.setAttribute('disabled', 'true');
      btn.textContent = 'Proposing…';
      try {
        const { actions, skipped } = await proposeFix(f.id);
        if (actions.length === 0) {
          // Say what stopped it, in the words the API sent back — a thin page
          // and a brand with no kind set are different problems, and "no fix
          // could be generated" told the customer neither.
          ctx.toast(skipped[0]?.reason ?? 'No fix could be generated for this finding.');
          btn.removeAttribute('disabled');
          btn.textContent = 'Propose fix';
          return;
        }
        ctx.toast(`Proposed ${actions.length} fix${actions.length === 1 ? '' : 'es'} → Fix Queue`);
        btn.textContent = 'Proposed ✓';
      } catch (err) {
        ctx.toast(`Propose failed: ${(err as Error).message}`);
        btn.removeAttribute('disabled');
        btn.textContent = 'Propose fix';
      }
    },
  }, ['Propose fix']);
  return btn;
}

/** One page inside an issue group: the path to scan by, the full URL under it. */
function pageRow(f: FindingRow, hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): HTMLElement {
  return el('div', { class: 'frow' }, [
    el('div', { class: 'fmain' }, [
      el('div', { class: 't' }, [f.url ? pagePath(f.url) : 'Site-wide']),
      el('div', { class: 'm', title: f.url }, [f.url || 'Not tied to one page']),
    ]),
    el('span', { class: 'impact-n num' }, [`+${f.predictedImpact}`]),
    f.autoFixable ? proposeButton(f, hasTarget, ctx, onTargetSaved) : null,
  ]);
}

/**
 * One issue type with every page it affects.
 *
 * Three changes from the row-per-page list this replaces. The issue is
 * explained, once, because "canonical-conflict" is a thing to look up rather
 * than a thing to decide about. The fix is offered for the whole group, because
 * the way to fix a missing <title> across 42 pages should not be 42 clicks. And
 * the pages are folded away by default, because they are the detail behind the
 * decision, not the decision.
 */
function groupBlock(g: FindingGroup, hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): HTMLElement {
  const pages = g.pageCount === 1 ? '1 page' : `${g.pageCount} pages`;
  const manual = manualFixReason(g.type);
  const explanation = issueExplanation(g.type);

  const list = el('div', { class: 'flist' }, g.findings.map((f) => pageRow(f, hasTarget, ctx, onTargetSaved)));
  list.hidden = true;

  const toggle = el('button', {
    class: 'fgroup-toggle',
    type: 'button',
    'aria-expanded': 'false',
  }, [`Show ${pages}`]);
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    toggle.textContent = list.hidden ? `Show ${pages}` : `Hide ${pages}`;
  });

  const actions: HTMLElement[] = [toggle];
  if (g.autoFixable) actions.unshift(fixAllButton(g, hasTarget, ctx, onTargetSaved));

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
    // A "Manual" pill with nothing after it is a dead end. The reason says what
    // to do instead, which is the only useful thing left to say.
    ...(manual ? [el('p', { class: 'fgroup-manual' }, [manual])] : []),
    el('div', { class: 'fgroup-acts' }, actions),
    list,
  ]);
}

/**
 * "Fix on all N pages". Reports what it could not do as well as what it did:
 * a batch that queues 3 fixes out of 40 pages and says only "3 proposed" leaves
 * the customer to wonder about the other 37.
 */
function fixAllButton(g: FindingGroup, hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): HTMLElement {
  const label = g.pageCount === 1 ? 'Fix this page' : `Fix on all ${g.pageCount} pages`;
  const btn = el('button', { class: 'btn' }, [label]);
  btn.addEventListener('click', async () => {
    if (!(await ensureTarget(hasTarget, ctx, onTargetSaved))) return;
    btn.setAttribute('disabled', 'true');
    btn.textContent = 'Proposing…';
    try {
      const res = await proposeBatch(g.type);
      const n = res.actions.length;
      const capped =
        res.findingsAttempted < res.findingsInGroup
          ? ` · ${res.findingsInGroup - res.findingsAttempted} more left for the next run`
          : '';
      if (n === 0) {
        ctx.toast(res.skipped[0]?.reason ?? 'No fix could be generated for these pages.');
        btn.removeAttribute('disabled');
        btn.textContent = label;
        return;
      }
      const notFixed = res.skipped.length > 0 ? ` · ${res.skipped.length} skipped` : '';
      ctx.toast(`Proposed ${n} fix${n === 1 ? '' : 'es'}${notFixed}${capped} → Fix Queue`);
      btn.textContent = 'Proposed ✓';
    } catch (err) {
      ctx.toast(readableError(err));
      btn.removeAttribute('disabled');
      btn.textContent = label;
    }
  });
  return btn;
}

/**
 * Make sure there is somewhere for a fix to land, asking now if there is not.
 * Returns false when the customer closed the dialog without choosing, which is
 * a decision rather than a failure and gets no error.
 */
async function ensureTarget(hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): Promise<boolean> {
  if (hasTarget) return true;
  const target = await askForDeployTarget(ctx);
  if (!target) return false;
  onTargetSaved();
  return true;
}

/** "3 issues on 7 pages": issue types, then distinct pages, both real counts. */
function issueCount(rows: FindingRow[]): string {
  if (rows.length === 0) return 'none yet';
  const types = new Set(rows.map((f) => f.type)).size;
  // Site-wide findings carry no URL and are not a page.
  const pages = new Set(rows.map((f) => f.url).filter(Boolean)).size;
  return `${types} issue${types === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'}`;
}

/**
 * The header line. Every part is conditional because every part can legitimately
 * be absent: a project that has never been crawled has no health score, and
 * saying "Health score 100" — or 72, as the sample data did — describes a site
 * nobody has looked at.
 */
function summary(d: AuditData): HTMLElement {
  if (d.healthScore === null) {
    return el('p', {}, ['No audit has run for this project yet.']);
  }
  const pages = d.pagesAudited === 1 ? '1 page' : `${d.pagesAudited} pages`;
  const line = el('p', {
    html:
      `Health score <b>${d.healthScore}</b> across ${pages} · ` +
      `<b>${d.autoFixableCount}</b> of <b>${d.findings.length}</b> findings map to a one-click fix.`,
  });

  // What the crawl could reach, beneath what it found. A thin finding list
  // reads as "nearly clean" unless the screen says how little was looked at.
  const cov = crawlCoverageLine(d.pagesAudited, d.coverage);
  if (!cov) return line;
  return el('div', {}, [
    line,
    el('p', { class: 'coverage' }, [cov.text]),
    ...(cov.warning ? [el('p', { class: 'coverage warn' }, [cov.warning])] : []),
  ]);
}

/** How often the header re-checks a queued or running request. */
const POLL_MS = 20_000;

export async function auditView(ctx: AppContext): Promise<HTMLElement> {
  const container = el('div', {});
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  async function load(): Promise<void> {
    let data: AuditData | null = null;
    let loadError: string | null = null;
    let target: DeployTarget | null = null;
    let latest: ApiAuditRequest | null = null;
    try {
      // The target and the request are best-effort: a failure on either only
      // disables the Propose buttons or hides the status line, it does not
      // block showing the audit.
      [data, target, latest] = await Promise.all([
        fetchAudit(),
        fetchDeployTarget().catch(() => null),
        fetchLatestAuditRequest().catch(() => null),
      ]);
    } catch (err) {
      // Same rule as the Fix Queue: an unreachable API is not an empty audit, and
      // this view will not invent findings to paper over the difference.
      loadError = (err as Error).message;
    }
    render(data, loadError, target, latest);
  }

  function schedulePoll(latest: ApiAuditRequest | null): void {
    if (pollTimer) clearTimeout(pollTimer);
    const line = auditRequestStatusLine(latest);
    if (!line?.live) return;
    pollTimer = setTimeout(() => {
      // The view may have been replaced by another route since the timer was set.
      if (container.isConnected) void load();
    }, POLL_MS);
  }

  function runButton(latest: ApiAuditRequest | null): HTMLElement {
    const busy = latest?.status === 'queued' || latest?.status === 'running';
    const btn = el('button', {
      class: 'btn primary',
      ...(busy ? { disabled: 'true', title: 'An audit is already queued or running' } : {}),
      onclick: async () => {
        btn.setAttribute('disabled', 'true');
        btn.textContent = 'Queuing…';
        try {
          const { dispatched } = await requestAudit();
          ctx.toast(dispatched ? 'Audit queued. It usually finishes within a few minutes.' : 'Audit queued for the next scheduled pass.');
          await load();
        } catch (err) {
          ctx.toast(readableError(err));
          btn.removeAttribute('disabled');
          btn.textContent = 'Run audit';
        }
      },
    }, ['Run audit']);
    return btn;
  }

  function render(data: AuditData | null, loadError: string | null, target: DeployTarget | null, latest: ApiAuditRequest | null): void {
    schedulePoll(latest);
    const status = auditRequestStatusLine(latest);
    const statusLine = status
      ? el('p', { class: `audit-status${status.tone ? ` ${status.tone}` : ''}`, role: 'status' }, [status.text])
      : null;

    if (!data) {
      container.replaceChildren(
        el('div', { class: 'pagehead' }, [el('h1', {}, ['Findings'])]),
        el('section', { class: 'panel' }, [
          el('div', { class: 'fq-note' }, [`Could not load the audit: ${loadError}`]),
        ]),
      );
      return;
    }

    const d = data;
    const hasTarget = target !== null;
    const parts: (HTMLElement | null)[] = [
      el('div', { class: 'pagehead' }, [
        el('h1', {}, ['Findings']),
        summary(d),
        statusLine,
        runButton(latest),
      ]),
      // The standing "set a deploy target in Settings" banner is gone. It was
      // shown on every visit, mostly to someone with no fix to deploy yet, and
      // on the one visit it mattered it sent them away from what they were
      // doing. The question is asked when a fix is actually proposed.
      el('section', { class: 'panel' }, [
        el('header', {}, [
          el('h3', {}, ['Findings']),
          el('span', { class: 'more' }, [issueCount(d.findings)]),
        ]),
        d.findings.length === 0
          ? el('div', { class: 'fq-note' }, [
              d.healthScore === null
                ? 'Run an audit to see what to fix. Findings appear here when it finishes.'
                : 'No findings. The last audit found nothing to fix.',
            ])
          : el('div', { class: 'fgroups' }, groupFindings(d.findings).map((g) => groupBlock(g, hasTarget, ctx, () => void load()))),
      ]),
    ];
    container.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
  }

  await load();
  return container;
}
