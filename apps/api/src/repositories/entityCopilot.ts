import { organicSov, type OrganicKeywordRow } from '@engine/scoring';
import type { ConfidenceBand, Finding } from '@engine/core';
import { latestPositionsByEntity } from './rankPositions.js';
import { citationEventsByEntity } from './citationEvents.js';
import { aiFromRows } from './pulseRollup.js';
import { listFindingsByEntity } from './findings.js';
import type { Db } from '../db.js';

/**
 * The M2.2 exit criterion, verbatim: "entity-first joins power a
 * cross-SEO/GEO query." Everything below is keyed on one `entity_id` —
 * `serp_positions` (A1, organic), `citation_events` (A2, AI/GEO), and
 * `findings` (B1, diagnosis) share no other column in common. A URL-keyed
 * model couldn't do this join at all: an AI answer citing a brand carries no
 * URL, and a finding is scoped to a crawled page, not a SERP row. The entity
 * is the only thing all three pillars agree on, which is exactly the bet
 * `docs/20-Architecture.md`'s "entity-first data model" made on day one.
 */
export interface EntityCopilotSummary {
  entityId: string;
  canonicalName: string;
  organic: { sov: number; keywordsTracked: number };
  ai: { band: ConfidenceBand; samplesObserved: number };
  topFindings: Finding[];
}

export async function buildEntityCopilotSummary(
  db: Db,
  entityId: string,
  canonicalName: string,
  sinceDays = 30,
): Promise<EntityCopilotSummary> {
  const [positions, citationRows, topFindings] = await Promise.all([
    latestPositionsByEntity(db, entityId, sinceDays),
    citationEventsByEntity(db, entityId, sinceDays),
    listFindingsByEntity(db, entityId, 5),
  ]);

  const organicRows: OrganicKeywordRow[] = positions.map((p) => ({
    keyword: p.keyword,
    position: p.position,
    volume: p.volume ?? 1,
  }));

  return {
    entityId,
    canonicalName,
    organic: { sov: organicSov(organicRows), keywordsTracked: organicRows.length },
    ai: { band: aiFromRows(citationRows), samplesObserved: citationRows.length },
    topFindings,
  };
}
