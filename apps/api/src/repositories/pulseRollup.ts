import {
  organicSov,
  aiSov,
  citationBandFromSamples,
  type OrganicKeywordRow,
  type CitationSample,
} from '@engine/scoring';
import type { CitationMeasurement, ConfidenceBand } from '@engine/core';
import type { SurfaceScores, ChannelMix } from '@engine/scoring';
import { listEntitiesByProject } from './entities.js';
import { latestPositionsByEntity } from './rankPositions.js';
import { citationEventsByEntity, type CitationEventRow } from './citationEvents.js';
import type { Db } from '../db.js';

/**
 * Assemble the A3 `SurfaceScores` a project actually has data for, plus the
 * `ChannelMix` weights to blend them with (§1 unified.ts). This is the
 * repository M1.2 has been waiting on: until migration 0005, `POST /pulse`
 * could only compute the score from surfaces the *caller* supplied, because
 * nothing persisted A1/A2 results for a server-side rollup to read.
 *
 * Local (B5) has no data source yet — B5 is Phase-2 scope — so it is left out
 * of the mix entirely (weight 0) rather than scored as 0. Scoring it 0 would
 * assert "no local visibility," which is a different claim than "not
 * measured"; `unifiedVisibilityScore`'s `normalize()` renormalizes the
 * remaining organic/ai weights automatically when local's weight is 0, so the
 * two real surfaces still sum to a full-weight blend.
 */
export async function assembleSurfaceScores(
  db: Db,
  projectId: string,
  baseMix: ChannelMix,
  sinceDays = 30,
): Promise<{ surfaces: SurfaceScores; mix: ChannelMix; keywordsTracked: number; citationSamples: number }> {
  // Self only. This walks every entity and sums their positions and citations
  // into one score; a competitor row here would fold a rival's performance
  // into the customer's own number, silently and plausibly.
  const entities = await listEntitiesByProject(db, projectId, 'self');

  const organicRows: OrganicKeywordRow[] = [];
  const citationRows: CitationEventRow[] = [];
  for (const entity of entities) {
    const [positions, citations] = await Promise.all([
      latestPositionsByEntity(db, entity.id, sinceDays),
      citationEventsByEntity(db, entity.id, sinceDays),
    ]);
    for (const p of positions) {
      // Null volume (A4 keyword research isn't wired) contributes an equal
      // weight of 1 rather than 0 -- a keyword with unknown demand still
      // counts, instead of vanishing from the score entirely.
      organicRows.push({ keyword: p.keyword, position: p.position, volume: p.volume ?? 1 });
    }
    citationRows.push(...citations);
  }

  const organic = organicSov(organicRows);
  const ai = aiFromRows(citationRows);
  const mix: ChannelMix = { organic: baseMix.organic, ai: baseMix.ai, local: 0 };

  return {
    surfaces: { organic, ai, local: 0 },
    mix,
    keywordsTracked: organicRows.length,
    citationSamples: citationRows.length,
  };
}

/**
 * Group raw citation-event samples by (engine, prompt) -- `citationBandFromSamples`
 * operates on one group's trials at a time -- turn each group into a
 * `CitationMeasurement`, then blend across the whole set with `aiSov`. Method
 * is carried from the samples themselves rather than assumed: a group is
 * `reconciled` only once both API and consumer capture exist for it (A2.7),
 * which this rollup doesn't yet distinguish, so it reports the group's own
 * stored method verbatim (they don't currently mix within a group).
 *
 * Grouped on a JSON-encoded key rather than a joined string: prompts are
 * free-text and routinely contain spaces, so a space-joined key would merge
 * distinct (engine, prompt) pairs whenever a prompt's own space landed where
 * the key's delimiter did.
 */
export function aiFromRows(rows: readonly CitationEventRow[]): ConfidenceBand {
  const groups = new Map<string, { engine: string; prompt: string; rows: CitationEventRow[] }>();
  for (const row of rows) {
    const key = JSON.stringify([row.engine, row.prompt]);
    const group = groups.get(key);
    if (group) group.rows.push(row);
    else groups.set(key, { engine: row.engine, prompt: row.prompt, rows: [row] });
  }

  const measurements: CitationMeasurement[] = [];
  for (const { engine, prompt, rows: group } of groups.values()) {
    const samples: CitationSample[] = group.map((g) => ({ cited: g.cited }));
    measurements.push({
      engine,
      prompt,
      nSamples: samples.length,
      citationRate: citationBandFromSamples(samples),
      method: group[0].method,
      measuredAt: group[0].sampled_at.toISOString(),
    });
  }

  return aiSov(measurements);
}
