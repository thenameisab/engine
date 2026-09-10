/**
 * Set up: one address, one choice, one click.
 *
 * The first form used to ask for five things — client, web address, site
 * name, brand name, and what kind of thing the brand is. Four of them can be
 * read off the address once the customer says whose site it is, so the form
 * asks that instead and shows what it derived, with the one name worth
 * changing (the brand) a click away. It creates the client (account), the
 * site (project) and the brand (entity), queues the first audit, and lands on
 * Home while the crawl runs.
 *
 * A returning user with sites and nothing selected is not handled here any
 * more: the workspace column's "Choose a site" is on this screen too, and one
 * list is enough.
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
import { getUser } from '../auth/session.js';
import { readableError } from '../errors.js';
import {
  onboardingPlan,
  personNameFrom,
  screenName,
  SITE_OWNER_KINDS,
  type SiteOwnerKind,
} from '../format.js';
import type { AppContext } from '../context.js';
import type { AccountCard } from '../types.js';

const NEW_CLIENT = '__new__';

/**
 * Set by the Clients grid's "+ New client" so the form opens on the agency
 * choice with a new client, even when one is already selected; consumed on
 * the first render.
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
  const userName = personNameFrom(getUser());

  /* ── The address ─────────────────────────────────────────────────────────── */

  const domain = el('input', {
    class: 'field',
    type: 'text',
    id: 'setup-domain',
    placeholder: 'acme.example',
    autocomplete: 'url',
    inputmode: 'url',
    spellcheck: 'false',
  }) as HTMLInputElement;

  /* ── Whose site it is ────────────────────────────────────────────────────── */

  let kind: SiteOwnerKind = intent === 'new-client' ? 'agency' : 'company';
  const radios = new Map<SiteOwnerKind, HTMLInputElement>();
  const options = SITE_OWNER_KINDS.map((k) => {
    const input = el('input', { type: 'radio', name: 'owner', value: k.value }) as HTMLInputElement;
    input.checked = k.value === kind;
    input.addEventListener('change', () => {
      kind = k.value;
      sync();
    });
    radios.set(k.value, input);
    return el('label', { class: 'choice-opt' }, [
      input,
      el('span', { class: 'choice-in' }, [
        el('span', { class: 'choice-t' }, [k.label]),
        el('span', { class: 'choice-m' }, [k.hint]),
      ]),
    ]);
  });
  const owner = el('fieldset', { class: 'choice' }, [
    el('legend', { class: 'flabel' }, ['This site belongs to']),
    el('div', { class: 'choice-opts' }, options),
  ]);

  /* ── The client, agency only ─────────────────────────────────────────────── */

  const clientSelect = el('select', { class: 'field', id: 'setup-client' }) as HTMLSelectElement;
  const newClientOption = el('option', { value: NEW_CLIENT }, ['New client…']);
  const addClientOption = (a: AccountCard): void => {
    clientSelect.insertBefore(el('option', { value: a.id }, [clientLabel(a)]), newClientOption);
  };
  clientSelect.append(newClientOption);
  accounts.forEach(addClientOption);
  clientSelect.value =
    intent === 'new-client' ? NEW_CLIENT
    : accounts.some((a) => a.id === preselected) ? (preselected as string)
    : accounts[0]?.id ?? NEW_CLIENT;

  const clientName = el('input', {
    class: 'field',
    type: 'text',
    id: 'setup-client-name',
    placeholder: 'e.g. Acme Dental',
    autocomplete: 'organization',
  }) as HTMLInputElement;
  const clientNameWrap = el('div', { class: 'fstack' }, [
    el('label', { class: 'flabel', for: 'setup-client-name' }, ['Client name']),
    clientName,
  ]);
  const clientWrap = el('div', { class: 'fstack' }, [
    ...(accounts.length > 0
      ? [el('label', { class: 'flabel', for: 'setup-client' }, ['Client']), clientSelect]
      : []),
    clientNameWrap,
  ]);

  /* ── The derived brand name, and the one way to change it ────────────────── */

  const brandName = el('input', {
    class: 'field',
    type: 'text',
    id: 'setup-brand',
    placeholder: 'How search engines and AI answers should say its name',
  }) as HTMLInputElement;
  let brandTouched = false;
  brandName.addEventListener('input', () => { brandTouched = brandName.value.trim() !== ''; });
  const brandWrap = el('div', { class: 'fstack' }, [
    el('label', { class: 'flabel', for: 'setup-brand' }, ['Brand name']),
    brandName,
    el('div', { class: 'fhint' }, ['Engine checks that search engines and AI answers refer to the business by this name.']),
  ]);
  brandWrap.hidden = true;

  const derivedText = el('span');
  const changeBrand = el('button', { class: 'linkbtn', type: 'button' }, ['Change']);
  changeBrand.addEventListener('click', () => {
    brandWrap.hidden = false;
    derived.hidden = true;
    brandName.value = currentPlan().brandName;
    brandTouched = brandName.value.trim() !== '';
    brandName.focus();
    brandName.select();
  });
  const derived = el('p', { class: 'fderived', 'aria-live': 'polite' }, [derivedText, ' ', changeBrand]);

  /** The client an agency picked, or the one that is already selected. */
  function chosenAccount(): AccountCard | undefined {
    if (kind === 'agency') return accounts.find((a) => a.id === clientSelect.value);
    return accounts.find((a) => a.id === preselected) ?? accounts[0];
  }

  function currentPlan() {
    const chosen = kind === 'agency' ? accounts.find((a) => a.id === clientSelect.value) : undefined;
    return onboardingPlan(kind, domain.value, {
      clientName: chosen ? clientLabel(chosen) : clientName.value,
      userName,
      brandName: brandTouched ? brandName.value : '',
    });
  }

  function sync(): void {
    for (const [value, input] of radios) input.checked = value === kind;
    for (const opt of options) opt.classList.toggle('on', (opt.firstChild as HTMLInputElement).checked);
    clientWrap.hidden = kind !== 'agency';
    clientNameWrap.hidden = kind !== 'agency' || (accounts.length > 0 && clientSelect.value !== NEW_CLIENT);
    const plan = currentPlan();
    if (!plan.domain) {
      derivedText.textContent = 'Engine names the brand from the address.';
      changeBrand.hidden = true;
    } else if (!plan.brandName) {
      derivedText.textContent = `Engine will audit ${plan.domain}.`;
      changeBrand.hidden = true;
    } else {
      derivedText.replaceChildren(`Engine will audit ${plan.domain} as `, el('b', {}, [plan.brandName]), '.');
      changeBrand.hidden = false;
    }
  }
  domain.addEventListener('input', sync);
  clientName.addEventListener('input', sync);
  clientSelect.addEventListener('change', sync);

  /* ── Submit ──────────────────────────────────────────────────────────────── */

  const errorBox = el('div', { class: 'form-error', role: 'alert' });
  errorBox.hidden = true;
  const showError = (message: string, focus?: HTMLElement) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
    focus?.focus();
  };

  const SUBMIT_LABEL = 'Start the first audit';
  const submit = el('button', { class: 'btn primary', type: 'submit' }, [SUBMIT_LABEL]);

  async function onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    errorBox.hidden = true;
    const plan = currentPlan();
    if (!plan.domain) return showError('Enter the site’s web address, like acme.example.', domain);
    const existing = chosenAccount();
    if (kind === 'agency' && !existing && !plan.accountName) {
      return showError('Enter the client’s name.', clientName);
    }
    if (!plan.brandName) return showError('Enter the brand’s name.', brandName);

    submit.setAttribute('disabled', 'true');
    submit.textContent = 'Setting up…';
    try {
      let accountId = existing?.id;
      if (!accountId) {
        // The answer to "This site belongs to" is sent, not just used to derive
        // the names above. It was read locally and dropped, so nothing
        // downstream could tell an agency from a company — which is why the
        // agency-only branding panel had no data to gate on.
        const account = await createAccountApi(plan.accountName, kind);
        // Keep the created client selectable, so a failure on the next step
        // and a retry does not create it twice.
        accounts = [account, ...accounts];
        addClientOption(account);
        clientSelect.value = account.id;
        accountId = account.id;
      }
      const project = await createProjectApi(accountId, plan.siteName, plan.domain);
      await createEntityApi(project.id, plan.brandName, plan.entityKind);
      setAccountId(accountId);
      setProjectId(project.id);
      try {
        await markDomainConnectedApi(project.id);
      } catch {
        // Bookkeeping for the onboarding KPIs; the site is set up either way.
      }
      // Queue the first audit so Home has a crawl to show. If the queue
      // refuses, Home offers the Run audit button.
      let queued = false;
      try {
        await requestAudit(project.id);
        queued = true;
      } catch {
        /* said in the toast */
      }
      ctx.toast(queued ? `${plan.domain} is set up. The first audit is running.` : `${plan.domain} is set up.`);
      ctx.navigate('home');
    } catch (err) {
      showError(readableError(err));
      submit.removeAttribute('disabled');
      submit.textContent = SUBMIT_LABEL;
    }
  }

  const form = el('form', { class: 'form', onsubmit: onSubmit, novalidate: true }, [
    el('label', { class: 'flabel', for: 'setup-domain' }, ['Web address']),
    domain,
    el('div', { class: 'fhint' }, ['A full URL is fine; only the domain is kept.']),
    owner,
    clientWrap,
    derived,
    brandWrap,
    errorBox,
    el('div', { class: 'form-actions' }, [submit]),
  ]);
  sync();
  // The shell attaches the view after this returns, and `autofocus` is only
  // honoured for markup present at load. There is one field to fill; put the
  // cursor in it.
  setTimeout(() => { if (document.contains(domain)) domain.focus(); }, 0);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('get-started')]),
      el('p', {}, ['Engine works on one website at a time. Type its address and say whose it is; everything else is read from the site.']),
    ]),
    loadError ? el('section', { class: 'panel' }, [el('div', { class: 'fq-note' }, [`Could not load your clients: ${loadError}`])]) : null,
    el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, [accounts.length > 0 ? 'Add a site' : 'Your first site'])]),
      form,
    ]),
  ]);
}
