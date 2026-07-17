import type { LlmAnswerResult } from '@engine/connectors';
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
          (entity_id, engine, prompt, cited, sources_cited, sentiment, accuracy, method, raw_answer_ref, sampled_at)
        values (
          ${r.query.entityId}, ${r.engine}, ${r.query.prompt}, ${s.citation.cited}, ${s.citation.sourcesCited},
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
