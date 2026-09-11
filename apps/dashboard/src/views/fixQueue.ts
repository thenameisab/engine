import { el } from '../dom.js';
import { LANE_ORDER, statusLabel, nextAction, diffLines, NOTHING_THERE, verifyLine, type VerifyStatus, screenName } from '../format.js';
import { fetchActions, transitionAction, reviewAction, fetchVerifyStatus, requestVerify } from '../api.js';
import { readableError } from '../errors.js';
import { openDialog } from '../dialog.js';
import type { AppContext } from '../context.js';
import type { ActionCard, ActionStatus } from '../types.js';

/** A card shows this much of each side; the full text is one click away. */
const PREVIEW_CHARS = 180;

function clip(text: string, max = PREVIEW_CHARS): string {
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The before/after every card carries: what is on the page now, and what this
 * fix would put there. Cards used to show a type, a derived sentence and an
 * impact chip, so a customer approved a change they had never seen — the fix
 * for a missing title could be the brand name repeated on every page and
 * nothing on screen would say so.
 */
function preview(a: ActionCard): HTMLElement {
  const before = a.diff.before.trim();
  return el('div', { class: 'card-diff' }, [
    el('div', { class: 'cd-row' }, [
      el('span', { class: 'cd-tag now' }, ['Now']),
      el('span', { class: `cd-text${before ? '' : ' empty'}` }, [before ? clip(before) : NOTHING_THERE]),
    ]),
    el('div', { class: 'cd-row' }, [
      el('span', { class: 'cd-tag next' }, ['After']),
      el('span', { class: 'cd-text' }, [clip(a.diff.after)]),
    ]),
  ]);
}

/** The full change, line by line, in a dialog. */
function fullDiff(a: ActionCard): HTMLElement {
  const lines = diffLines(a.diff.before, a.diff.after);
  return el('div', { class: 'diffview' }, [
    el('p', { class: 'diff-what' }, [a.changes]),
    el('div', { class: 'difflines' }, lines.map((line) =>
      el('div', { class: `dl ${line.kind}` }, [
        el('span', { class: 'dl-mark' }, [line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' ']),
        el('span', { class: 'dl-text' }, [line.text || ' ']),
      ]),
    )),
  ]);
}

function openFullDiff(a: ActionCard): void {
  openDialog({ title: a.title, content: fullDiff(a) });
}

/**
 * The review step for a content rewrite. The customer reads the proposed words
 * next to the current ones and can edit them before confirming; only then can
 * the fix be approved. The API enforces the same rule, so a card that skipped
 * this step cannot be approved by any other route either.
 */
function openReview(a: ActionCard, ctx: AppContext, onReviewed: (id: string, after: string) => void): void {
  const editor = el('textarea', { class: 'field review-editor', rows: '12' }) as HTMLTextAreaElement;
  editor.value = a.diff.after;

  const confirm = el('button', { class: 'btn primary' }, ['Use these words']);
  const body = el('div', { class: 'reviewview' }, [
    el('p', { class: 'diff-what' }, [
      'Engine drafted this from the words already on your page. Read it, change anything you want, then confirm. Nothing goes to your site until you approve it.',
    ]),
    el('div', { class: 'review-side' }, [
      el('div', { class: 'rs-label' }, ['On the page now']),
      el('div', { class: 'rs-text' }, [a.diff.before.trim() || NOTHING_THERE]),
    ]),
    el('div', { class: 'review-side' }, [
      el('div', { class: 'rs-label' }, ['Proposed']),
      editor,
    ]),
    el('div', { class: 'form-actions' }, [confirm]),
  ]);

  const handle = openDialog({ title: 'Read the proposed wording', content: body });
  confirm.addEventListener('click', async () => {
    const after = editor.value.trim();
    if (!after) {
      ctx.toast('The proposed wording cannot be empty.');
      return;
    }
    confirm.setAttribute('disabled', 'true');
    confirm.textContent = 'Saving…';
    try {
      await reviewAction(a.id, after);
    } catch (err) {
      ctx.toast(`Could not save your review: ${readableError(err)}`);
      confirm.removeAttribute('disabled');
      confirm.textContent = 'Use these words';
      return;
    }
    handle.close();
    ctx.toast('Wording confirmed. You can approve this fix now.');
    onReviewed(a.id, after);
  });
}

function card(
  a: ActionCard,
  ctx: AppContext,
  onMoved: (id: string, to: ActionStatus) => void,
  onReviewed: (id: string, after: string) => void,
): HTMLElement {
  const next = nextAction(a.status);
  const unreviewed = a.needsReview && !a.reviewedAt;

  const foot = el('div', { class: 'foot' }, [
    a.impact !== undefined ? el('span', { class: 'pill impact' }, [`+${a.impact} impact`]) : null,
    a.effort ? el('span', { class: 'pill effort' }, [a.effort]) : null,
    a.needsReview ? el('span', { class: `pill ${a.reviewedAt ? 'reviewed' : 'needs-review'}` }, [a.reviewedAt ? 'you approved this wording' : 'needs your reading']) : null,
  ]);

  const node = el('div', { class: `card${a.status === 'verified' ? ' verified' : ''}` }, [
    el('div', { class: 'kind' }, [a.status === 'verified' ? `✓ ${a.kind}` : a.kind]),
    el('div', { class: 'ttl' }, [a.title]),
    el('div', { class: 'card-what' }, [a.changes]),
    preview(a),
    el('button', { class: 'card-link', onclick: (e: Event) => { e.stopPropagation(); openFullDiff(a); } }, ['See the whole change']),
    foot,
  ]);

  // A rewrite of the page's own words is never one click from the site. The
  // card offers reading it; approval only appears once that is done.
  if (unreviewed) {
    node.append(el('button', {
      class: 'card-act',
      onclick: (e: Event) => {
        e.stopPropagation();
        openReview(a, ctx, onReviewed);
      },
    }, ['Read the proposed wording']));
    return node;
  }

  // The Deployed lane reports the machine check instead of offering a button a
  // browser could never satisfy.
  if (a.status === 'deployed' || a.status === 'verified') {
    node.append(verifyBlock(a, ctx));
    return node;
  }

  if (next) {
    const btn = el('button', {
      class: 'card-act',
      onclick: async (e: Event) => {
        e.stopPropagation();
        btn.setAttribute('disabled', 'true');
        btn.textContent = `${next.label}…`;
        try {
          await transitionAction(a.id, next.to as Exclude<ActionStatus, 'proposed'>);
        } catch (err) {
          // The transition is the product. If Postgres rejected it, the card has
          // not moved — showing it in the next lane anyway would be a lie the
          // user only discovers on reload.
          ctx.toast(`${a.kind} → ${statusLabel(next.to)} failed: ${readableError(err)}`);
          btn.removeAttribute('disabled');
          btn.textContent = next.label;
          return;
        }
        ctx.toast(`${a.kind} → ${statusLabel(next.to)}`);
        onMoved(a.id, next.to);
      },
    }, [next.label]);
    node.append(btn);
  }
  return node;
}

/**
 * What the last check found, and a way to ask for another.
 *
 * Loads its own status per card rather than being threaded through the board:
 * a card that cannot reach the API shows "Not checked yet" and an enabled
 * button, which is the truth and is still actionable.
 */
function verifyBlock(a: ActionCard, ctx: AppContext): HTMLElement {
  const line = el('div', { class: 'verify-line' }, ['Checking…']);
  const btn = el('button', { class: 'card-act' }, ['Check now']);
  const wrap = el('div', { class: 'verify' }, [line, btn]);

  function paint(v: VerifyStatus | null): void {
    const out = verifyLine(v, { targetKind: a.targetKind });
    line.className = `verify-line${out.tone ? ` ${out.tone}` : ''}`;
    line.textContent = out.text;
    btn.hidden = !out.canCheck;
  }

  btn.addEventListener('click', async (e: Event) => {
    e.stopPropagation();
    btn.setAttribute('disabled', 'true');
    try {
      await requestVerify(a.id);
      paint({ status: 'queued', verified: null, error: null, finishedAt: null });
      ctx.toast('Queued. The runner checks the live page on its next pass.');
    } catch (err) {
      ctx.toast(readableError(err));
    } finally {
      btn.removeAttribute('disabled');
    }
  });

  void fetchVerifyStatus(a.id)
    .then((v) => paint(v))
    .catch(() => paint(null));

  return wrap;
}

export async function fixQueueView(ctx: AppContext): Promise<HTMLElement> {
  let actions: ActionCard[] = [];
  let loadError: string | null = null;
  try {
    actions = await fetchActions();
  } catch (err) {
    loadError = readableError(err);
  }

  const container = el('section', { class: 'panel fq' });

  const rerender = () => {
    container.replaceChildren();
    container.append(
      el('div', { class: 'fq-head' }, [
        el('span', { class: 'dot' }),
        el('h3', {}, ['Fix Queue']),
        el('span', { class: 'fq-sub' }, ['Every fix shows what changes before you approve it.']),
      ]),
      ...(loadError
        ? [el('div', { class: 'errbox' }, [`Could not load the queue: ${loadError}`])]
        : actions.length === 0
          ? [el('div', { class: 'emptybox' }, ['No actions yet. Run an audit to turn findings into proposed fixes.'])]
          : [el('div', { class: 'lanes' }, LANE_ORDER.map((status) => lane(status, actions, ctx, onMoved, onReviewed)))]),
    );
  };

  function onMoved(id: string, to: ActionStatus): void {
    actions = actions.map((a) => (a.id === id ? { ...a, status: to } : a));
    rerender();
  }

  function onReviewed(id: string, after: string): void {
    actions = actions.map((a) =>
      a.id === id ? { ...a, diff: { ...a.diff, after }, reviewedAt: new Date().toISOString() } : a,
    );
    rerender();
  }

  rerender();

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('fixes')]),
      el('p', {}, ['Every card is a proposed fix for your site. Read what it changes, approve it to deploy, then verify that it landed.']),
    ]),
    container,
  ]);
}

function lane(
  status: ActionStatus,
  actions: ActionCard[],
  ctx: AppContext,
  onMoved: (id: string, to: ActionStatus) => void,
  onReviewed: (id: string, after: string) => void,
): HTMLElement {
  const inLane = actions.filter((a) => a.status === status);
  return el('div', { class: 'lane' }, [
    el('div', { class: 'lane-h' }, [
      el('span', { class: 'label' }, [statusLabel(status)]),
      el('span', { class: 'n' }, [String(inLane.length)]),
    ]),
    ...(inLane.length > 0
      ? inLane.map((a) => card(a, ctx, onMoved, onReviewed))
      : [el('div', { class: 'emptybox' }, ['—'])]),
  ]);
}
