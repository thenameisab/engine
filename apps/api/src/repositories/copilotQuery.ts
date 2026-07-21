import {
  parseIntent,
  buildAnswer,
  unknownAnswer,
  applyPhrasing,
  templatePhrasing,
  openAiPhrasing,
  type CopilotAnswer,
  type CopilotData,
  type EntityRef,
  type PhrasingModel,
} from '@engine/copilot';
import { buildEntityCopilotSummary } from './entityCopilot.js';
import { latestPositionsByEntity } from './rankPositions.js';
import { listEntitiesByProject } from './entities.js';
import type { Db } from '../db.js';

/**
 * The M2.4 Copilot's server-side orchestration: NL question in, cited answer
 * out. Deliberately thin — the parsing (`@engine/copilot/intent`), the cited
 * answer assembly (`answer`), and the phrasing contract (`phrasing`) are all
 * pure and unit-tested in the package; this file only supplies the database
 * reads those pure functions can't do and records the latency log.
 *
 * The retrieval reuses `buildEntityCopilotSummary` — the exact M2.2
 * entity-first join — so the Copilot answers over the same A1/A2/B1 data the
 * structured summary already served, now addressable by natural language.
 */

export interface AskOptions {
  /** Present only when OpenAI credits are available; absent -> deterministic phrasing. */
  openAiApiKey?: string;
  openAiModel?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface AskResult {
  answer: CopilotAnswer;
  latencyMs: number;
  entityId?: string;
}

/**
 * Look up the most recent tracked position for one keyword under an entity.
 * Reuses the same `latestPositionsByEntity` rows the SoV rollup reads, then
 * matches the asked keyword case-insensitively. Returns `position: null` when
 * the keyword is tracked but not ranking; undefined when it isn't tracked at
 * all — the answer builder phrases those two cases differently.
 */
async function resolveKeywordRank(
  db: Db,
  entityId: string,
  keyword: string,
): Promise<{ keyword: string; position: number | null } | undefined> {
  const rows = await latestPositionsByEntity(db, entityId);
  const match = rows.find((r) => r.keyword.toLowerCase() === keyword.toLowerCase());
  if (!match) return undefined;
  return { keyword: match.keyword, position: match.position };
}

function phrasingModel(options: AskOptions): PhrasingModel {
  if (options.openAiApiKey) {
    return openAiPhrasing({ apiKey: options.openAiApiKey, model: options.openAiModel, fetchImpl: options.fetchImpl });
  }
  return templatePhrasing;
}

/**
 * Answer one NL question for a project. Resolves the entity from the project's
 * own entity list, retrieves the entity-first summary (plus a keyword rank for
 * a rank question), builds the cited answer, then applies phrasing (a no-op
 * unless OpenAI credits are configured). Persistence of the latency log is the
 * caller's job (it owns the write), so this stays a pure-ish read + compute.
 */
export async function answerQuestion(db: Db, projectId: string, question: string, options: AskOptions = {}): Promise<AskResult> {
  const started = Date.now();

  const entities = await listEntitiesByProject(db, projectId);
  const refs: EntityRef[] = entities.map((e) => ({ id: e.id, canonicalName: e.canonicalName }));
  const intent = parseIntent(question, refs);

  if (intent.type === 'unknown' || !intent.entityId) {
    const answer = unknownAnswer(question);
    return { answer, latencyMs: Date.now() - started };
  }

  const summary = await buildEntityCopilotSummary(db, intent.entityId, intent.entityName ?? '');
  const keywordRank =
    intent.type === 'keyword_rank' && intent.keyword
      ? await resolveKeywordRank(db, intent.entityId, intent.keyword)
      : undefined;

  const data: CopilotData = {
    entityId: summary.entityId,
    canonicalName: summary.canonicalName,
    organic: summary.organic,
    ai: summary.ai,
    topFindings: summary.topFindings,
    ...(keywordRank ? { keywordRank } : {}),
  };

  const built = buildAnswer(intent, data, projectId);
  const answer = await applyPhrasing(built, phrasingModel(options));

  return { answer, latencyMs: Date.now() - started, entityId: intent.entityId };
}

/** Persist one answered question for latency/coverage analytics (migration 0009). */
export async function logCopilotQuery(
  db: Db,
  projectId: string,
  question: string,
  intent: string,
  latencyMs: number,
  entityId?: string,
): Promise<void> {
  await db`
    insert into copilot_queries (project_id, entity_id, question, intent, latency_ms)
    values (${projectId}, ${entityId ?? null}, ${question}, ${intent}, ${latencyMs})
  `;
}
