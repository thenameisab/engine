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
import {
  currentAccountVocabulary,
  fetchConnectUrl,
  fetchConnections,
  fetchDeployTarget,
  fetchPlatformAccess,
  getAccountId,
  saveDeployTarget,
} from './api.js';
import { chooseAccountNote } from './format.js';
import { readableError } from './errors.js';
import { openDialog } from './dialog.js';
import { openConsentPopup } from './consentPopup.js';
import type { AppContext } from './context.js';
import type { DeployTarget, IntegrationConnection } from './types.js';

export interface DeployTargetFormOptions {
  current: DeployTarget | null;
  /** Called with the saved target. The dialog closes on success, not before. */
  onSaved: (target: DeployTarget) => void;
  saveLabel?: string;
}

/** The fields and the Save button, without any panel or dialog around them. */
export function deployTargetFields(ctx: AppContext, options: DeployTargetFormOptions): HTMLElement {
  const v = currentAccountVocabulary();
  const current = options.current;
  // Ordered by how much work the customer has left after choosing.
  //
  // A plugin or a worker applies the fix live: approve it and the page is
  // different. A pull request needs a repository, a branch, a file path, and
  // then someone to merge it — and until they do, nothing has changed. GitHub
  // was first on this list, so the default for a new site was the one option
  // that cannot finish on its own.
  const kind = el('select', { class: 'field' }, [
    el('option', { value: 'cms-plugin' }, ['WordPress or Shopify plugin']),
    el('option', { value: 'edge-worker' }, ['Cloudflare edge worker']),
    el('option', { value: 'github-pr' }, ['GitHub pull request']),
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

  /**
   * Whether Engine can actually open a pull request for this client, and what
   * to do about it when it cannot.
   *
   * A PR target is the only kind that needs a second thing set up: the customer
   * has to install Engine's GitHub App on the repositories it may write to, and
   * before that an operator has to register the App itself. Without either, the
   * form saved happily and the first Deploy failed with a 503 — the customer
   * learned about the missing step from a failed fix.
   *
   * Three states, because the two failures have different owners: the App
   * unregistered is the administrator's to fix, the App uninstalled is the
   * customer's, and conflating them tells one of them to do the other's job.
   */
  const ghSetup = el('div', { class: 'dt-gh' }, []);
  let ghLoaded = false;

  const paintGhSetup = async (): Promise<void> => {
    const accountId = getAccountId();
    if (!accountId) {
      ghSetup.replaceChildren(
        el('div', { class: 'intg-note' }, [`${chooseAccountNote(v)} The GitHub installation belongs to one ${v.one}.`]),
      );
      return;
    }
    let registered = false;
    let connection: IntegrationConnection | undefined;
    let isAdmin = false;
    try {
      const [state, access] = await Promise.all([
        fetchConnections(accountId),
        fetchPlatformAccess().catch(() => ({ isAdmin: false })),
      ]);
      registered = state.vendorsConfigured.github ?? false;
      connection = state.connections.find((c) => c.provider === 'github');
      isAdmin = access.isAdmin;
    } catch {
      // Unreachable API. Say nothing rather than claim a state: the fields
      // below still work, and inventing "not installed" would send a customer
      // to install something they may already have.
      ghSetup.replaceChildren();
      return;
    }

    if (!registered) {
      ghSetup.replaceChildren(
        el('div', { class: 'intg-note warn' }, [
          isAdmin
            ? `Engine’s GitHub App is not registered for this workspace yet. Register it once on the Platform screen, and every ${v.one} can install it from here.`
            : 'Needs setup by your administrator. Engine’s GitHub App is not registered for this workspace yet, so it cannot open pull requests for anyone.',
        ]),
      );
      if (isAdmin) {
        ghSetup.append(
          el('div', { class: 'form-actions' }, [
            el('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate('platform') }, ['Open Platform']),
          ]),
        );
      }
      return;
    }

    const live = connection?.status === 'connected';
    const label = live
      ? 'Change which repositories'
      : connection?.status === 'needs_reauth'
        ? 'Install Engine on GitHub again'
        : 'Install Engine on GitHub';

    // The same flow the Integrations tile runs, not a second one: one popup,
    // one callback, one place where a connection is recorded.
    const install = el('button', { class: live ? 'btn' : 'btn primary', type: 'button', onclick: async () => {
      install.setAttribute('disabled', 'true');
      try {
        const url = await fetchConnectUrl(accountId, 'github', window.location.hash || '/');
        const outcome = await openConsentPopup(url);
        if (outcome === 'cancelled') ctx.toast('Nothing was installed.');
        else ctx.toast('Checking the installation…');
        // Either way, re-read rather than assert: the popup can succeed and
        // close without reporting.
        await paintGhSetup();
      } catch (err) {
        ctx.toast(`Could not start the installation: ${readableError(err)}`);
      } finally {
        install.removeAttribute('disabled');
      }
    } }, [label]);

    ghSetup.replaceChildren(
      el('div', { class: `intg-note${live ? '' : ' warn'}` }, [
        live
          ? `Engine is installed on GitHub for this ${v.one}. Approved fixes open a pull request in the repository below.`
          : `Engine is not installed on GitHub for this ${v.one} yet, so a pull request cannot be opened. Install it once and every fix after this one goes there.`,
      ]),
      el('div', { class: 'form-actions' }, [install]),
    );
  };

  const showFields = (): void => {
    const isGh = kind.value === 'github-pr';
    // `hidden`, not `style.display`: an inline style beats the stylesheet's
    // `[hidden]` rule, and having two mechanisms decide one element's
    // visibility is how a class with a `display` silently wins.
    ghFields.hidden = !isGh;
    ghSetup.hidden = !isGh;
    edgeFields.hidden = kind.value !== 'edge-worker';
    cmsFields.hidden = kind.value !== 'cms-plugin';
    // Loaded on first use, not on mount: most customers never pick GitHub, and
    // this costs two requests.
    if (isGh && !ghLoaded) {
      ghLoaded = true;
      void paintGhSetup();
    }
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
    el('div', { class: 'fhint' }, [
      'Every generated fix lands here. A plugin or a worker applies it live; a pull request waits for you to merge it.',
    ]),
    ghSetup,
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
