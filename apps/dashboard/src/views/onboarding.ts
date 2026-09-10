/**
 * Get started: one form that creates the client (account), the site (project)
 * and the brand (entity) Engine audits, then records the domain as connected.
 *
 * It replaces the three `window.prompt()` dialogs the Clients grid used, and it
 * is where a signed-in user with no selected project lands instead of a Pulse
 * error banner. A user who already has sites sees them first, so a new device
 * or a cleared browser is a pick, not a re-creation.
 */
import { el } from '../dom.js';
import {
  fetchAccounts,
  createAccountApi,
  createProjectApi,
  createEntityApi,
  markDomainConnectedApi,
  requestAudit,
  getAccountId,
  setAccountId,
  setProjectId,
} from '../api.js';
import { readableError } from '../errors.js';
import { onboardingDefaults, ENTITY_KIND_OPTIONS, DEFAULT_ENTITY_KIND, screenName } from '../format.js';
import type { AppContext } from '../context.js';
import type { AccountCard, ApiProject } from '../types.js';

const NEW_CLIENT = '__new__';

/**
 * Set by the Clients grid's "+ New client" so the form opens on a new client
 * even when one is already selected; consumed on the first render.
 */
export const ONBOARDING_INTENT_KEY = 'engine.onboardingIntent';

function readIntent(): string | null {
  try {
    const v = sessionStorage.getItem(ONBOARDING_INTENT_KEY);
    sessionStorage.removeItem(ONBOARDING_INTENT_KEY);
    return v;
  } catch {
    return null;
  }
}

function clientLabel(a: AccountCard): string {
  return a.branding.companyName ?? a.name;
}

function selectProject(accountId: string, p: ApiProject, ctx: AppContext): void {
  setAccountId(accountId);
  setProjectId(p.id);
  ctx.toast(`Switched to ${p.name}`);
  ctx.navigate('pulse');
}

/** Existing sites, for a returning user on a device that has nothing selected. */
function existingSites(accounts: AccountCard[], ctx: AppContext): HTMLElement | null {
  const rows = accounts.flatMap((a) => a.projects.map((p) => ({ a, p })));
  if (rows.length === 0) return null;
  return el('section', { class: 'panel' }, [
    el('header', {}, [el('h3', {}, ['Continue with a site you already added'])]),
    el('div', { class: 'client-projects' }, rows.map(({ a, p }) =>
      el('button', { class: 'client-project', onclick: () => selectProject(a.id, p, ctx) }, [
        el('span', { class: 't' }, [`${clientLabel(a)} · ${p.name}`]),
        el('span', { class: 'm' }, [p.domain]),
      ]),
    )),
  ]);
}

export async function onboardingView(ctx: AppContext): Promise<HTMLElement> {
  let accounts: AccountCard[] = [];
  let loadError: string | null = null;
  try {
    accounts = await fetchAccounts();
  } catch (err) {
    loadError = readableError(err);
  }

  const intent = readIntent();
  const preselected = getAccountId();
  const defaultClient =
    intent === 'new-client' ? NEW_CLIENT
    : accounts.some((a) => a.id === preselected) ? (preselected as string)
    : accounts[0]?.id ?? NEW_CLIENT;

  const clientSelect = el('select', { class: 'field' }) as HTMLSelectElement;
  const addClientOption = (a: AccountCard): HTMLOptionElement => {
    const opt = el('option', { value: a.id }, [clientLabel(a)]);
    clientSelect.insertBefore(opt, newClientOption);
    return opt;
  };
  const newClientOption = el('option', { value: NEW_CLIENT }, ['New client…']);
  clientSelect.append(newClientOption);
  accounts.forEach(addClientOption);
  clientSelect.value = defaultClient;

  const clientName = el('input', { class: 'field', type: 'text', placeholder: 'e.g. Acme Dental', autocomplete: 'organization' }) as HTMLInputElement;
  const clientNameWrap = el('div', { class: 'fstack' }, [
    el('label', { class: 'flabel' }, ['Client name']),
    clientName,
    el('div', { class: 'fhint' }, ['The business you are doing this work for. Use your own name if that is you.']),
  ]);
  const syncClientName = () => { clientNameWrap.hidden = clientSelect.value !== NEW_CLIENT; };
  clientSelect.addEventListener('change', syncClientName);
  syncClientName();

  const domain = el('input', { class: 'field', type: 'text', placeholder: 'acme.example', autocomplete: 'url', inputmode: 'url' }) as HTMLInputElement;
  const siteName = el('input', { class: 'field', type: 'text', placeholder: 'Filled from the web address if left blank' }) as HTMLInputElement;
  const brandName = el('input', { class: 'field', type: 'text', placeholder: 'Filled from the client name if left blank' }) as HTMLInputElement;

  // What the brand *is*. Engine writes this into the structured data it
  // proposes; without it the best it could say was "a thing", which is valid
  // and tells a search engine nothing.
  const brandKind = el('select', { class: 'field' }, ENTITY_KIND_OPTIONS.map((k) =>
    el('option', { value: k.value }, [k.label]),
  )) as HTMLSelectElement;
  brandKind.value = DEFAULT_ENTITY_KIND;

  const errorBox = el('div', { class: 'form-error', role: 'alert' });
  errorBox.hidden = true;
  const showError = (message: string) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
  };

  const submit = el('button', { class: 'btn primary', type: 'submit' }, ['Set up this site']);

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    errorBox.hidden = true;
    const isNew = clientSelect.value === NEW_CLIENT;
    const chosen = accounts.find((a) => a.id === clientSelect.value);
    const cName = isNew ? clientName.value.trim() : chosen ? clientLabel(chosen) : '';
    if (isNew && !cName) return showError('Enter the client’s name.');
    const d = onboardingDefaults(cName, domain.value, siteName.value, brandName.value);
    if (!d.domain) return showError('Enter the site’s web address, like acme.example.');

    submit.setAttribute('disabled', 'true');
    submit.textContent = 'Setting up…';
    try {
      let accountId = clientSelect.value;
      if (isNew) {
        const account = await createAccountApi(cName);
        // Keep the created client selectable, so a failure on the next step
        // and a retry does not create it twice.
        accounts = [account, ...accounts];
        addClientOption(account);
        clientSelect.value = account.id;
        syncClientName();
        accountId = account.id;
      }
      const project = await createProjectApi(accountId, d.siteName, d.domain);
      await createEntityApi(project.id, d.brandName, brandKind.value);
      setAccountId(accountId);
      setProjectId(project.id);
      try {
        await markDomainConnectedApi(project.id);
      } catch {
        // Bookkeeping for the onboarding KPIs; the site is set up either way.
      }
      // Queue the first audit so the customer lands on a screen that is doing
      // something. If the queue refuses, the Audit screen has the button.
      let queued = false;
      try {
        await requestAudit(project.id);
        queued = true;
      } catch {
        /* handled by the toast below */
      }
      ctx.toast(queued ? `${d.siteName} is set up. First audit queued.` : `${d.siteName} is set up.`);
      ctx.navigate('audit');
    } catch (err) {
      showError(readableError(err));
      submit.removeAttribute('disabled');
      submit.textContent = 'Set up this site';
    }
  }

  const form = el('form', { class: 'form', onsubmit: onSubmit }, [
    el('label', { class: 'flabel' }, ['Client']),
    clientSelect,
    clientNameWrap,
    el('label', { class: 'flabel' }, ['Web address']),
    domain,
    el('div', { class: 'fhint' }, ['The site Engine will audit. A full URL is fine; only the domain is kept.']),
    el('label', { class: 'flabel' }, ['Site name']),
    siteName,
    el('label', { class: 'flabel' }, ['Brand or business name']),
    brandName,
    el('div', { class: 'fhint' }, ['How search engines and AI answers should refer to this business. Engine checks that they do.']),
    el('label', { class: 'flabel' }, ['What kind of thing is it?']),
    brandKind,
    el('div', { class: 'fhint' }, ['Engine tells search engines and assistants what this is. You can change it later in Settings.']),
    errorBox,
    el('div', { class: 'form-actions' }, [submit]),
  ]);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('get-started')]),
      el('p', {}, ['Engine works on one website at a time. Say whose site it is and where it lives; you can add more later from Clients.']),
    ]),
    loadError ? el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load your clients: ${loadError}`])]) : null,
    existingSites(accounts, ctx),
    el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, [accounts.length > 0 ? 'Add a site' : 'Your first site'])]),
      form,
    ]),
  ]);
}
