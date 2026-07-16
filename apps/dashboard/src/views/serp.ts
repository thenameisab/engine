import { el, clear } from '../dom.js';
import { hostname, domainRank, normalizeDomain, serpFeatureLabel } from '../format.js';
import { rankPoll, getApiBaseUrl } from '../api.js';
import type { AppContext } from '../context.js';
import type { SerpInspectResult } from '../types.js';

const COUNTRIES = ['US', 'GB', 'IN', 'DE', 'CA', 'AU'];

/** Features we call out as GEO-critical (AI answering) vs. ordinary SERP features. */
const GEO_FEATURES = new Set(['ai_overview', 'ai_mode']);

function featureChips(features: string[]): HTMLElement {
  if (features.length === 0) {
    return el('div', { class: 'serp-features' }, [
      el('span', { class: 'chip-plain muted' }, ['No special SERP features — plain ten blue links']),
    ]);
  }
  return el('div', { class: 'serp-features' }, features.map((f) =>
    el('span', { class: `chip-plain${GEO_FEATURES.has(f) ? ' geo' : ''}` }, [
      GEO_FEATURES.has(f) ? `◆ ${serpFeatureLabel(f)}` : serpFeatureLabel(f),
    ]),
  ));
}

function resultBlock(res: SerpInspectResult, domain: string): HTMLElement {
  const target = normalizeDomain(domain);
  const rank = target ? domainRank(res.organic, domain) : null;
  const hasAiOverview = res.features.some((f) => GEO_FEATURES.has(f));

  const rankCard = target
    ? el('div', { class: `serp-rank ${rank ? 'found' : 'missing'}` }, [
        el('div', { class: 'serp-rank-n num' }, [rank ? `#${rank}` : '—']),
        el('div', { class: 'serp-rank-l' }, [rank ? `${target} ranks #${rank}` : `${target} not in top ${res.organic.length}`]),
      ])
    : null;

  return el('div', {}, [
    el('div', { class: 'serp-summary' }, [
      el('div', { class: `serp-geo ${hasAiOverview ? 'on' : 'off'}` }, [
        el('div', { class: 'serp-geo-l' }, ['AI Overview']),
        el('div', { class: 'serp-geo-v' }, [hasAiOverview ? 'Present — Google is answering with AI' : 'Not shown for this query']),
      ]),
      rankCard,
    ]),
    el('div', { class: 'label serp-sec' }, ['SERP features']),
    featureChips(res.features),
    el('div', { class: 'label serp-sec' }, [`Organic results · ${res.vendor} · polled ${new Date(res.polledAt).toLocaleTimeString()}`]),
    el('div', { class: 'serp-organic' }, res.organic.slice(0, 10).map((o) => {
      const host = hostname(o.url);
      const mine = target && (host === target || host.endsWith(`.${target}`));
      return el('a', { class: `serp-row${mine ? ' mine' : ''}`, href: o.url, target: '_blank', rel: 'noopener noreferrer' }, [
        el('span', { class: 'serp-pos num' }, [`#${o.position}`]),
        el('div', { class: 'serp-main' }, [
          el('div', { class: 'serp-title' }, [o.title || '(no title)']),
          el('div', { class: 'serp-host num' }, [host]),
        ]),
        mine ? el('span', { class: 'pill impact' }, ['you']) : null,
      ]);
    })),
  ]);
}

export async function serpView(ctx: AppContext): Promise<HTMLElement> {
  ctx.setBadge('live'); // this view is only meaningful against a live API + SERP key

  const kw = el('input', { class: 'field', type: 'text', placeholder: 'keyword, e.g. best crm for small business' }) as HTMLInputElement;
  const domain = el('input', { class: 'field', type: 'text', placeholder: 'your domain (optional), e.g. acme.com' }) as HTMLInputElement;
  const country = el('select', { class: 'field' }, COUNTRIES.map((c) => el('option', { value: c }, [c]))) as HTMLSelectElement;
  const out = el('div', { class: 'serp-out' });

  async function run(): Promise<void> {
    const keyword = kw.value.trim();
    if (!keyword) { kw.focus(); return; }
    if (!getApiBaseUrl()) {
      clear(out);
      out.append(el('div', { class: 'serp-empty' }, ['Set an API base URL under Settings first — this view runs a live Google query through your Serper key.']));
      return;
    }
    clear(out);
    out.append(el('div', { class: 'loading num' }, [`querying Google for “${keyword}”…`]));
    try {
      const res = await rankPoll(keyword, country.value);
      clear(out);
      out.append(resultBlock(res, domain.value));
    } catch (err) {
      clear(out);
      out.append(el('div', { class: 'errbox' }, [`Lookup failed: ${(err as Error).message}. Check the API base URL (Settings) and that SERPER_API_KEY is wired.`]));
    }
  }

  const go = el('button', { class: 'btn primary', onclick: run }, ['Check SERP']);
  kw.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void run(); });

  return el('div', {}, [
    el('div', { class: 'pagehead' }, [
      el('h1', {}, ['SERP Inspector']),
      el('p', { html: 'Live Google results for any keyword via Serper — your rank, who beats you, and whether Google is answering with an <b>AI Overview</b> (the GEO signal).' }),
    ]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'serp-form' }, [
        kw,
        el('div', { class: 'serp-form-row' }, [domain, country, go]),
      ]),
    ]),
    out,
  ]);
}
