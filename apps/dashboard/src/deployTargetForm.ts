/**
 * Where approved fixes land, as a form that can be asked for anywhere.
 *
 * It lived only in Settings, and the Audit screen carried a standing banner
 * telling the customer to go there — a sentence shown on every visit, most of
 * them to someone who had no fix to deploy yet, and the one visit it mattered
 * it sent them away from the thing they were trying to do. Extracted so the
 * question can be asked at the moment it is actually needed: the first time a
 * fix is proposed with nowhere to put it.
 */
import { el } from './dom.js';
import { fetchDeployTarget, saveDeployTarget } from './api.js';
import { readableError } from './errors.js';
import { openDialog } from './dialog.js';
import type { AppContext } from './context.js';
import type { DeployTarget } from './types.js';

export interface DeployTargetFormOptions {
  current: DeployTarget | null;
  /** Called with the saved target. The dialog closes on success, not before. */
  onSaved: (target: DeployTarget) => void;
  saveLabel?: string;
}

/** The fields and the Save button, without any panel or dialog around them. */
export function deployTargetFields(ctx: AppContext, options: DeployTargetFormOptions): HTMLElement {
  const current = options.current;
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

  const showFields = (): void => {
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

  const save = el('button', { class: 'btn primary' }, [options.saveLabel ?? 'Save deploy target']);
  save.addEventListener('click', async () => {
    const built = build();
    if ('error' in built) {
      ctx.toast(built.error);
      return;
    }
    save.setAttribute('disabled', 'true');
    try {
      await saveDeployTarget(built);
      options.onSaved(built);
    } catch (err) {
      ctx.toast(`Could not save target: ${readableError(err)}`);
      save.removeAttribute('disabled');
    }
  });

  return el('div', { class: 'form' }, [
    el('label', { class: 'flabel' }, ['Where approved fixes deploy']),
    kind,
    el('div', { class: 'fhint num' }, ['Every generated fix lands here. GitHub PR opens a pull request; edge worker / CMS plugin apply live.']),
    ghFields,
    edgeFields,
    cmsFields,
    el('div', { class: 'form-actions' }, [save]),
  ]);
}

/**
 * Ask for a deploy target now, because a fix has just been asked for and there
 * is nowhere to put it. Resolves with the saved target, or null if the customer
 * closed the dialog — which is a decision, not a failure.
 */
export function askForDeployTarget(ctx: AppContext): Promise<DeployTarget | null> {
  return new Promise((resolve) => {
    let saved: DeployTarget | null = null;
    const body = el('div', {}, [
      el('p', { class: 'fq-note' }, [
        'A fix has to land somewhere. Tell Engine where, once, and every fix after this one goes there.',
      ]),
      el('div', { class: 'dt-form' }, ['Loading…']),
    ]);
    const handle = openDialog({
      title: 'Where should fixes go?',
      content: body,
      onClose: () => resolve(saved),
    });

    void fetchDeployTarget()
      .catch(() => null)
      .then((current) => {
        body.querySelector('.dt-form')!.replaceWith(
          el('div', { class: 'dt-form' }, [
            deployTargetFields(ctx, {
              current,
              saveLabel: 'Save and propose the fix',
              onSaved: (target) => {
                saved = target;
                ctx.toast('Saved. Fixes will deploy here from now on.');
                handle.close();
              },
            }),
          ]),
        );
      });
  });
}
