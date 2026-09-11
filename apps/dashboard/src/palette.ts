/**
 * The ⌘K palette — search, quick actions, and the shortest way to ask.
 *
 * This was the Copilot overlay, and what changed is what it does with a
 * question. It used to hold its own ask bar posting to `/ai/stream` in 'ask'
 * mode, which made the product two places to type a question that answered
 * differently: the overlay ran the deterministic four-intent Copilot with a
 * model rewording it, and the Driver screen runs the agent loop over nineteen
 * tools. A customer had no way to know which one to use, and no way to tell
 * which had answered.
 *
 * So the palette keeps the ⌘K reflex and gives the question away. Typed text
 * that is not a command is routed to Driver, which is the one surface that
 * answers questions — and §4.8's fallback is unaffected, because
 * `packages/copilot` is still what answers when no model key is wired or the
 * loop runs out of budget. It is the engine underneath, not a second front
 * door.
 *
 * What the palette does itself is what a palette is for: go somewhere, and
 * find a thing. The entity summary stays because M2.2's cross-SEO/GEO join —
 * organic rank, AI citation band and open findings for one entity, joined
 * server-side through `entity_id` — has no other surface in the product.
 */
import { el, clear } from './dom.js';
import { icon, ICONS } from './icons.js';
import { fetchEntities, fetchCopilotSummary, isAgencyWorkspace } from './api.js';
import { askInDriver } from './views/driver.js';
import { screenName } from './format.js';
import { readableError } from './errors.js';
import type { AppContext } from './context.js';
import type { ApiEntity, CopilotSummary } from './types.js';

/** Where the palette can send someone. Ask is first because it is why ⌘K is pressed. */
interface Destination {
  route: string;
  iconMarkup: string;
  /** Words that should find this beyond its own name. */
  also: string[];
}

const DESTINATIONS: Destination[] = [
  { route: 'driver', iconMarkup: ICONS.ask, also: ['ask', 'driver', 'chat', 'question'] },
  { route: 'home', iconMarkup: ICONS.pulse, also: ['pulse', 'dashboard', 'overview', 'traffic'] },
  { route: 'findings', iconMarkup: ICONS.doc, also: ['audit', 'issues', 'problems', 'errors'] },
  { route: 'fixes', iconMarkup: ICONS.kanban, also: ['fix queue', 'actions', 'deploy', 'approve'] },
  { route: 'visibility', iconMarkup: ICONS.serp, also: ['rankings', 'serp', 'brand', 'competitors', 'ai answers', 'local'] },
  { route: 'integrations', iconMarkup: ICONS.plug, also: ['connect', 'google', 'search console', 'analytics', 'cloudflare'] },
  { route: 'settings', iconMarkup: ICONS.gear, also: ['account', 'model', 'branding', 'password', 'cadence'] },
  { route: 'clients', iconMarkup: ICONS.clients, also: ['workspaces', 'agency'] },
];

/**
 * Does this read as a question rather than as a command?
 *
 * Three signals, and the point of having three is that a customer should not
 * have to learn a syntax. A question mark is explicit. An interrogative first
 * word is how most questions start. And anything past four words has stopped
 * being a destination and started being a sentence — nothing in the palette's
 * own vocabulary is that long.
 *
 * Wrong in the safe direction. A query this calls a question still shows every
 * command it matched underneath, so the cost of a false positive is one row in
 * a different order; the cost of the reverse would be a typed question that
 * looks like it went nowhere.
 */
export function looksLikeAQuestion(query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.endsWith('?')) return true;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 4) return true;
  return /^(what|why|how|when|where|which|who|is|are|do|does|did|can|should|show|tell)$/.test(words[0] ?? '');
}

/** Destinations whose name or aliases contain every word typed. */
export function matchDestinations(query: string, agency: boolean): Destination[] {
  const available = DESTINATIONS.filter((d) => d.route !== 'clients' || agency);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return available;
  return available.filter((d) => {
    const hay = `${screenName(d.route)} ${d.also.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function summaryBlock(s: CopilotSummary): HTMLElement {
  const ai = s.ai.samplesObserved > 0
    ? `${s.ai.band.point.toFixed(0)}% (${s.ai.band.low.toFixed(0)}–${s.ai.band.high.toFixed(0)} range, ${s.ai.samplesObserved} samples)`
    : 'not measured yet';
  return el('div', { class: 'copilot-summary' }, [
    el('div', { class: 'copilot-row' }, [
      el('span', { class: 'copilot-k' }, ['Organic Share of Voice']),
      el('span', { class: 'copilot-v num' }, [
        s.organic.keywordsTracked > 0
          ? `${s.organic.sov.toFixed(0)}% across ${s.organic.keywordsTracked} keyword(s)`
          : 'no keywords tracked yet',
      ]),
    ]),
    el('div', { class: 'copilot-row' }, [
      el('span', { class: 'copilot-k' }, ['AI Share of Model']),
      el('span', { class: 'copilot-v num' }, [ai]),
    ]),
    el('div', { class: 'copilot-row' }, [
      el('span', { class: 'copilot-k' }, ['Open findings']),
      el('span', { class: 'copilot-v num' }, [String(s.topFindings.length)]),
    ]),
    s.topFindings.length > 0
      ? el('ul', { class: 'copilot-findings' }, s.topFindings.map((f) =>
          el('li', {}, [`${f.issueType} — ${f.evidence.url ?? 'no url'} (impact ${(f.predictedImpact * 10).toFixed(1)})`]),
        ))
      : el('div', { class: 'emptybox' }, ['No open findings for this entity.']),
  ]);
}

function head(markup: string, label: string): HTMLElement {
  return el('div', { class: 'copilot-head' }, [
    el('span', { class: 'copilot-icon', html: icon(markup) }),
    el('span', {}, [label]),
  ]);
}

export function mountPalette(root: HTMLElement, ctx: AppContext): void {
  const overlay = el('div', { class: 'copilot-overlay' });
  const panel = el('div', { class: 'copilot-panel' });
  overlay.append(panel);
  root.append(overlay);

  /** The entity list, read once and kept for the session. */
  let entities: ApiEntity[] | null = null;

  const input = el('input', {
    class: 'copilot-input',
    type: 'text',
    placeholder: 'Go to a screen, find an entity, or ask a question…',
    'aria-label': 'Search, or ask a question',
  }) as HTMLInputElement;

  const results = el('div', { class: 'pal-results', role: 'listbox' });

  /** The rows currently on screen, and which one Enter would take. */
  let rows: HTMLElement[] = [];
  let cursor = 0;

  function close(): void {
    overlay.classList.remove('open');
  }

  function highlight(): void {
    rows.forEach((r, i) => {
      r.classList.toggle('on', i === cursor);
      if (i === cursor) r.setAttribute('aria-selected', 'true');
      else r.removeAttribute('aria-selected');
    });
    rows[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  function row(iconMarkup: string, label: string, hint: string, run: () => void): HTMLElement {
    const node = el('div', { class: 'pal-row', role: 'option' }, [
      el('span', { class: 'pal-icon', html: icon(iconMarkup) }),
      el('span', { class: 'pal-label' }, [label]),
      el('span', { class: 'pal-hint' }, [hint]),
    ]);
    node.addEventListener('click', run);
    // Kept on the node so the keyboard path and the click path cannot diverge.
    (node as HTMLElement & { run?: () => void }).run = run;
    return node;
  }

  function paint(): void {
    const query = input.value.trim();
    const agency = isAgencyWorkspace();
    const destinations = matchDestinations(query, agency);
    const matchedEntities = query
      ? (entities ?? []).filter((e) => e.canonicalName.toLowerCase().includes(query.toLowerCase())).slice(0, 5)
      : [];

    const askRow = query
      ? row(ICONS.ask, `Ask: ${query}`, 'Driver', () => {
          close();
          askInDriver(ctx, query);
        })
      : null;

    const destinationRows = destinations.map((d) =>
      row(d.iconMarkup, `Go to ${screenName(d.route)}`, 'Screen', () => {
        close();
        ctx.navigate(d.route);
      }),
    );

    const entityRows = matchedEntities.map((e) =>
      row(ICONS.entity, e.canonicalName, 'Entity', () => void showSummary(e)),
    );

    // A question goes to the top; anything else lets the exact command win. A
    // customer who typed "settings" wants Settings, and a customer who typed
    // "why are clicks down" wants an answer, and both are served by the same
    // list in a different order rather than by a mode they have to choose.
    rows = query && looksLikeAQuestion(query)
      ? [askRow!, ...destinationRows, ...entityRows]
      : [...destinationRows, ...entityRows, ...(askRow ? [askRow] : [])];

    cursor = 0;
    clear(results);
    if (rows.length === 0) {
      results.append(el('div', { class: 'emptybox' }, ['Nothing matches that.']));
      return;
    }
    results.append(...rows);
    highlight();
  }

  async function showSummary(entity: ApiEntity): Promise<void> {
    clear(panel);
    panel.append(
      head(ICONS.pulse, entity.canonicalName),
      el('div', { class: 'loading num' }, ['joining organic + AI + findings for this entity…']),
    );
    const back = el('button', { class: 'btn' }, ['← back']);
    back.addEventListener('click', () => renderSearch());
    try {
      const summary = await fetchCopilotSummary(entity.id);
      clear(panel);
      panel.append(head(ICONS.pulse, entity.canonicalName), summaryBlock(summary), back);
    } catch (err) {
      clear(panel);
      panel.append(
        head(ICONS.pulse, entity.canonicalName),
        el('div', { class: 'errbox' }, [`Could not load summary: ${readableError(err)}`]),
        back,
      );
    }
  }

  function renderSearch(): void {
    clear(panel);
    panel.append(el('div', { class: 'pal-bar' }, [input]), results);
    paint();
    input.focus();
    input.select();

    // Entities are a nicety here, not the point, so a failure is not surfaced:
    // the palette navigates and asks perfectly well without them.
    if (entities === null) {
      void fetchEntities()
        .then((list) => {
          entities = list;
          paint();
        })
        .catch(() => {
          entities = [];
        });
    }
  }

  input.addEventListener('input', paint);
  input.addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      cursor = (cursor + 1) % Math.max(rows.length, 1);
      highlight();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      cursor = (cursor - 1 + rows.length) % Math.max(rows.length, 1);
      highlight();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      (rows[cursor] as (HTMLElement & { run?: () => void }) | undefined)?.run?.();
    }
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  /** Open it from the topbar button as well as from the keyboard. */
  function open(): void {
    overlay.classList.add('open');
    input.value = '';
    renderSearch();
  }

  addEventListener('keydown', (e) => {
    const ev = e as KeyboardEvent;
    const isMeta = ev.metaKey || ev.ctrlKey;
    if (isMeta && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      if (overlay.classList.contains('open')) close();
      else open();
    } else if (ev.key === 'Escape' && overlay.classList.contains('open')) {
      close();
    }
  });

  addEventListener('engine:open-palette', open);
}

/**
 * The topbar control that opens the palette.
 *
 * It was a `<span class="kbdhint">` reading "⌘K" with a `title` on it — a label
 * for a shortcut, which told someone who already knew the shortcut what they
 * already knew, and told everyone else nothing they could act on. A button says
 * what it does, works with a pointer, and keeps the shortcut visible beside it.
 *
 * It dispatches an event rather than holding a reference to the palette,
 * because the topbar is built before `mountPalette` runs and passing the opener
 * backwards through `mountShell` would tie the two together for one call.
 */
export function paletteButton(): HTMLElement {
  const btn = el('button', { class: 'palbtn', title: 'Search, or ask a question' }, [
    el('span', { class: 'palbtn-icon', html: icon(ICONS.search) }),
    el('span', { class: 'palbtn-label' }, ['Search or ask']),
    el('span', { class: 'kbdhint' }, ['⌘K']),
  ]);
  btn.addEventListener('click', () => dispatchEvent(new Event('engine:open-palette')));
  return btn;
}
