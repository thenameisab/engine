/**
 * Ask — the Driver screen (scoping §4.9, build step 5b).
 *
 * The threads a person can open, the conversation, and who else can read it.
 * Everything on it was already served by the routes step 4 shipped; until this
 * file existed, `grep -rni driver apps/dashboard/src` returned nothing at all.
 *
 * Three things are decided here rather than inherited, and each is a decision
 * the ledger had open.
 *
 * **A deadline is visible.** A turn that runs out of the loop's 45-second
 * budget before the model writes anything falls back to the deterministic
 * Copilot, whose answer is narrower. The server keeps whatever figures the loop
 * had gathered and says why it fell back; this screen says so above the answer
 * and offers to keep going. Silence there is the thing the ledger has flagged
 * since #133: a thinner answer and no sign that a fuller one was nearly ready.
 *
 * **Sharing is `visibility` plus a list, and the screen keeps them honest.**
 * `visibility` is the authority and the share table is the recipient list, so a
 * private thread with share rows on it grants nothing. Correct in the API and
 * wrong as a UI, because a person who presses Share and watches a name appear
 * has every reason to believe they shared it — so adding the first name to a
 * private thread promotes it to `named`, and the screen says that is what it
 * did.
 *
 * **Non-streaming, on purpose.** The probe measured SSE parsing as the entire
 * CPU cost of a turn — 5.96 ms against 0.018 ms for the same turn as a JSON
 * body, on an account with a 10 ms budget — so whether Driver streams waits on
 * a measurement against a real Worker. Until then the composer shows what it is
 * doing and the answer arrives whole.
 */
import { el, clear } from './../dom.js';
import { icon, ICONS } from './../icons.js';
import {
  askDriver,
  fetchAccountMembers,
  fetchAiModels,
  fetchDriverThread,
  fetchDriverThreads,
  patchDriverThread,
  shareDriverThread,
  unshareDriverThread,
} from './../api.js';
import { getUser } from './../auth/session.js';
import { readableError } from './../errors.js';
import { renderParts } from './../driverParts.js';
import { modelByline, modelPicker } from './../modelPicker.js';
import {
  VISIBILITY_LABELS,
  memberLabel,
  partialAnswerNote,
  relativeTime,
  screenName,
  shareLabel,
  threadTitle,
  visibilityAfterShare,
} from './../format.js';
import type { AppContext } from './../context.js';
import type {
  AccountMember,
  AiModels,
  DriverAnswer,
  DriverMessage,
  DriverThread,
  ThreadShare,
  ThreadVisibility,
} from './../types.js';

/**
 * A question typed somewhere else, waiting for this screen to open.
 *
 * Home's ask bar and the command palette both send a question here. It travels
 * in a module variable rather than in the hash, because the hash is browser
 * history and a customer's question about their own revenue does not belong in
 * it. Read once and cleared, so a later visit to `#/driver` does not re-ask
 * yesterday's question.
 */
let pendingQuestion: string | null = null;

export function askInDriver(ctx: AppContext, question: string): void {
  pendingQuestion = question.trim() || null;
  ctx.navigate('driver');
}

function takePending(): string | null {
  const q = pendingQuestion;
  pendingQuestion = null;
  return q;
}

/** The thread the hash names — `#/driver/<uuid>` — or null for a new one. */
function threadIdFromHash(hash = location.hash): string | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  return parts[0] === 'driver' && parts[1] ? parts[1] : null;
}

const VISIBILITIES: ThreadVisibility[] = ['private', 'named', 'organisation'];

/* ── The thread list ──────────────────────────────────────────────────────── */

function threadRow(t: DriverThread, current: string | null): HTMLElement {
  return el('a', {
    class: `dv-thread${t.id === current ? ' on' : ''}`,
    href: `#/driver/${t.id}`,
  }, [
    el('span', { class: 'dv-thread-t' }, [threadTitle(t)]),
    el('span', { class: 'dv-thread-m num' }, [
      `${relativeTime(t.lastMessageAt)}${t.visibility === 'private' ? '' : ` · ${VISIBILITY_LABELS[t.visibility].toLowerCase()}`}`,
    ]),
  ]);
}

/* ── Sharing ──────────────────────────────────────────────────────────────── */

/**
 * Who can read this thread, and who it has been given to.
 *
 * Author only. A reader seeing the recipient list learns who else is in the
 * room, which is the author's to disclose — the route already withholds
 * `shares` from anyone else, so this panel would have nothing to show them.
 */
function sharingPanel(
  thread: DriverThread,
  shares: ThreadShare[],
  ctx: AppContext,
  onChanged: (t: DriverThread) => void,
): HTMLElement {
  const body = el('div', { class: 'form' });
  const panel = el('section', { class: 'panel dv-share' }, [
    el('header', {}, [el('h3', {}, ['Who can read this'])]),
    body,
  ]);

  let current = thread;
  let list = shares;

  const visibility = el('select', { class: 'field', 'aria-label': 'Who can read this thread' },
    VISIBILITIES.map((v) => el('option', { value: v }, [VISIBILITY_LABELS[v]]))) as HTMLSelectElement;

  const people = el('div', { class: 'dv-share-people' });
  const memberSelect = el('select', { class: 'field grow', 'aria-label': 'Someone on this account' }) as HTMLSelectElement;
  const shareBtn = el('button', { class: 'btn' }, ['Share']);
  const status = el('div', { class: 'fhint' });

  /** The recipient rows, and the "nobody yet" line that replaces them. */
  function paintPeople(): void {
    clear(people);
    if (list.length === 0) {
      people.append(el('div', { class: 'fhint' }, ['Not shared with anyone yet.']));
      return;
    }
    for (const s of list) {
      const remove = el('button', { class: 'card-link' }, ['Remove']);
      remove.addEventListener('click', () => {
        remove.setAttribute('disabled', 'true');
        void unshareDriverThread(current.id, s.userId)
          .then((next) => {
            list = next;
            paintPeople();
            ctx.toast(`${shareLabel(s)} can no longer read this.`);
          })
          .catch((err: unknown) => {
            remove.removeAttribute('disabled');
            ctx.toast(readableError(err));
          });
      });
      people.append(el('div', { class: 'dv-share-row' }, [
        el('span', { class: 'dv-share-who' }, [shareLabel(s)]),
        remove,
      ]));
    }
  }

  /**
   * The line under the control, which says what the current setting actually
   * does. "People you choose" with an empty list grants nothing, and a customer
   * who set it and stopped would never find that out on their own.
   */
  function paintState(): void {
    visibility.value = current.visibility;
    const named = current.visibility === 'named';
    people.hidden = current.visibility === 'organisation';
    memberSelect.hidden = current.visibility === 'organisation';
    shareBtn.hidden = current.visibility === 'organisation';
    status.textContent = current.visibility === 'organisation'
      ? 'Everyone on this account can open this conversation.'
      : named && list.length === 0
        ? 'Set to "people you choose", and nobody is chosen yet — so nobody else can read it.'
        : named
          ? `Shared with ${list.length} ${list.length === 1 ? 'person' : 'people'}.`
          : 'Only you can read this. Adding someone below opens it to them.';
  }

  visibility.addEventListener('change', () => {
    const next = visibility.value as ThreadVisibility;
    void patchDriverThread(current.id, { visibility: next })
      .then((t) => {
        current = t;
        onChanged(t);
        paintState();
        ctx.toast(`Now readable by: ${VISIBILITY_LABELS[t.visibility].toLowerCase()}.`);
      })
      .catch((err: unknown) => {
        paintState();
        ctx.toast(readableError(err));
      });
  });

  shareBtn.addEventListener('click', () => {
    const userId = memberSelect.value;
    if (!userId) return;
    shareBtn.setAttribute('disabled', 'true');
    // Sharing does not change `visibility` on the server, deliberately — the
    // author sets the recipients and then opens the door, in either order. On
    // screen that reads as a share that did nothing, so the first name added to
    // a private thread opens it too, and the toast says both things happened.
    const promote = visibilityAfterShare(current.visibility);
    void shareDriverThread(current.id, userId)
      .then(async (next) => {
        list = next;
        if (promote) {
          current = await patchDriverThread(current.id, { visibility: promote });
          onChanged(current);
        }
        paintPeople();
        paintState();
        ctx.toast(promote
          ? 'Shared, and the conversation is now open to the people you choose.'
          : 'Shared.');
      })
      .catch((err: unknown) => ctx.toast(readableError(err)))
      .finally(() => shareBtn.removeAttribute('disabled'));
  });

  body.append(
    el('label', { class: 'flabel' }, ['Who can read this']),
    visibility,
    status,
    people,
    el('label', { class: 'flabel' }, ['Share with someone on this account']),
    el('div', { class: 'serp-form-row dv-share-add' }, [memberSelect, shareBtn]),
  );

  paintPeople();
  paintState();

  // The member list is the only thing here that needs the network, and the
  // panel is useful without it — a thread can still be made account-wide or
  // private while the list is loading or unavailable.
  void fetchAccountMembers()
    .then((members: AccountMember[]) => {
      // By email, because the browser's session carries a name, an address and
      // a provider — and no user id. Adding one is a change to the session
      // shape every sign-in path writes; matching on the address the account
      // was invited by is enough to keep a person out of their own share list.
      const me = getUser()?.email?.toLowerCase();
      const others = members.filter((m) => (m.email ?? '').toLowerCase() !== me);
      if (others.length === 0) {
        memberSelect.hidden = true;
        shareBtn.hidden = true;
        memberSelect.after(el('div', { class: 'fhint' }, ['Nobody else is on this account yet.']));
        return;
      }
      memberSelect.append(...others.map((m) => el('option', { value: m.userId }, [memberLabel(m)])));
    })
    .catch(() => {
      memberSelect.hidden = true;
      shareBtn.hidden = true;
    });

  return panel;
}

/* ── The transcript ───────────────────────────────────────────────────────── */

function questionBlock(text: string): HTMLElement {
  return el('div', { class: 'dv-turn dv-turn-q' }, [
    el('div', { class: 'dv-q' }, [text]),
  ]);
}

/**
 * One answer: the note about how it was produced, then the parts.
 *
 * `onContinue` is present only for a live answer. A stored turn read back has
 * no `source` on it — the transcript stores what was said, not which engine
 * said it — so a thread opened tomorrow renders its answers without the
 * deadline note. That is a real gap and it is recorded in the ledger rather
 * than papered over here: adding it means storing `source` on the message row,
 * which is a migration.
 */
function answerBlock(
  parts: DriverAnswer['parts'],
  ctx: AppContext,
  note?: { text: string; canContinue: boolean },
  onContinue?: () => void,
): HTMLElement {
  const block = el('div', { class: 'dv-turn dv-turn-a' });
  if (note) {
    const box = el('div', { class: 'notebox framed dv-partial' }, [el('p', {}, [note.text])]);
    if (note.canContinue && onContinue) {
      const btn = el('button', { class: 'btn' }, ['Keep going']);
      btn.addEventListener('click', () => {
        btn.setAttribute('disabled', 'true');
        onContinue();
      });
      box.append(el('div', { class: 'dv-partial-act' }, [btn]));
    }
    block.append(box);
  }
  block.append(renderParts(parts, ctx));
  return block;
}

/**
 * A stored thread, as turns.
 *
 * The server's walk already attached each answer's parts to the assistant
 * message that read them out, so this is a filter rather than a state machine:
 * the `tool` rows and the pure tool-call turns carry nothing a reader needs,
 * and the audit trail behind them is reachable through the route rather than
 * rendered into the conversation.
 */
function transcript(messages: readonly DriverMessage[], ctx: AppContext): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const m of messages) {
    if (m.role === 'user' && m.content) out.push(questionBlock(m.content));
    else if (m.role === 'assistant' && m.parts && m.parts.length > 0) out.push(answerBlock(m.parts, ctx));
  }
  return out;
}

/* ── The screen ───────────────────────────────────────────────────────────── */

export async function driverView(ctx: AppContext): Promise<HTMLElement> {
  const openThreadId = threadIdFromHash();
  const [threads, models] = await Promise.all([
    fetchDriverThreads().catch(() => [] as DriverThread[]),
    fetchAiModels().catch(() => null as AiModels | null),
  ]);

  /** The thread being read or written to. Null until the first answer names one. */
  let threadId = openThreadId;
  let thread: DriverThread | null = threads.find((t) => t.id === threadId) ?? null;

  const conversation = el('div', { class: 'dv-conversation' });
  const sharing = el('div', { class: 'dv-sharing' });
  const list = el('nav', { class: 'dv-threads', 'aria-label': 'Your conversations' });

  function paintList(): void {
    clear(list);
    list.append(el('a', { class: `dv-thread dv-thread-new${threadId ? '' : ' on'}`, href: '#/driver' }, [
      el('span', { class: 'dv-thread-t' }, ['New conversation']),
    ]));
    if (threads.length === 0) {
      list.append(el('div', { class: 'fhint dv-threads-empty' }, ['Nothing asked yet.']));
      return;
    }
    for (const t of threads) list.append(threadRow(t, threadId));
  }

  /**
   * Whether this person wrote the open thread.
   *
   * Not `thread.createdBy === me`, because the browser's session has no user
   * id to compare against. The route already answers the question: it returns
   * `shares` to the author and withholds it from everyone else, so an array —
   * empty or not — is the server saying "this is yours". A thread created by
   * asking on this screen is this person's by construction.
   */
  let isAuthor = false;

  function paintSharing(): void {
    clear(sharing);
    // Only the author, and only once a thread exists. A conversation that has
    // not been started has nobody to share with and no id to share.
    if (!thread || !isAuthor) return;
    sharing.append(sharingPanel(thread, currentShares, ctx, (t) => {
      thread = t;
      const i = threads.findIndex((x) => x.id === t.id);
      if (i >= 0) threads[i] = t;
      paintList();
    }));
  }

  let currentShares: ThreadShare[] = [];

  /* ── The composer ──────────────────────────────────────────────────────── */

  const input = el('textarea', {
    class: 'field dv-input',
    rows: 1,
    // Short on purpose. The opening note above already lists what can be asked,
    // at a width that can hold it; a long placeholder in a one-row textarea
    // wraps and is clipped mid-word on a phone.
    placeholder: 'Ask a question…',
    'aria-label': 'Ask Driver a question',
  }) as HTMLTextAreaElement;

  // One model, so a select would be a control that cannot be used; more than
  // one, and the pick is the customer's. Settings holds the default either way.
  const picker = modelPicker(models, 'driver');
  const byline = modelByline(models, 'driver');

  const send = el('button', { class: 'btn primary dv-send', title: 'Ask', html: icon(ICONS.arrowUp) });
  const composerStatus = el('div', { class: 'dv-status' });
  let asking = false;

  /**
   * Ask, and put the answer at the end of the conversation.
   *
   * The question renders before the request goes out, so the screen shows what
   * is being asked for the tens of seconds a turn can take. The waiting line
   * says the budget out loud rather than spinning silently: a person who knows
   * an answer can take forty-five seconds waits differently from one who thinks
   * the page has hung.
   */
  async function ask(question: string): Promise<void> {
    if (asking || !question.trim()) return;
    asking = true;
    send.setAttribute('disabled', 'true');
    input.value = '';

    // The opening note is the empty state of the conversation, so it goes the
    // moment there is one. Left in place it sits above the first exchange
    // explaining what to ask to someone who has just asked.
    conversation.querySelector('.dv-opening')?.remove();

    conversation.append(questionBlock(question));
    const waiting = el('div', { class: 'loading num dv-waiting' }, ['reading your data — this can take up to 45 seconds…']);
    conversation.append(waiting);
    waiting.scrollIntoView({ block: 'nearest' });

    try {
      const answer = await askDriver(question, {
        ...(threadId ? { threadId } : {}),
        ...(picker.current() ? { model: picker.current()! } : {}),
      });
      waiting.remove();

      const note = partialAnswerNote(answer);
      conversation.append(
        note
          ? answerBlock(answer.parts, ctx, note, () => void ask(question))
          : answerBlock(answer.parts, ctx),
      );

      // The thread the turn was stored in. A first question creates one, and
      // the hash follows so the conversation is linkable and a reload returns
      // to it. `history.replaceState` rather than a hash assignment: setting
      // the hash fires `hashchange`, which re-renders the route and would
      // throw away the answer that just arrived.
      if (answer.threadId && answer.threadId !== threadId) {
        threadId = answer.threadId;
        history.replaceState(null, '', `#/driver/${threadId}`);
        // Refreshed rather than fabricated: the row carries a `createdAt` and
        // a `visibility` this screen did not choose.
        const refreshed = await fetchDriverThreads().catch(() => threads);
        threads.splice(0, threads.length, ...refreshed);
        thread = threads.find((t) => t.id === threadId) ?? null;
        isAuthor = true;
        paintList();
        paintSharing();
      }
    } catch (err) {
      waiting.remove();
      conversation.append(el('div', { class: 'errbox' }, [`Could not answer: ${readableError(err)}`]));
    } finally {
      asking = false;
      send.removeAttribute('disabled');
      composerStatus.textContent = '';
    }
  }

  send.addEventListener('click', () => void ask(input.value));
  input.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    // Enter sends; shift+Enter writes a second line. A question long enough to
    // need two lines is rare, and losing one to a stray Enter is not.
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void ask(input.value);
    }
  });
  // The box grows with the question rather than scrolling a one-line window.
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });

  /* ── Assembly ──────────────────────────────────────────────────────────── */

  paintList();

  if (threadId) {
    try {
      const detail = await fetchDriverThread(threadId);
      thread = detail.thread;
      isAuthor = detail.shares !== undefined;
      currentShares = detail.shares ?? [];
      conversation.append(...transcript(detail.messages, ctx));
      paintSharing();
    } catch (err) {
      conversation.append(el('div', { class: 'errbox' }, [`Could not open that conversation: ${readableError(err)}`]));
    }
  } else {
    conversation.append(el('div', { class: 'emptybox dv-opening' }, [
      el('p', {}, ['Ask about anything Engine measures — what is wrong with the site, which queries are nearly ranking, where sessions came from, what is connected.']),
      el('p', {}, ['Every figure in an answer comes from your own data, and each one says which tables it was read from.']),
    ]));
  }

  const composer = el('div', { class: 'dv-composer' }, [
    el('div', { class: 'dv-composer-row' }, [input, send]),
    byline ?? picker.root,
    composerStatus,
  ]);

  const screen = el('div', { class: 'dv' }, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('driver')]),
      el('p', {}, ['Ask a question about this site. Driver reads your own data to answer it.']),
    ]),
    el('div', { class: 'dv-body' }, [
      el('aside', { class: 'dv-rail' }, [list]),
      el('div', { class: 'dv-main' }, [conversation, composer, sharing]),
    ]),
  ]);

  // A question typed on Home or in the palette. Asked after the screen is
  // built so its answer lands in a conversation that is already on screen.
  const pending = takePending();
  if (pending) queueMicrotask(() => void ask(pending));

  return screen;
}
