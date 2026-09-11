import { el } from '../dom.js';
import { screenName } from '../format.js';
import { logoTile } from '../logo.js';
import { infoCard } from '../hovercard.js';
import {
  currentAccountVocabulary,
  fetchConnections,
  fetchIntegrations,
  fetchPlatformAccess,
  fetchProviderCatalog,
  getAccountId,
} from '../api.js';
import { readableError } from '../errors.js';
import { integrationsGallery } from './googleIntegrations.js';
import type { AppContext } from '../context.js';
import type { ReadinessReport, IntegrationReadiness } from '../types.js';

const STATUS_TEXT: Record<IntegrationReadiness['status'], string> = {
  configured: 'Wired',
  partial: 'Partial',
  missing: 'Not wired',
};

function integrationCard(i: IntegrationReadiness): HTMLElement {
  return el('div', { class: `intg ${i.status}` }, [
    el('div', { class: 'intg-top' }, [
      logoTile(i.logoDomain, i.name),
      el('span', { class: `intg-dot ${i.status}` }),
      el('div', { class: 'intg-name' }, [
        i.name,
        i.requiredForMvp ? null : el('span', { class: 'tagband' }, ['optional']),
      ]),
      el('span', { class: `intg-status ${i.status}` }, [STATUS_TEXT[i.status]]),
    ]),
    el('div', { class: 'intg-cat' }, [i.category]),
    i.missing.length > 0
      ? el('div', { class: 'intg-missing' }, [
          'Missing: ',
          el('span', { class: 'num' }, [i.missing.map((m) => m.name).join(', ')]),
        ])
      : el('div', { class: 'intg-ok num' }, ['all required vars set']),
  ]);
}

function summaryStat(label: string, n: number, cls: string): HTMLElement {
  return el('div', { class: `sstat ${cls}` }, [
    el('div', { class: 'sstat-n num' }, [String(n)]),
    el('div', { class: 'sstat-l' }, [label]),
  ]);
}

/**
 * Platform readiness: whether **this deployment** has its own vendor keys wired.
 *
 * An operator view, not a customer one. It used to fall back to a hardcoded
 * `MOCK_READINESS` when the API was unreachable, which was wrong twice over: it
 * presented invented status as fact, and the fixture had gone stale — it still
 * listed a `gsc-oauth` integration that no longer exists. An unreachable API is
 * now reported as an unreachable API.
 */
export async function integrationsSection(): Promise<HTMLElement> {
  let report: ReadinessReport;
  try {
    report = await fetchIntegrations();
  } catch (err) {
    return el('div', { class: 'errbox' }, [
      `Could not read integration readiness: ${readableError(err)}`,
    ]);
  }

  const s = report.summary;
  return el('div', {}, [
    el('div', { class: 'summary-row' }, [
      summaryStat('Wired', s.configured, 'configured'),
      summaryStat('Partial', s.partial, 'partial'),
      summaryStat('Not wired', s.missing, 'missing'),
    ]),
    el('div', { class: 'intg-grid' }, report.integrations.map(integrationCard)),
  ]);
}

/**
 * What still needs doing, said once at the top instead of found tile by tile.
 *
 * A customer opening this page cannot see which of eight tiles is blocked
 * without opening each one, and the blocking reason is usually the same for
 * all of them: Engine's own app with that vendor is not registered yet. So the
 * banner names the vendors that are unregistered and, for an admin, links to
 * the one screen that fixes it.
 *
 * Nothing renders when everything is registered — a banner that always says
 * "all good" is a banner nobody reads.
 */
async function setupBanner(ctx: AppContext): Promise<HTMLElement | null> {
  const accountId = getAccountId();
  // No client selected yet: the gallery below already says so, and asking the
  // API about an empty id would only produce a 400 to swallow.
  if (!accountId) return null;

  let names: string[];
  let isAdmin = false;
  try {
    const [catalog, connectionState, access] = await Promise.all([
      fetchProviderCatalog(),
      fetchConnections(accountId),
      fetchPlatformAccess().catch(() => ({ isAdmin: false })),
    ]);
    isAdmin = access.isAdmin;

    // `vendorsConfigured` is keyed by a lowercased vendor, so its keys cannot
    // be title-cased back into a brand — that produced "Github". The catalogue
    // carries the real spelling, so the display name comes from there and the
    // map is used only for the yes/no.
    const spelling = new Map<string, string>();
    for (const entry of catalog) {
      if (entry.vendor) spelling.set(entry.vendor.toLowerCase(), entry.vendor);
    }
    names = Object.entries(connectionState.vendorsConfigured)
      .filter(([, ready]) => !ready)
      .map(([vendor]) => spelling.get(vendor) ?? vendor);
  } catch {
    // The tiles below report their own failure; a second copy here would say
    // the same thing twice.
    return null;
  }
  if (names.length === 0) return null;

  // A prerequisite, which is what `.notebox` is for — not `warn`. Every tile
  // affected already carries its own "Needs setup", so shouting the same fact
  // in the loudest box on the page made an optional vendor look like a fault.
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const connection = names.length === 1 ? 'that connection' : 'those connections';
  return el('div', { class: 'notebox framed intg-banner' }, [
    el('div', {}, [
      isAdmin
        ? `Engine’s own app is not registered with ${list} yet, so ${connection} cannot be completed by anyone on this deployment.`
        : `${list} ${names.length === 1 ? 'is' : 'are'} not set up for this workspace yet. Ask your administrator to finish the setup.`,
    ]),
    isAdmin
      ? el('div', { class: 'form-actions' }, [
          el('button', { class: 'btn', onclick: () => ctx.navigate('platform') }, ['Finish setup on Platform']),
        ])
      : null,
  ]);
}

/**
 * The Integrations page: the third-party accounts Engine reads from and writes
 * to, and nothing else.
 *
 * "Where fixes go" and report branding briefly rendered here, on the argument
 * that a GitHub PR target needs the GitHub connection granted here. Both have
 * moved back to Settings: they are settings about this account that happen to
 * mention a third party, and a library of connections is not the place to
 * configure the account. What stays is the connections themselves, plus a
 * banner saying what is blocked before the customer opens eight tiles to find
 * out.
 */
export async function integrationsView(ctx: AppContext): Promise<HTMLElement> {
  const [banner, gallery] = await Promise.all([
    setupBanner(ctx),
    integrationsGallery(ctx),
  ]);

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('integrations')]),
      el('p', {}, ['The accounts Engine reads from and writes to.']),
    ]),
    ...(banner ? [banner] : []),
    gallery,
  ]);
}

/**
 * The deployment's own vendor keys, for Settings. Admin-only: the API answers
 * 404 to anyone else, and rendering "could not read" in that case would report
 * a failure at something the customer never asked for, so it renders nothing.
 */
export async function vendorKeysPanel(): Promise<HTMLElement | null> {
  let isAdmin = false;
  try {
    isAdmin = (await fetchPlatformAccess()).isAdmin;
  } catch {
    return null;
  }
  if (!isAdmin) return null;
  const v = currentAccountVocabulary();
  return el('div', {}, [
    el('div', { class: 'settings-sec' }, ['Vendor keys']),
    el('section', { class: 'panel' }, [
      el('header', {}, [
        el('h3', {}, ['Keys this deployment holds']),
        infoCard('What vendor keys are', {
          title: 'Our keys, not yours',
          body: [
            'Whether this deployment has its own vendor keys wired: search results, AI answers, billing.',
            `Separate from the connections on the Integrations page, which belong to one ${v.one} and only that ${v.one} can revoke.`,
          ],
        }),
      ]),
      el('div', { class: 'intg-wrap' }, [await integrationsSection()]),
    ]),
  ]);
}
