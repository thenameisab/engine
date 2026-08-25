import { el } from '../dom.js';
import {
  getApiBaseUrl,
  setApiBaseUrl,
  getProjectId,
  setProjectId,
  getAccountId,
  updateBrandingApi,
  fetchDeployTarget,
  saveDeployTarget,
} from '../api.js';
import { integrationsSection } from './integrations.js';
import { googleIntegrationsSection } from './googleIntegrations.js';
import type { AppContext } from '../context.js';
import type { DeployTarget } from '../types.js';

/**
 * Where an approved fix for this project lands (M2.3 #3). Every generated
 * Action needs a target, so this is what unlocks the Audit view's "Propose
 * fix" button. One target per project; the kind selects which fields matter.
 */
async function deployTargetSection(ctx: AppContext): Promise<HTMLElement> {
  let current: DeployTarget | null = null;
  try {
    current = await fetchDeployTarget();
  } catch {
    // No API / not reachable — render the empty form rather than blocking Settings.
  }

  const kind = el('select', { class: 'field' }, [
    el('option', { value: 'github-pr' }, ['GitHub PR']),
    el('option', { value: 'edge-worker' }, ['Cloudflare edge worker']),
    el('option', { value: 'cms-plugin' }, ['CMS plugin (WordPress/Shopify)']),
  ]) as HTMLSelectElement;
  if (current) kind.value = current.kind;

  const repo = el('input', { class: 'field', type: 'text', placeholder: 'owner/repo', value: current?.repo ?? '' }) as HTMLInputElement;
  const branch = el('input', { class: 'field', type: 'text', placeholder: 'main', value: current?.branch ?? '' }) as HTMLInputElement;
  const path = el('input', { class: 'field', type: 'text', placeholder: 'public/index.html', value: current?.path ?? '' }) as HTMLInputElement;
  const workerName = el('input', { class: 'field', type: 'text', placeholder: 'acme-edge', value: current?.workerName ?? '' }) as HTMLInputElement;
  const plugin = el('select', { class: 'field' }, [
    el('option', { value: 'wordpress' }, ['WordPress']),
    el('option', { value: 'shopify' }, ['Shopify']),
  ]) as HTMLSelectElement;
  if (current?.plugin) plugin.value = current.plugin;
  const siteId = el('input', { class: 'field', type: 'text', placeholder: 'site id', value: current?.siteId ?? '' }) as HTMLInputElement;

  const ghFields = el('div', { class: 'form' }, [
    el('label', { class: 'flabel' }, ['Repository']),
    repo,
    el('label', { class: 'flabel' }, ['Branch']),
    branch,
    el('label', { class: 'flabel' }, ['File path']),
    path,
  ]);
  const edgeFields = el('div', { class: 'form' }, [el('label', { class: 'flabel' }, ['Worker name']), workerName]);
  const cmsFields = el('div', { class: 'form' }, [
    el('label', { class: 'flabel' }, ['Plugin']),
    plugin,
    el('label', { class: 'flabel' }, ['Site ID']),
    siteId,
  ]);

  const showFields = () => {
    ghFields.style.display = kind.value === 'github-pr' ? '' : 'none';
    edgeFields.style.display = kind.value === 'edge-worker' ? '' : 'none';
    cmsFields.style.display = kind.value === 'cms-plugin' ? '' : 'none';
  };
  kind.addEventListener('change', showFields);
  showFields();

  const build = (): DeployTarget | { error: string } => {
    switch (kind.value) {
      case 'github-pr':
        if (!repo.value.trim() || !branch.value.trim() || !path.value.trim()) return { error: 'repo, branch, and path are all required' };
        return { kind: 'github-pr', repo: repo.value.trim(), branch: branch.value.trim(), path: path.value.trim() };
      case 'edge-worker':
        if (!workerName.value.trim()) return { error: 'worker name is required' };
        return { kind: 'edge-worker', workerName: workerName.value.trim() };
      case 'cms-plugin':
        if (!siteId.value.trim()) return { error: 'site id is required' };
        return { kind: 'cms-plugin', plugin: plugin.value as 'wordpress' | 'shopify', siteId: siteId.value.trim() };
      default:
        return { error: 'pick a target kind' };
    }
  };

  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      const built = build();
      if ('error' in built) {
        ctx.toast(built.error);
        return;
      }
      try {
        await saveDeployTarget(built);
        ctx.toast('Deploy target saved. Auto-fixable findings can now be proposed.');
      } catch (err) {
        ctx.toast(`Could not save target: ${(err as Error).message}`);
      }
    },
  }, ['Save deploy target']);

  return el('section', { class: 'panel' }, [
    el('header', {}, [
      el('h3', {}, ['Deploy target']),
      el('span', { class: 'more' }, [current ? `current: ${current.kind}` : 'none set']),
    ]),
    el('div', { class: 'form' }, [
      el('label', { class: 'flabel' }, ['Where approved fixes deploy']),
      kind,
      el('div', { class: 'fhint num' }, ['Every generated fix lands here. GitHub PR opens a pull request; edge worker / CMS plugin apply live.']),
      ghFields,
      edgeFields,
      cmsFields,
      el('div', { class: 'form-actions' }, [save]),
    ]),
  ]);
}

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
      el('p', {}, ['Connect your Google accounts, point this project at the right property, and review which integrations are wired.']),
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
    el('div', { class: 'settings-sec' }, ['Deploy target']),
    await deployTargetSection(ctx),
    el('div', { class: 'settings-sec' }, ['Branding']),
    brandingSection(ctx),
    el('div', { class: 'settings-sec' }, ['Google integrations']),
    await googleIntegrationsSection(ctx),
    el('div', { class: 'settings-sec' }, ['Platform wiring']),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['External integrations']),
        el('span', { class: 'more' }, ['from /health/integrations']),
      ]),
      el('div', { class: 'fhint num' }, [
        'Whether this deployment has its own vendor keys wired. Separate from the Google connections above, which are yours.',
      ]),
      el('div', { class: 'intg-wrap' }, [await integrationsSection()]),
    ]),
  ]);
}
