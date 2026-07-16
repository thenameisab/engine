import { el } from '../dom.js';
import { getApiBaseUrl, setApiBaseUrl, getProjectId, setProjectId } from '../api.js';
import { integrationsSection } from './integrations.js';
import type { AppContext } from '../context.js';

export async function settingsView(ctx: AppContext): Promise<HTMLElement> {
  const baseInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'https://engine-api.<you>.workers.dev',
    value: getApiBaseUrl(),
  }) as HTMLInputElement;

  const projInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'demo',
    value: getProjectId(),
  }) as HTMLInputElement;

  const save = el('button', {
    class: 'btn primary',
    onclick: () => {
      setApiBaseUrl(baseInput.value);
      setProjectId(projInput.value);
      ctx.toast('Saved. Reopen a view to reload data.');
    },
  }, ['Save']);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Settings']),
      el('p', {}, ['Connect the dashboard to your Engine API and review which integrations are wired.']),
    ]),
    el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['API connection'])]),
      el('div', { class: 'form' }, [
        el('label', { class: 'flabel' }, ['API base URL']),
        baseInput,
        el('div', { class: 'fhint num' }, ['Where the dashboard reads live data from. Leave blank to explore with sample data.']),
        el('label', { class: 'flabel' }, ['Project ID']),
        projInput,
        el('div', { class: 'form-actions' }, [save]),
      ]),
    ]),
    el('div', { class: 'settings-sec' }, ['Integrations']),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['External integrations']),
        el('span', { class: 'more' }, ['from /health/integrations']),
      ]),
      el('div', { class: 'intg-wrap' }, [await integrationsSection()]),
    ]),
  ]);
}
