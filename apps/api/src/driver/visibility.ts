/**
 * The four tools about where the brand appears — in search results, and in what
 * AI assistants say.
 *
 * These tables are keyed by `entity_id`, not `project_id`, so every query here
 * joins through `entities` and filters on `entities.project_id`. That join is
 * the tenancy boundary for this file: a query that reached `serp_positions` by
 * entity id alone would happily return another account's rankings. The db tests
 * assert it with a second project's rows present in the same database.
 *
 * `ai_citations` is where §4.2 rule 4 lives. A citation rate is a confidence
 * band over a handful of samples, and `wilsonInterval` is the same function the
 * scoring package uses to produce the bands the rest of the product stores. The
 * band is returned whole; nothing here flattens it to `point`, because a model
 * handed `{low, point, high}` will quote the point and a model handed a single
 * number has no choice.
 */
import { wilsonInterval } from '@engine/scoring';
import {
  intArg,
  noDataYet,
  ok,
  strArg,
  zero,
  type ToolHandler,
} from './context.js';

/** `days` back from today, as an ISO date. Poll data is event-shaped, not a daily series. */
function since(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/* ── keyword_positions ────────────────────────────────────────────────────── */

export const keywordPositions: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 90);
  const max = intArg(args, 'limit', 25);
  const keyword = strArg(args, 'keyword');
  const tables = ['serp_positions', 'keyword_configs', 'entities'];
  const from = since(days);

  // The configured keywords are the spine: a keyword that is tracked but never
  // polled has to appear with a null position and say so, and a left join from
  // configs to the latest poll is the only shape that produces that row.
  const rows = await ctx.db<
    {
      keyword: string;
      entity: string;
      engine: string;
      geo_country: string;
      device: string;
      position: number | null;
      url: string | null;
      features: string[] | null;
      polled_at: string | null;
    }[]
  >`
    select kc.keyword, e.canonical_name as entity, kc.engine, kc.geo_country, kc.device,
           sp.position, sp.url, sp.features, sp.polled_at::text as polled_at
    from keyword_configs kc
    join entities e on e.id = kc.entity_id
    left join lateral (
      select position, url, features, polled_at
      from serp_positions p
      where p.entity_id = kc.entity_id and p.keyword = kc.keyword
        and p.engine = kc.engine and p.device = kc.device and p.geo_country = kc.geo_country
        and p.polled_at >= ${from}
      order by p.polled_at desc
      limit 1
    ) sp on true
    where e.project_id::text = ${ctx.projectId}
      and (${keyword ?? null}::text is null or lower(kc.keyword) = lower(${keyword ?? null}))
    order by (sp.position is null), sp.position asc nulls last, kc.keyword
    limit ${max}
  `;

  const positions = rows.map((r) => ({
    keyword: r.keyword,
    entity: r.entity,
    engine: r.engine,
    country: r.geo_country,
    device: r.device,
    // Three outcomes, and they are different sentences to a customer: a number,
    // "polled and not found", and "never polled". Collapsing the last two into
    // "not ranking" claims a measurement that was never taken.
    position: r.position ?? null,
    url: r.url ?? null,
    features: r.features ?? [],
    polledAt: r.polled_at,
    outcome: r.polled_at === null ? 'never-polled' : r.position === null ? 'not-found' : 'ranked',
  }));

  const data = { positions, keywordFilter: keyword ?? null, polledSince: from };
  const provenance = { tables, period: { from, to: new Date().toISOString().slice(0, 10) } };

  if (positions.length === 0) {
    const [{ n }] = await ctx.db<{ n: string }[]>`
      select count(*)::text as n from keyword_configs kc
      join entities e on e.id = kc.entity_id where e.project_id::text = ${ctx.projectId}
    `;
    const tracked = Number(n);
    return tracked === 0
      ? noDataYet(data, provenance, {
          reason: 'No keywords are being tracked for this project, so nothing has ever been polled.',
          action: 'Add keywords to track on the Keywords screen.',
        })
      : zero(data, provenance, {
          reason: keyword
            ? `"${keyword}" is not one of the ${tracked} keywords tracked for this project.`
            : `${tracked} keywords are tracked but none matched.`,
          action: 'Call tracked_keywords to see exactly which keywords are being polled.',
        });
  }

  return positions.every((p) => p.outcome === 'never-polled')
    ? noDataYet(data, provenance, {
        reason: `${positions.length} keywords are tracked but none has been polled in the last ${days} days.`,
        action: 'Run a live rank check, or wait for the scheduled poll set by the account cadence.',
      })
    : ok(data, provenance);
};

/* ── tracked_keywords ─────────────────────────────────────────────────────── */

export const trackedKeywords: ToolHandler = async (ctx, args) => {
  const max = intArg(args, 'limit', 50);
  const tables = ['keyword_configs', 'entities', 'serp_positions'];

  const rows = await ctx.db<
    {
      keyword: string;
      entity: string;
      engine: string;
      geo_country: string;
      geo_city: string | null;
      device: string;
      language: string;
      cadence: string;
      created_at: string;
      last_polled_at: string | null;
    }[]
  >`
    select kc.keyword, e.canonical_name as entity, kc.engine, kc.geo_country, kc.geo_city,
           kc.device, kc.language, kc.cadence, kc.created_at::text as created_at,
           (select max(p.polled_at)::text from serp_positions p
             where p.entity_id = kc.entity_id and p.keyword = kc.keyword) as last_polled_at
    from keyword_configs kc
    join entities e on e.id = kc.entity_id
    where e.project_id::text = ${ctx.projectId}
    order by kc.keyword
    limit ${max}
  `;

  const keywords = rows.map((r) => ({
    keyword: r.keyword,
    entity: r.entity,
    engine: r.engine,
    country: r.geo_country,
    city: r.geo_city,
    device: r.device,
    language: r.language,
    cadence: r.cadence,
    trackedSince: r.created_at,
    lastPolledAt: r.last_polled_at,
  }));

  const data = { keywords, count: keywords.length };
  const provenance = { tables };

  return keywords.length > 0
    ? ok(data, provenance)
    : noDataYet(data, provenance, {
        reason: 'No keywords are configured for this project.',
        action:
          'Add keywords on the Keywords screen. Until then there is nothing to poll and ' +
          'keyword_positions will stay empty.',
      });
};

/* ── ai_citations ─────────────────────────────────────────────────────────── */

interface SampleRow {
  engine: string;
  cited: boolean;
  model: string | null;
  method: string;
  sampled_at: string;
}

export const aiCitations: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 90);
  const entity = strArg(args, 'entity');
  const tables = ['citation_events', 'answer_mentions', 'entities'];
  const from = since(days);
  const to = new Date().toISOString().slice(0, 10);
  const period = { from, to };

  const entities = await ctx.db<{ id: string; canonical_name: string }[]>`
    select id, canonical_name from entities
    where project_id::text = ${ctx.projectId}
      and (${entity ?? null}::text is null or lower(canonical_name) = lower(${entity ?? null}))
    order by created_at
  `;

  if (entities.length === 0) {
    return noDataYet({ samples: [] }, { tables, period }, {
      reason: entity
        ? `No tracked entity named "${entity}" exists in this project.`
        : 'This project has no tracked entities, so no AI prompts are being sampled.',
      action: 'Add the brand as an entity so its prompts can be polled.',
    });
  }

  const target = entities[0]!;
  const [samples, mentions] = await Promise.all([
    ctx.db<SampleRow[]>`
      select engine, cited, model, method, sampled_at::text as sampled_at
      from citation_events
      where entity_id = ${target.id} and sampled_at >= ${from}
      order by sampled_at desc
    `,
    ctx.db<{ brand: string; is_self: boolean; source: string; n: string }[]>`
      select am.brand, am.is_self, am.source, count(*)::text as n
      from answer_mentions am
      join citation_events ce on ce.id = am.citation_event_id
      where ce.entity_id = ${target.id} and ce.sampled_at >= ${from}
      group by am.brand, am.is_self, am.source
      order by count(*) desc, am.brand
      limit 50
    `,
  ]);

  const n = samples.length;
  const cited = samples.filter((s) => s.cited).length;

  // The band, not the point. `wilsonInterval` is the same function that produced
  // every stored band in this product, so Driver's figure and the Pulse panel's
  // figure are the same measurement rather than two estimates that agree.
  const band = wilsonInterval(cited, n);

  const byEngine = [...new Set(samples.map((s) => s.engine))].map((engineName) => {
    const forEngine = samples.filter((s) => s.engine === engineName);
    const citedHere = forEngine.filter((s) => s.cited).length;
    return {
      engine: engineName,
      samples: forEngine.length,
      cited: citedHere,
      citationRate: wilsonInterval(citedHere, forEngine.length),
    };
  });

  const data = {
    entity: target.canonical_name,
    period,
    samples: n,
    cited,
    /** A band, always. Never report `point` on its own. */
    citationRate: band,
    byEngine,
    brandsNamedAlongside: mentions
      .filter((m) => !m.is_self)
      .map((m) => ({ brand: m.brand, timesNamed: Number(m.n), matchedBy: m.source })),
    note:
      'The citation rate is a confidence band over ' +
      `${n} samples, not a percentage. Quote the range and the sample count together; a point ` +
      'estimate would claim precision this sampling does not support.',
  };
  const provenance = { tables, period, sampleCount: n };

  if (n === 0) {
    return noDataYet(data, provenance, {
      reason: `No AI answers have been sampled for ${target.canonical_name} in the last ${days} days.`,
      action:
        'Check that prompts are configured for this entity, and that the AI poll cadence has run ' +
        'at least once. Until then there is no measurement, which is different from a citation rate of zero.',
    });
  }

  return cited === 0
    ? zero(data, provenance, {
        reason: `${target.canonical_name} was not named in any of the ${n} sampled answers. With ${n} samples the true rate could still be as high as ${(band.high * 100).toFixed(0)}%.`,
        action:
          'This is a real measurement. Use entity_strength and cited_domains to see what would make ' +
          'an assistant more likely to name the brand.',
      })
    : ok(data, provenance);
};

/* ── cited_domains ────────────────────────────────────────────────────────── */

export const citedDomains: ToolHandler = async (ctx, args) => {
  const days = intArg(args, 'days', 90);
  const max = intArg(args, 'limit', 20);
  const tables = ['citation_events', 'entities'];
  const from = since(days);
  const to = new Date().toISOString().slice(0, 10);
  const period = { from, to };

  // `sources_cited` is a text[] of URLs. Unnesting and reducing to a host is
  // done in SQL so the row count stays bounded; the substring is a host
  // extraction, not a parse, and a malformed entry simply groups under itself.
  const [rows, [totals]] = await Promise.all([
    ctx.db<{ domain: string; mentions: string; answers: string }[]>`
      select lower(regexp_replace(regexp_replace(src, '^https?://', ''), '(^www\\.)|(/.*$)', '', 'g')) as domain,
             count(*)::text as mentions,
             count(distinct ce.id)::text as answers
      from citation_events ce
      join entities e on e.id = ce.entity_id
      cross join lateral unnest(ce.sources_cited) as src
      where e.project_id::text = ${ctx.projectId} and ce.sampled_at >= ${from} and src <> ''
      group by 1
      order by count(*) desc, 1
      limit ${max}
    `,
    ctx.db<{ n: string }[]>`
      select count(*)::text as n from citation_events ce
      join entities e on e.id = ce.entity_id
      where e.project_id::text = ${ctx.projectId} and ce.sampled_at >= ${from}
    `,
  ]);

  const sampled = Number(totals?.n ?? 0);
  const domains = rows.map((r) => ({
    domain: r.domain,
    timesCited: Number(r.mentions),
    inAnswers: Number(r.answers),
  }));

  const data = {
    period,
    domains,
    answersSampled: sampled,
    note: 'These are counts across sampled AI answers, not traffic. A domain cited often is a source assistants consult about this market.',
  };
  const provenance = { tables, period, sampleCount: sampled };

  if (sampled === 0) {
    return noDataYet(data, provenance, {
      reason: `No AI answers have been sampled for this project in the last ${days} days.`,
      action: 'Configure prompts for the tracked entity and let the AI poll run.',
    });
  }

  return domains.length > 0
    ? ok(data, provenance)
    : zero(data, provenance, {
        reason: `${sampled} answers were sampled and none of them cited any source at all.`,
        action:
          'Some engines answer without citing sources. Call ai_citations to see which engines were ' +
          'sampled and whether the brand was named.',
      });
};

export const VISIBILITY_HANDLERS = {
  keyword_positions: keywordPositions,
  tracked_keywords: trackedKeywords,
  ai_citations: aiCitations,
  cited_domains: citedDomains,
} satisfies Record<string, ToolHandler>;
