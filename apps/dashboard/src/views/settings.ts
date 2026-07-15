import { el } from '../dom.js';
import { getApiBaseUrl, setApiBaseUrl, getProjectId, setProjectId } from '../api.js';
import type { AppContext } from '../context.js';

export async function settingsView(ctx: AppContext): Promise<HTMLElement> {
  ctx.setBadge('sample');

  const baseInput = el('input', {
    class: 'field',
    type: 'text',
    placeholder: 'https://engine-api.<you>.workers.dev  (blank = sample data)',
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
      ctx.toast('Saved. Reopen a view to load live data.');
    },
  }, ['Save']);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['Settings']),
      el('p', {}, ['Point the dashboard at a running apps/api. With no base URL, every view shows built-in sample data.']),
    ]),
    el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['API connection'])]),
      el('div', { class: 'form' }, [
        el('label', { class: 'flabel' }, ['API base URL']),
        baseInput,
        el('div', { class: 'fhint num' }, ['Used for /health/integrations (live) and /projects/:id/pulse (live score math). DB-backed views stay on sample until Postgres is wired.']),
        el('label', { class: 'flabel' }, ['Project ID']),
        projInput,
        el('div', { class: 'form-actions' }, [save]),
      ]),
    ]),
  ]);
}
