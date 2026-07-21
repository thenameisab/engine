/**
 * The ⌘K Copilot (D1.3 "persistent copilot, available on every screen").
 *
 * M2.2's exit criterion is "entity-first joins power a cross-SEO/GEO query
 * in the Copilot" — this is that query's first real surface: pick an entity,
 * see its organic rank (A1), AI citation band (A2), and open findings (B1)
 * in one place, joined server-side through `entity_id`. No natural-language
 * layer yet (that's the fuller D1 build) — this is the query, not the chat.
 */
import { el, clear } from './dom.js';
import { icon, ICONS } from './icons.js';
import { fetchEntities, fetchCopilotSummary, askCopilot, proposeFix, getApiBaseUrl } from './api.js';
import type { ApiEntity, CopilotSummary, CopilotAnswer } from './types.js';

function summaryBlock(s: CopilotSummary): HTMLElement {
  const ai = s.ai.samplesObserved > 0
    ? `${s.ai.band.point.toFixed(0)}% (${s.ai.band.low.toFixed(0)}–${s.ai.band.high.toFixed(0)} range, ${s.ai.samplesObserved} samples)`
    : 'not measured yet';
  return el('div', { class: 'copilot-summary' }, [
    el('div', { class: 'copilot-row' }, [
      el('span', { class: 'copilot-k' }, ['Organic Share of Voice']),
      el('span', { class: 'copilot-v num' }, [
        s.organic.keywordsTracked > 0 ? `${s.organic.sov.toFixed(0)}% across ${s.organic.keywordsTracked} keyword(s)` : 'no keywords tracked yet',
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
      : el('div', { class: 'copilot-empty' }, ['No open findings for this entity.']),
  ]);
}

function head(markup: string, label: string): HTMLElement {
  return el('div', { class: 'copilot-head' }, [
    el('span', { class: 'copilot-icon', html: icon(markup) }),
    el('span', {}, [label]),
  ]);
}

/** The source table each citation points at, shown as a short pillar tag. */
const SOURCE_LABEL: Record<CopilotCitationSource, string> = {
  serp_positions: 'A1 · organic',
  citation_events: 'A2 · AI',
  findings: 'B1 · finding',
};
type CopilotCitationSource = CopilotAnswer['citations'][number]['source'];

/**
 * Render one NL answer: the phrased prose, the citations that back every
 * figure in it, and — when the answer surfaced a fixable finding — the
 * Finding -> Action button that proposes the fix through the M2.3 route.
 */
function answerBlock(answer: CopilotAnswer, latencyMs: number, onProposed: (note: string) => void): HTMLElement {
  const block = el('div', { class: 'copilot-answer' }, [
    el('p', { class: 'copilot-answer-text' }, [answer.answer]),
  ]);

  if (answer.citations.length > 0) {
    block.append(
      el('div', { class: 'copilot-cites' }, [
        el('div', { class: 'copilot-cites-label' }, ['Sources']),
        ...answer.citations.map((cite) =>
          el('div', { class: 'copilot-cite' }, [
            el('span', { class: `copilot-cite-tag src-${cite.source}` }, [SOURCE_LABEL[cite.source]]),
            el('span', { class: 'copilot-cite-text' }, [cite.label]),
          ]),
        ),
      ]),
    );
  }

  if (answer.suggestedAction) {
    const sa = answer.suggestedAction;
    const btn = el('button', { class: 'btn copilot-fix-btn' }, [sa.label]);
    const status = el('div', { class: 'copilot-fix-status' });
    btn.addEventListener('click', () => {
      btn.setAttribute('disabled', 'true');
      status.replaceChildren(document.createTextNode('proposing…'));
      status.className = 'copilot-fix-status loading num';
      void proposeFix(sa.findingId)
        .then((res) => {
          const note = res.actions.length > 0 ? `Proposed ${res.actions.length} fix(es) — see the Fix Queue.` : res.note ?? 'No fix could be generated for this finding.';
          status.className = 'copilot-fix-status';
          status.replaceChildren(document.createTextNode(note));
          onProposed(note);
        })
        .catch((err: Error) => {
          status.className = 'copilot-fix-status errbox';
          status.replaceChildren(document.createTextNode(`Could not propose: ${err.message}`));
          btn.removeAttribute('disabled');
        });
    });
    block.append(el('div', { class: 'copilot-fix' }, [btn, status]));
  }

  block.append(el('div', { class: 'copilot-latency num' }, [`answered in ${latencyMs} ms`]));
  return block;
}

export function mountCopilot(root: HTMLElement): void {
  const overlay = el('div', { class: 'copilot-overlay' });
  const panel = el('div', { class: 'copilot-panel' });
  overlay.append(panel);
  root.append(overlay);

  let entities: ApiEntity[] | null = null;

  function close(): void {
    overlay.classList.remove('open');
  }

  /** The NL ask bar — a text input that posts to the M2.4 /copilot/ask route. */
  function askBar(): HTMLElement {
    const input = el('input', {
      class: 'copilot-input',
      type: 'text',
      placeholder: 'Ask anything — e.g. “what should I fix for Acme Corp?”',
    }) as HTMLInputElement;
    const out = el('div', { class: 'copilot-ask-out' });

    async function run(): Promise<void> {
      const question = input.value.trim();
      if (!question) return;
      out.className = 'copilot-ask-out';
      out.replaceChildren(el('div', { class: 'loading num' }, ['thinking…']));
      try {
        const { answer, latencyMs } = await askCopilot(question);
        out.replaceChildren(answerBlock(answer, latencyMs, () => void 0));
      } catch (err) {
        out.className = 'copilot-ask-out';
        out.replaceChildren(el('div', { class: 'errbox' }, [`Could not answer: ${(err as Error).message}`]));
      }
    }

    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') {
        e.preventDefault();
        void run();
      }
    });
    return el('div', { class: 'copilot-ask' }, [
      el('div', { class: 'copilot-ask-row' }, [input, el('button', { class: 'btn', onclick: () => void run() }, ['Ask'])]),
      out,
    ]);
  }

  async function renderPicker(): Promise<void> {
    const pickerHead = head(ICONS.search, 'Ask the Copilot');
    clear(panel);
    panel.append(pickerHead);
    if (!getApiBaseUrl()) {
      panel.append(el('div', { class: 'copilot-empty' }, ['Set an API base URL under Settings first.']));
      return;
    }
    // Stable regions: the ask bar (with any typed question) survives while the
    // entities region loads independently below it.
    panel.append(askBar());
    panel.append(el('div', { class: 'copilot-or' }, ['or pick an entity for a full cross-SEO/GEO summary']));
    const entitiesRegion = el('div', { class: 'copilot-entities' });
    panel.append(entitiesRegion);

    if (!entities) {
      entitiesRegion.append(el('div', { class: 'loading num' }, ['loading entities…']));
      try {
        entities = await fetchEntities();
      } catch (err) {
        clear(entitiesRegion);
        entitiesRegion.append(el('div', { class: 'errbox' }, [`Could not load entities: ${(err as Error).message}`]));
        return;
      }
      clear(entitiesRegion);
    }
    if (entities.length === 0) {
      entitiesRegion.append(el('div', { class: 'copilot-empty' }, ['No entities in this project yet.']));
      return;
    }
    entitiesRegion.append(
      el('ul', { class: 'copilot-list' }, entities.map((e) =>
        el('li', { class: 'copilot-item', onclick: () => void showSummary(e) }, [e.canonicalName]),
      )),
    );
  }

  async function showSummary(entity: ApiEntity): Promise<void> {
    clear(panel);
    panel.append(head(ICONS.pulse, entity.canonicalName), el('div', { class: 'loading num' }, ['joining organic + AI + findings for this entity…']));
    try {
      const summary = await fetchCopilotSummary(entity.id);
      clear(panel);
      panel.append(
        head(ICONS.pulse, entity.canonicalName),
        summaryBlock(summary),
        el('button', { class: 'btn', onclick: () => void renderPicker() }, ['← back']),
      );
    } catch (err) {
      clear(panel);
      panel.append(
        head(ICONS.pulse, entity.canonicalName),
        el('div', { class: 'errbox' }, [`Could not load summary: ${(err as Error).message}`]),
        el('button', { class: 'btn', onclick: () => void renderPicker() }, ['← back']),
      );
    }
  }

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  addEventListener('keydown', (e) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (overlay.classList.contains('open')) {
        close();
      } else {
        overlay.classList.add('open');
        void renderPicker();
      }
    } else if (e.key === 'Escape' && overlay.classList.contains('open')) {
      close();
    }
  });
}
