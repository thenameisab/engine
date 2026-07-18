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
import { fetchEntities, fetchCopilotSummary, getApiBaseUrl } from './api.js';
import type { ApiEntity, CopilotSummary } from './types.js';

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

export function mountCopilot(root: HTMLElement): void {
  const overlay = el('div', { class: 'copilot-overlay' });
  const panel = el('div', { class: 'copilot-panel' });
  overlay.append(panel);
  root.append(overlay);

  let entities: ApiEntity[] | null = null;

  function close(): void {
    overlay.classList.remove('open');
  }

  async function renderPicker(): Promise<void> {
    const pickerHead = head(ICONS.search, 'Ask the Copilot — pick an entity for a cross-SEO/GEO summary');
    clear(panel);
    panel.append(pickerHead);
    if (!getApiBaseUrl()) {
      panel.append(el('div', { class: 'copilot-empty' }, ['Set an API base URL under Settings first.']));
      return;
    }
    if (!entities) {
      panel.append(el('div', { class: 'loading num' }, ['loading entities…']));
      try {
        entities = await fetchEntities();
      } catch (err) {
        clear(panel);
        panel.append(pickerHead, el('div', { class: 'errbox' }, [`Could not load entities: ${(err as Error).message}`]));
        return;
      }
      clear(panel);
      panel.append(pickerHead);
    }
    if (entities.length === 0) {
      panel.append(el('div', { class: 'copilot-empty' }, ['No entities in this project yet.']));
      return;
    }
    panel.append(
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
