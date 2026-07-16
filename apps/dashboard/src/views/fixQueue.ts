import { el } from '../dom.js';
import { LANE_ORDER, statusLabel, nextAction } from '../format.js';
import { transitionAction } from '../api.js';
import { MOCK_ACTIONS } from '../mock.js';
import type { AppContext } from '../context.js';
import type { ActionCard, ActionStatus } from '../types.js';

function card(a: ActionCard, ctx: AppContext, onMoved: (id: string, to: ActionStatus) => void): HTMLElement {
  const next = nextAction(a.status);
  const foot = el('div', { class: 'foot' }, [
    a.impact !== undefined ? el('span', { class: 'pill impact' }, [`+${a.impact} impact`]) : null,
    a.effort ? el('span', { class: 'pill effort' }, [a.effort]) : null,
  ]);

  const node = el('div', { class: `card${a.status === 'verified' ? ' verified' : ''}` }, [
    el('div', { class: 'kind' }, [a.status === 'verified' ? `✓ ${a.kind}` : a.kind]),
    el('div', { class: 'ttl' }, [a.title]),
    foot,
  ]);

  if (next) {
    const btn = el('button', {
      class: 'card-act',
      onclick: async (e: Event) => {
        e.stopPropagation();
        btn.setAttribute('disabled', 'true');
        btn.textContent = `${next.label}…`;
        try {
          await transitionAction(a.id, next.to as Exclude<ActionStatus, 'proposed'>);
          ctx.toast(`${a.kind} → ${statusLabel(next.to)} (live)`);
        } catch {
          // Pre-alpha: no DB, so the live call fails — reflect the move locally
          // so the lifecycle is demonstrable, and say so plainly.
          ctx.toast(`${a.kind} → ${statusLabel(next.to)} (sample — no live DB)`);
        }
        onMoved(a.id, next.to);
      },
    }, [next.label]);
    node.append(btn);
  }
  return node;
}

export async function fixQueueView(ctx: AppContext): Promise<HTMLElement> {
  let actions = [...MOCK_ACTIONS];
  const container = el('section', { class: 'panel fq' });

  const rerender = () => {
    container.replaceChildren();
    container.append(
      el('div', { class: 'fq-head' }, [
        el('span', { class: 'dot' }),
        el('h3', {}, ['Fix Queue']),
        el('span', { class: 'fq-sub' }, ['Propose → approve → deploy → verify. Every fix is reversible.']),
      ]),
      el('div', { class: 'lanes' }, LANE_ORDER.map((status) => lane(status, actions, ctx, onMoved))),
    );
  };

  function onMoved(id: string, to: ActionStatus): void {
    actions = actions.map((a) => (a.id === id ? { ...a, status: to } : a));
    rerender();
  }

  rerender();

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Fix Queue']),
      el('p', { html: 'Approve a card to walk it through the lifecycle. Transitions call the live API when configured, and fall back to a local move otherwise.' }),
    ]),
    container,
  ]);
}

function lane(status: ActionStatus, actions: ActionCard[], ctx: AppContext, onMoved: (id: string, to: ActionStatus) => void): HTMLElement {
  const inLane = actions.filter((a) => a.status === status);
  return el('div', { class: 'lane' }, [
    el('div', { class: 'lane-h' }, [
      el('span', { class: 'label' }, [statusLabel(status)]),
      el('span', { class: 'n' }, [String(inLane.length)]),
    ]),
    ...(inLane.length > 0
      ? inLane.map((a) => card(a, ctx, onMoved))
      : [el('div', { class: 'lane-empty' }, ['—'])]),
  ]);
}
