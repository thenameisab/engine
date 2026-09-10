import type { LlmAnswerResult } from '@engine/connectors';
import type { ConfidenceBand } from '@engine/core';
import { citationBandFromSamples, type CitationSample } from '@engine/scoring';
import type { Db } from '../db.js';

/**
 * Persist A2 AI-visibility poll results (migration 0005). Before this,
 * `POST /ai/poll` sampled every configured engine n=3-5x and threw the
 * samples away after responding — the n-sampling infrastructure the roadmap
 * calls "Phase-1 foundational, not a later polish" had nowhere to land.
 *
 * One row per sample (mirrors LlmAnswerSample), not per poll: aiSov/
 * citationBandFromSamples need the individual cited/not-cited trials to
 * recompute a Wilson interval over any lookback window, and collapsing to a
 * single rate at write time would bake in whatever window this poll used.
 */
export async function insertCitationEvents(db: Db, results: readonly LlmAnswerResult[]): Promise<void> {
  for (const r of results) {
    for (const s of r.samples) {
      await db`
        insert into citation_events
          (entity_id, engine, model, prompt, cited, cited_by_name, cited_by_domain,
           sources_cited, sentiment, accuracy, method, raw_answer_ref, sampled_at)
        values (
          ${r.query.entityId}, ${r.engine}, ${r.model}, ${r.query.prompt},
          ${s.citation.cited}, ${s.citation.citedByName}, ${s.citation.citedByDomain},
          ${s.citation.sourcesCited},
          ${s.citation.sentiment}, ${s.citation.accuracy}, ${r.method}, ${s.rawAnswerRef}, ${s.sampledAt}
        )
      `;
    }
  }
}

/** One stored sample, grouped by (engine, prompt) for the A3 AI-SoV rollup. */
export interface CitationEventRow {
  engine: string;
  prompt: string;
  cited: boolean;
  method: 'api' | 'consumer' | 'reconciled';
  sampled_at: Date;
}

/**
 * Every citation event for an entity within a lookback window, newest first.
 * The caller (the A3 rollup) groups these by (engine, prompt) itself, since
 * `citationBandFromSamples` operates on one group's samples at a time.
 */
export async function citationEventsByEntity(
  db: Db,
  entityId: string,
  sinceDays = 30,
): Promise<CitationEventRow[]> {
  const rows = await db<CitationEventRow[]>`
    select engine, prompt, cited, method, sampled_at
    from citation_events
    where entity_id = ${entityId} and sampled_at >= now() - (${sinceDays}::text || ' days')::interval
    order by sampled_at desc
  `;
  return rows;
}

/** Cited share for one (engine, model) pair, as a Wilson band over its samples. */
export interface EngineCitedShare {
  engine: string;
  /**
   * The vendor model, or null for samples stored before migration 0025.
   *
   * Its own group rather than merged into the engine's: a vendor's models
   * disagree, so pooling them would report a change of instrument as a change
   * in the brand. A null is rendered as "not recorded", never folded into a
   * model that happens to be current.
   */
  model: string | null;
  prompts: number;
  samples: number;
  cited: number;
  /** Wilson 95% band over `cited`/`samples` — never a bare point estimate. */
  band: ConfidenceBand;
  /**
   * Of `samples`, how many named the brand in the answer text, and how many
   * carried a source URL on the brand's own domain. Counted apart because
   * `cited` is their union and cannot tell a mention from a link — and a
   * non-browsing engine can only ever produce the first.
   *
   * Null when no sample in the group recorded the split (pre-0025 rows).
   */
  citedByName: number | null;
  citedByDomain: number | null;
  /** How many of the samples carried any source URL at all. */
  samplesWithSources: number;
  lastSampledAt: string;
}

/**
 * Cited share per engine over a lookback window — the top half of the AI
 * answers screen.
 *
 * The band comes from `citationBandFromSamples` rather than from
 * `cited/samples`, because A2's rule is that an AI citation rate is only ever
 * shown as an interval: at n=3 a single cited answer is 33% with a band from
 * 6% to 79%, and the point on its own reads as precision the sample cannot
 * support.
 *
 * `samplesWithSources` is counted here and shown on screen because it is the
 * honest limit of this deployment: Sarvam does not browse, so it names sources
 * almost never, and a citation-opportunity panel mined from `sources_cited`
 * will be empty for reasons that have nothing to do with the customer's site.
 */
export async function citedShareByEngine(
  db: Db,
  entityId: string,
  sinceDays = 30,
): Promise<EngineCitedShare[]> {
  const rows = await db<
    {
      engine: string;
      model: string | null;
      prompt: string;
      cited: boolean;
      cited_by_name: boolean | null;
      cited_by_domain: boolean | null;
      has_sources: boolean;
      sampled_at: Date;
    }[]
  >`
    select engine, model, prompt, cited, cited_by_name, cited_by_domain,
           array_length(sources_cited, 1) is not null as has_sources,
           sampled_at
    from citation_events
    where entity_id = ${entityId} and sampled_at >= now() - (${sinceDays}::text || ' days')::interval
  `;

  interface Group {
    engine: string;
    model: string | null;
    prompts: Set<string>;
    samples: CitationSample[];
    byName: number;
    byDomain: number;
    /** How many samples in this group recorded the split at all. */
    splitKnown: number;
    withSources: number;
    last: Date;
  }

  // Keyed on both, with a sentinel for a null model: an engine's samples are
  // only comparable within one model.
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = `${r.engine}\u0000${r.model ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        engine: r.engine,
        model: r.model,
        prompts: new Set(),
        samples: [],
        byName: 0,
        byDomain: 0,
        splitKnown: 0,
        withSources: 0,
        last: r.sampled_at,
      };
      groups.set(key, g);
    }
    g.prompts.add(r.prompt);
    g.samples.push({ cited: r.cited });
    if (r.cited_by_name !== null || r.cited_by_domain !== null) {
      g.splitKnown++;
      if (r.cited_by_name) g.byName++;
      if (r.cited_by_domain) g.byDomain++;
    }
    if (r.has_sources) g.withSources++;
    if (r.sampled_at > g.last) g.last = r.sampled_at;
  }

  return [...groups.values()]
    .map((g) => ({
      engine: g.engine,
      model: g.model,
      prompts: g.prompts.size,
      samples: g.samples.length,
      cited: g.samples.filter((s) => s.cited).length,
      band: citationBandFromSamples(g.samples),
      // Null rather than 0 when nothing in the group recorded the split: "no
      // sample said" and "no sample named the brand" are different facts.
      citedByName: g.splitKnown > 0 ? g.byName : null,
      citedByDomain: g.splitKnown > 0 ? g.byDomain : null,
      samplesWithSources: g.withSources,
      lastSampledAt: g.last.toISOString(),
    }))
    .sort(
      (a, b) =>
        b.band.point - a.band.point ||
        a.engine.localeCompare(b.engine) ||
        (a.model ?? '').localeCompare(b.model ?? ''),
    );
}
