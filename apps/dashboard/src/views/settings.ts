import { el } from '../dom.js';
import { getApiBaseUrl, setApiBaseUrl, getProjectId, setProjectId, getAccountId, updateBrandingApi } from '../api.js';
import { integrationsSection } from './integrations.js';
import type { AppContext } from '../context.js';

/**
 * M2.5 agency white-label: branding is an account-level setting, so it lives
 * alongside "which project/API base am I pointed at" rather than a separate
 * page. Operates on `getAccountId()` — the account last selected from the
 * Clients grid — since this view has no id in the URL to read one from.
 */
function brandingSection(ctx: AppContext): HTMLElement {
  const accountId = getAccountId();
  if (!accountId) {
    return el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Branding'])]),
      el('div', { class: 'fq-note' }, ['Pick a client from the Clients grid first.']),
    ]);
  }

  const nameInput = el('input', { class: 'field', type: 'text', placeholder: 'Acme Agency' }) as HTMLInputElement;
  const logoInput = el('input', { class: 'field', type: 'text', placeholder: 'https://…/logo.png' }) as HTMLInputElement;
  const colorInput = el('input', { class: 'field', type: 'text', placeholder: '#4f46e5' }) as HTMLInputElement;

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      try {
        await updateBrandingApi(accountId, {
          companyName: nameInput.value.trim() || undefined,
          logoUrl: logoInput.value.trim() || undefined,
          primaryColor: colorInput.value.trim() || undefined,
        });
        ctx.toast('Branding saved.');
      } catch (err) {
        ctx.toast(`Could not save branding: ${(err as Error).message}`);
      }
    },
  }, ['Save branding']);

  return el('section', { class: 'panel' }, [
    el('header', {}, [el('h3', {}, ['Branding']), el('span', { class: 'more' }, [`account ${accountId.slice(0, 8)}…`])]),
    el('div', { class: 'form' }, [
      el('label', { class: 'flabel' }, ['Company name']),
      nameInput,
      el('label', { class: 'flabel' }, ['Logo URL']),
      logoInput,
      el('label', { class: 'flabel' }, ['Primary color']),
      colorInput,
      el('div', { class: 'form-actions' }, [save]),
    ]),
  ]);
}

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
    el('div', { class: 'settings-sec' }, ['Branding']),
    brandingSection(ctx),
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
