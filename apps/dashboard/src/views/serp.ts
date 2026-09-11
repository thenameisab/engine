import { el, clear } from '../dom.js';
import { hostname, domainRank, normalizeDomain, serpFeatureLabel, rankChange, rankLabel, screenName } from '../format.js';
import { rankPoll, fetchTrackedKeywords, fetchSearchTraffic, fetchEntities, trackKeyword, untrackKeyword } from '../api.js';
import { readableError } from '../errors.js';
import type { AppContext } from '../context.js';
import type { SerpInspectResult, TrackedKeyword, SearchQueryRow } from '../types.js';

const COUNTRIES = ['US', 'GB', 'IN', 'DE', 'CA', 'AU'];

/** Features we call out as GEO-critical (AI answering) vs. ordinary SERP features. */
const GEO_FEATURES = new Set(['ai_overview', 'ai_mode']);

/** How many Search Console suggestions to offer at once. */
const SUGGESTION_LIMIT = 8;

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

function resultBlock(res: SerpInspectResult, domain: string, trackBtn: HTMLElement | null): HTMLElement {
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
    trackBtn ? el('div', { class: 'serp-track-row' }, [trackBtn]) : null,
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

/** One tracked keyword: where it stands, which way it moved, and which page holds it. */
function trackedRow(k: TrackedKeyword, onRemove: (k: TrackedKeyword) => void): HTMLElement {
  const change = rankChange(k.position, k.previousPosition);
  const remove = el('button', {
    class: 'frow-act',
    title: `Stop tracking “${k.keyword}”`,
    onclick: () => onRemove(k),
  }, ['Stop tracking']);

  return el('div', { class: 'kw-row' }, [
    el('div', { class: 'kw-main' }, [
      el('div', { class: 't' }, [k.keyword]),
      el('div', { class: 'm num' }, [
        k.url ? hostname(k.url) + new URL(k.url).pathname : `${k.geo.country} · ${k.device} · ${k.cadence}`,
      ]),
    ]),
    el('span', { class: `kw-pos num${k.position === null ? ' none' : ''}` }, [rankLabel(k.position, k.polledAt)]),
    el('span', { class: `kw-change num ${change.direction}` }, [change.text]),
    remove,
  ]);
}

export async function serpView(ctx: AppContext): Promise<HTMLElement> {
  // The tracked list is the screen's subject, so a failed load is shown as a
  // failure. Swallowing it would render "Nothing tracked yet" over a request
  // that never answered, which is the one thing an empty state must not say.
  let loadError: string | null = null;
  const [tracked, entities, traffic] = await Promise.all([
    fetchTrackedKeywords().catch((err) => {
      loadError = readableError(err);
      return [] as TrackedKeyword[];
    }),
    fetchEntities().catch(() => []),
    // The suggestion list is a nicety: a project with no Search Console
    // connection still gets the table and the lookup.
    fetchSearchTraffic().catch(() => null),
  ]);
  const entityId = entities[0]?.id ?? null;
  const root = el('div', {});
  const trackedWrap = el('section', { class: 'panel' });
  const suggestWrap = el('section', { class: 'panel' });

  /**
   * Which country a suggestion is tracked for. Search Console gives the query
   * but the stored rows carry no country, so this cannot be inferred — and
   * assuming one silently tracks an Indian site's queries in the US.
   */
  const suggestCountry = el('select', { class: 'field kw-country' },
    COUNTRIES.map((c) => el('option', { value: c }, [c]))) as HTMLSelectElement;

  /** Keywords already tracked, so a suggestion cannot be added twice. */
  let trackedKeywords = tracked;
  const isTracked = (keyword: string): boolean =>
    trackedKeywords.some((k) => k.keyword.toLowerCase() === keyword.toLowerCase());

  async function reload(): Promise<void> {
    trackedKeywords = await fetchTrackedKeywords();
    renderTracked();
    renderSuggestions();
  }

  async function add(keyword: string, country: string): Promise<void> {
    if (!entityId) {
      ctx.toast('Add your brand under Settings first — a tracked keyword belongs to a brand.');
      return;
    }
    await trackKeyword(entityId, { keyword, geoCountry: country });
    ctx.toast(`Tracking “${keyword}” — the first position arrives after the next poll.`);
    await reload();
  }

  async function remove(k: TrackedKeyword): Promise<void> {
    try {
      await untrackKeyword(k.id);
      ctx.toast(`Stopped tracking “${k.keyword}”.`);
      await reload();
    } catch (err) {
      ctx.toast(readableError(err));
    }
  }

  function renderTracked(): void {
    const polled = trackedKeywords.filter((k) => k.polledAt !== null);
    const ranked = polled.filter((k) => k.position !== null);
    const average =
      ranked.length > 0 ? Math.round((ranked.reduce((sum, k) => sum + (k.position ?? 0), 0) / ranked.length) * 10) / 10 : null;

    trackedWrap.replaceChildren(
      el('header', {}, [
        el('h3', {}, ['Tracked keywords']),
        el('span', { class: 'num muted' }, [String(trackedKeywords.length)]),
      ]),
      loadError
        ? el('div', { class: 'errbox' }, [loadError])
        : trackedKeywords.length === 0
        ? el('div', { class: 'emptybox' }, [
            'Nothing tracked yet. Track a keyword below and its position is polled every week.',
          ])
        : el('div', {}, [
            el('div', { class: 'kw-summary num' }, [
              average === null
                ? `${trackedKeywords.length} tracked · waiting for the first poll`
                : `${ranked.length} of ${polled.length} polled keywords rank · average position ${average}`,
            ]),
            el('div', { class: 'kw-list' }, trackedKeywords.map((k) => trackedRow(k, (x) => void remove(x)))),
          ]),
    );
  }

  /**
   * Search Console already knows which queries this site nearly ranks for —
   * `withinReach` is non-brand, position 4-20, with real impressions. Offering
   * those beats an empty field, which is what this screen used to be.
   */
  function renderSuggestions(): void {
    const search = traffic?.search;
    if (!search) {
      suggestWrap.replaceChildren(
        el('header', {}, [el('h3', {}, ['Suggestions from Search Console'])]),
        el('div', { class: 'notebox' }, [
          'Connect Google Search Console and Engine will suggest the queries this site nearly ranks for.',
        ]),
      );
      return;
    }
    const pool: SearchQueryRow[] = [...search.withinReach, ...search.topQueries];
    const seen = new Set<string>();
    const candidates = pool
      .filter((q) => {
        const key = q.query.toLowerCase();
        if (seen.has(key) || isTracked(q.query)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, SUGGESTION_LIMIT);

    suggestWrap.replaceChildren(
      el('header', {}, [
        el('h3', {}, ['Suggestions from Search Console']),
        el('span', { class: 'kw-country-wrap' }, [el('span', { class: 'label' }, ['Track for']), suggestCountry]),
      ]),
      candidates.length === 0
        ? el('div', { class: 'emptybox' }, ['Every query Search Console suggests is already tracked.'])
        : el('div', { class: 'kw-list' }, candidates.map((q) => {
            const btn = el('button', { class: 'frow-act' }, ['Track']);
            btn.addEventListener('click', async () => {
              btn.setAttribute('disabled', 'true');
              btn.textContent = 'Adding…';
              try {
                await add(q.query, suggestCountry.value);
              } catch (err) {
                ctx.toast(readableError(err));
                btn.removeAttribute('disabled');
                btn.textContent = 'Track';
              }
            });
            return el('div', { class: 'kw-row' }, [
              el('div', { class: 'kw-main' }, [
                el('div', { class: 't' }, [q.query]),
                el('div', { class: 'm num' }, [
                  `${q.impressions} impressions · position ${Math.round(q.position * 10) / 10}`,
                ]),
              ]),
              el('span', { class: 'kw-pos num none' }, ['not tracked']),
              el('span', { class: 'kw-change num unknown' }, ['']),
              btn,
            ]);
          })),
    );
  }

  // ---- the live lookup, unchanged except that a result can now be tracked ----
  const kw = el('input', { class: 'field', type: 'text', placeholder: 'keyword, e.g. best crm for small business' }) as HTMLInputElement;
  const domain = el('input', { class: 'field grow', type: 'text', placeholder: 'your domain (optional), e.g. acme.com' }) as HTMLInputElement;
  const country = el('select', { class: 'field' }, COUNTRIES.map((c) => el('option', { value: c }, [c]))) as HTMLSelectElement;
  const out = el('div', { class: 'serp-out' });

  async function run(): Promise<void> {
    const keyword = kw.value.trim();
    if (!keyword) { kw.focus(); return; }
    clear(out);
    out.append(el('div', { class: 'loading num' }, [`querying Google for “${keyword}”…`]));
    try {
      const res = await rankPoll(keyword, country.value);
      const trackBtn = isTracked(keyword) ? null : el('button', { class: 'btn' }, ['Track this keyword']);
      trackBtn?.addEventListener('click', async () => {
        trackBtn.setAttribute('disabled', 'true');
        trackBtn.textContent = 'Adding…';
        try {
          await add(keyword, country.value);
          trackBtn.textContent = 'Tracked ✓';
        } catch (err) {
          ctx.toast(readableError(err));
          trackBtn.removeAttribute('disabled');
          trackBtn.textContent = 'Track this keyword';
        }
      });
      clear(out);
      out.append(resultBlock(res, domain.value, trackBtn));
    } catch (err) {
      clear(out);
      out.append(el('div', { class: 'errbox' }, [readableError(err)]));
    }
  }

  const go = el('button', { class: 'btn primary', onclick: run }, ['Check now']);
  kw.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') void run(); });

  renderTracked();
  renderSuggestions();

  root.append(
    el('div', { class: 'pagehead' }, [
      el('h1', {}, [screenName('rankings')]),
      el('p', { html: 'Where this site stands in Google for the keywords you track, polled on a schedule — and a live check for any keyword, including whether Google is answering with an <b>AI Overview</b>.' }),
    ]),
    trackedWrap,
    suggestWrap,
    el('section', { class: 'panel' }, [
      el('header', {}, [el('h3', {}, ['Check a keyword now'])]),
      el('div', { class: 'serp-form' }, [
        kw,
        el('div', { class: 'serp-form-row' }, [domain, country, go]),
      ]),
    ]),
    out,
  );
  return root;
}
