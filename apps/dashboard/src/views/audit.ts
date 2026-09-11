import { el } from '../dom.js';
import { findingGroupBlock } from '../findingGroup.js';
import { fetchAudit, fetchDeployTarget, fetchEntityStrengths, fetchLatestAuditRequest, proposeBatch, proposeFix } from '../api.js';
import { askForDeployTarget } from '../deployTargetForm.js';
import { readableError } from '../errors.js';
import { runAuditButton } from '../runAuditButton.js';
import type { AppContext } from '../context.js';
import { BRAND_STRENGTH_EXPLANATION, auditRequestStatusLine, brandStrengthSummary, crawlCoverageLine, groupFindings, healthBand, scorePct, screenName, severityCounts } from '../format.js';
import type { BrandStrengthSummary } from '../format.js';
import type { ApiAuditRequest, AuditData, DeployTarget, EntityStrength, FindingGroup, FindingRow } from '../types.js';

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
/**
 * One issue type with every page it affects, with this screen's fix controls
 * on it.
 *
 * The group's markup moved to `findingGroup.ts` when Driver started rendering
 * findings too — §4.5's rule is that a finding shown in Driver is the same row
 * a customer clicks here, and a second hand-built `.fgroup` could not keep
 * that true. What stays here is what is specific to this screen: the fix.
 */
function groupBlock(g: FindingGroup, hasTarget: boolean, ctx: AppContext, onTargetSaved: () => void): HTMLElement {
  return findingGroupBlock(g, {
    ...(g.autoFixable ? { actions: [fixAllButton(g, hasTarget, ctx, onTargetSaved)] } : {}),
    rowAction: (f) => (f.autoFixable ? proposeButton(f, hasTarget, ctx, onTargetSaved) : null),
  });
}

/**
 * Brand strength as a Findings group.
 *
 * The entity audit runs after every crawl, and its result was visible only to
 * someone who found the Brand tab. It belongs on this screen because it is
 * something the audit found about the site — but it is a standing measure
 * rather than an issue, so it carries its score in the slot where an issue
 * group carries a severity chip. That keeps the component rows indented like
 * every other group's pages, and it takes no word from the severity
 * vocabulary: a measure that is not high, medium or low must not claim a place
 * in an ordering by severity, so it leads the list once and the issues follow.
 *
 * The per-entity breakdown stays on Visibility › Brand. Four averaged signals
 * answer "which one do I go and fix"; which entity is weakest is a second
 * question, and the tab that answers it already exists.
 */
function brandGroup(b: BrandStrengthSummary): HTMLElement {
  const entities = b.entityCount === 1 ? '1 entity' : `${b.entityCount} entities`;
  const signals = `${b.components.length} signals`;

  const list = el('div', { class: 'flist' }, b.components.map((c) =>
    el('div', { class: 'frow' }, [
      el('div', { class: 'fmain' }, [
        el('div', { class: 't' }, [c.label]),
        el('div', { class: 'm' }, [c.hint]),
      ]),
      el('span', { class: `fcomp-v num ${c.band}` }, [scorePct(c.value)]),
    ]),
  ));
  list.hidden = true;

  const toggle = el('button', {
    class: 'fgroup-toggle',
    type: 'button',
    'aria-expanded': 'false',
  }, [`Show ${signals}`]);
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
    toggle.textContent = list.hidden ? `Show ${signals}` : `Hide ${signals}`;
  });

  return el('div', { class: 'fgroup' }, [
    el('div', { class: 'fgroup-head' }, [
      el('span', { class: `fscore num ${b.band}` }, [scorePct(b.score)]),
      el('div', { class: 'fmain' }, [
        el('div', { class: 't' }, ['Brand strength']),
        el('div', { class: 'm' }, [`${entities} scored · weakest ${b.weakest}`]),
      ]),
    ]),
    el('p', { class: 'fgroup-why' }, [BRAND_STRENGTH_EXPLANATION]),
    el('div', { class: 'fgroup-acts' }, [
      toggle,
      el('a', { class: 'more', href: '#/visibility/brand' }, ['Per-entity detail →']),
    ]),
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
 * The overview strip: health, the severity split, pages, and how many findings
 * a fix can be generated for.
 *
 * It replaced a sentence. The sentence carried the same four numbers, but a
 * reader had to parse prose to answer the one question this screen exists for
 * — how bad is it, and where do I start — and it left out the severity split
 * entirely, so the counts existed only on Home. `severityCounts` is the same
 * function Home's health block calls, so the two screens cannot disagree.
 *
 * Every part is conditional because every part can legitimately be absent: a
 * project that has never been crawled has no health score, and saying "Health
 * score 100" — or 72, as the sample data did — describes a site nobody has
 * looked at.
 */
function overviewStrip(d: AuditData): HTMLElement {
  if (d.healthScore === null) {
    return el('p', {}, ['No audit has run for this project yet.']);
  }
  const counts = severityCounts(d.findings);
  const band = healthBand(d.healthScore);

  // A count of zero stays on the strip. Dropping it would make the strip
  // change shape between visits, and "0 high" is the answer a customer most
  // wants to read.
  const severity = (key: 'high' | 'medium' | 'low') =>
    el('div', { class: 'fstrip-sev' }, [
      el('span', { class: `sev ${key}` }, [key]),
      el('span', { class: 'num' }, [String(counts[key])]),
    ]);

  const stat = (value: string, label: string) =>
    el('div', { class: 'fstrip-stat' }, [
      el('span', { class: 'fstrip-v num' }, [value]),
      el('span', { class: 'fstrip-k' }, [label]),
    ]);

  const strip = el('div', { class: 'fstrip' }, [
    el('div', { class: 'fstrip-score' }, [
      el('span', { class: `fstrip-score-v num ${band ?? ''}` }, [String(d.healthScore)]),
      el('span', { class: 'fstrip-k' }, ['Site health']),
    ]),
    el('div', { class: 'fstrip-sevs' }, [severity('high'), severity('medium'), severity('low')]),
    stat(String(d.pagesAudited), d.pagesAudited === 1 ? 'page audited' : 'pages audited'),
    stat(`${d.autoFixableCount}/${d.findings.length}`, 'one-click fixable'),
  ]);

  // What the crawl could reach, beneath what it found. A thin finding list
  // reads as "nearly clean" unless the screen says how little was looked at.
  const cov = crawlCoverageLine(d.pagesAudited, d.coverage);
  if (!cov) return strip;
  return el('div', {}, [
    strip,
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
    let strengths: EntityStrength[] = [];
    try {
      // The target, the request and the entity strengths are best-effort: a
      // failure on one only disables the Propose buttons, hides the status
      // line or drops the brand group, it does not block showing the audit.
      let entity: { strengths: EntityStrength[] } | null = null;
      [data, target, latest, entity] = await Promise.all([
        fetchAudit(),
        fetchDeployTarget().catch(() => null),
        fetchLatestAuditRequest().catch(() => null),
        fetchEntityStrengths().catch(() => null),
      ]);
      strengths = entity?.strengths ?? [];
    } catch (err) {
      // Same rule as the Fix Queue: an unreachable API is not an empty audit, and
      // this view will not invent findings to paper over the difference.
      loadError = readableError(err);
    }
    render(data, loadError, target, latest, brandStrengthSummary(strengths));
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

  const runButton = (latest: ApiAuditRequest | null): HTMLElement => runAuditButton(ctx, latest, load);

  function render(
    data: AuditData | null,
    loadError: string | null,
    target: DeployTarget | null,
    latest: ApiAuditRequest | null,
    brand: BrandStrengthSummary | null,
  ): void {
    schedulePoll(latest);
    const status = auditRequestStatusLine(latest);
    const statusLine = status
      ? el('p', { class: `audit-status${status.tone ? ` ${status.tone}` : ''}`, role: 'status' }, [status.text])
      : null;

    if (!data) {
      container.replaceChildren(
        el('div', { class: 'pagehead' }, [el('h1', {}, [screenName('findings')])]),
        el('section', { class: 'panel' }, [
          el('div', { class: 'errbox' }, [`Could not load the audit: ${loadError}`]),
        ]),
      );
      return;
    }

    const d = data;
    const hasTarget = target !== null;
    const parts: (HTMLElement | null)[] = [
      el('div', { class: 'pagehead' }, [
        el('h1', {}, [screenName('findings')]),
        overviewStrip(d),
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
        // Brand strength leads, and an empty issue list still says so beneath
        // it. A screen that dropped the whole list when there were no issues
        // would hide the one thing the crawl always produces.
        el('div', { class: 'fgroups' }, [
          ...(brand ? [brandGroup(brand)] : []),
          ...(d.findings.length === 0
            ? [el('div', { class: 'emptybox' }, [
                d.healthScore === null
                  ? 'Run an audit to see what to fix. Findings appear here when it finishes.'
                  : 'No findings. The last audit found nothing to fix.',
              ])]
            : groupFindings(d.findings).map((g) => groupBlock(g, hasTarget, ctx, () => void load()))),
        ]),
      ]),
    ];
    container.replaceChildren(...parts.filter((n): n is HTMLElement => n !== null));
  }

  await load();
  return container;
}
