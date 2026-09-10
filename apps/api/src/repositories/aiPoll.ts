/**
 * The scheduled A2 AI-answer poll.
 *
 * `POST /projects/:id/ai/poll` has existed since M1.1 and `citation_events`
 * since migration 0005, but nothing ever called the route on a schedule and
 * nothing ever wrote `entities.prompts` — so the table stayed empty and the
 * visibility score's AI surface was null for every customer. This asks each
 * entity's prompt bank of every configured engine and stores the samples.
 *
 * The engines are platform-owned (one `SARVAM_API_KEY` for every client), so
 * unlike the rank poll there is no per-account key to resolve and no keyring
 * to open. The cost is ours, which is why the cap below is on prompts polled
 * per run rather than on anything the customer controls.
 */
import { createLlmConnectors, isLlmCompleter, type LlmCompleter, type LlmEngineConnector, type PromptQuery } from '@engine/connectors';
import { insertCitationEvents, type StoredSample } from './citationEvents.js';
import { listKnownBrands, mineMentions, recordMentions, type KnownBrand } from './answerMentions.js';
import { CADENCE_WINDOW_HOURS, effectiveCadence, type CadenceOverride, type PlanTier } from '@engine/core';
import type { Db } from '../db.js';

export interface AiPollEnv {
  SARVAM_API_KEY?: string;
  SARVAM_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

interface DuePromptRow {
  entity_id: string;
  project_id: string;
  canonical_name: string;
  domain: string;
  urls: string[];
  prompt: string;
}

export interface ScheduledAiPollSummary {
  attempted: number;
  polled: number;
  samplesStored: number;
  failed: { projectId: string; prompt: string; error: string }[];
  /** True when the run stopped at `cap` with more prompts still due. */
  capped: boolean;
  engines: string[];
}

/**
 * The cron expression that selects this pass, matched against
 * `wrangler.toml`'s `[triggers]` byte for byte. It lives here rather than in
 * the Worker entry module for the same reason `RANK_POLL_CRON` does: only
 * handlers may be named exports there, and a string constant makes the Worker
 * refuse to start at runtime with nothing failing at build time.
 */
export const AI_POLL_CRON = '0 5 * * *';

/**
 * The model the poll measures with (issue 16, decided 2026-09-10).
 *
 * The conversational model, not the reasoning one. Measured on three category
 * prompts on 2026-09-09: `sarvam-105b` named a company in one of the three
 * while `sarvam-105b-conversations` named companies in all three. A citation
 * rate over answers that name nobody cannot move, and a metric that cannot
 * vary is not a metric. #93 stores the model on every sample, so bands from
 * before and after this switch are reported apart rather than pooled.
 *
 * `SARVAM_MODEL` still overrides it, as a deployment-level escape hatch; a
 * change there is a change of instrument and shows up as a new band.
 */
export const AI_POLL_MODEL = 'sarvam-105b-conversations';

/** The env the poll builds its connectors from: the deployment's, with the poll's model filled in. */
export function aiPollConnectorEnv(env: AiPollEnv): Record<string, string | undefined> {
  return { ...(env as Record<string, string | undefined>), SARVAM_MODEL: env.SARVAM_MODEL ?? AI_POLL_MODEL };
}

/** n samples per (prompt, engine) — A2's n=3-5, at the low end because each
 * Sarvam call spends a 16,000-token reasoning budget. */
export const AI_POLL_SAMPLES = 3;

/**
 * A cap on prompts per run. Each prompt costs `AI_POLL_SAMPLES` calls per
 * engine, and a Sarvam call draws a 16,000-token budget, so an account that
 * pasted forty prompts across ten entities would otherwise spend far more in
 * one night than the schedule intends. The rest are picked up by the next run,
 * least recently sampled first, so nothing is starved — it is only delayed.
 */
export const DEFAULT_AI_POLL_CAP = 40;

/**
 * How many prompts one brand may track.
 *
 * Every prompt is `AI_POLL_SAMPLES` model calls per engine on every weekly
 * pass, so this is a cost ceiling rather than a UI preference. Twenty prompts
 * is already 60 Sarvam calls a week for one brand.
 */
export const MAX_PROMPTS_PER_ENTITY = 20;

/** A prompt is a question someone would type, not a document. */
export const MAX_PROMPT_LENGTH = 300;

/**
 * The window the AI answers screen reports over. Matches the poll's weekly
 * cadence at 4 samples deep: shorter and a weekly prompt would show one
 * sample, which is a band from 0% to 79% and tells a customer nothing.
 */
export const AI_VISIBILITY_LOOKBACK_DAYS = 30;

/**
 * The (entity, prompt) pairs whose weekly sample is due, least recently
 * sampled first.
 *
 * Weekly on paid tiers and monthly on the free tier, per the account's
 * effective cadence (issue 10): an AI answer to "what is payroll data api"
 * does not move between Tuesday and Wednesday, and each sample is three model
 * calls. Each window is short of its nominal period for the reason the rank
 * poll's daily window is 20 hours — a cron fires with drift, and requiring a
 * full 7 days turns a weekly prompt into an every-eighth-day one.
 *
 * Due-ness is decided per prompt across all engines rather than per (prompt,
 * engine): the engines are polled together in one pass, so a per-engine window
 * would only matter if one engine failed, and in that case retrying its prompt
 * the next night is what should happen anyway.
 *
 * `unnest` is used rather than a join table because the prompt bank is an
 * array column on `entities` (migration 0001), not a table of its own. It is
 * aliased `pr(prompt)` and referenced qualified: an unqualified `prompt`
 * inside the lateral resolves to `citation_events.prompt`, the innermost
 * scope, which makes the join condition `ce.prompt = ce.prompt` — always
 * true, so every prompt would look sampled and nothing would ever be due.
 */
export async function listDuePrompts(db: Db, cap = DEFAULT_AI_POLL_CAP): Promise<DuePromptRow[]> {
  // Every prompt with its last sample and its account's cadence inputs; the
  // window is decided in code from the effective policy (issue 10), because
  // the tier defaults live in `@engine/core` and a second copy in SQL would
  // drift from them.
  const rows = await db<
    (DuePromptRow & {
      sampled_at: Date | null;
      plan_tier: PlanTier | null;
      rank_poll: CadenceOverride['rankPoll'] | null;
      ai_poll: CadenceOverride['aiPoll'] | null;
      crawl: CadenceOverride['crawl'] | null;
      has_override: boolean;
    })[]
  >`
    select e.id as entity_id, p.id as project_id, e.canonical_name, p.domain, e.urls, pr.prompt,
           last.sampled_at,
           s.plan_tier, c.rank_poll, c.ai_poll, c.crawl, (c.account_id is not null) as has_override
    from entities e
    join projects p on p.id = e.project_id
    left join subscriptions s on s.account_id = p.account_id
    left join account_cadence c on c.account_id = p.account_id
    cross join unnest(e.prompts) as pr(prompt)
    left join lateral (
      select max(ce.sampled_at) as sampled_at
      from citation_events ce
      where ce.entity_id = e.id and ce.prompt = pr.prompt
    ) last on true
    order by last.sampled_at asc nulls first, e.created_at asc, pr.prompt asc
  `;
  const now = Date.now();
  const due: DuePromptRow[] = [];
  for (const r of rows) {
    const override = r.has_override ? { rankPoll: r.rank_poll, aiPoll: r.ai_poll, crawl: r.crawl } : null;
    const cadence = effectiveCadence(r.plan_tier ?? 'free', override).policy.aiPoll;
    const windowMs = CADENCE_WINDOW_HOURS[cadence] * 3_600_000;
    if (r.sampled_at && now - new Date(r.sampled_at).getTime() < windowMs) continue;
    due.push({
      entity_id: r.entity_id,
      project_id: r.project_id,
      canonical_name: r.canonical_name,
      domain: r.domain,
      urls: r.urls,
      prompt: r.prompt,
    });
    if (due.length >= cap) break;
  }
  return due;
}

/**
 * What counts as "the brand was cited" for one entity.
 *
 * The project domain and any URLs on the entity match cited source hosts; the
 * canonical name matches the answer text. The name matters most here: Sarvam
 * does not browse, so an answer rarely carries a URL at all, and without the
 * name target every sample would be recorded as not cited regardless of what
 * the model said.
 */
export function citationTargets(row: Pick<DuePromptRow, 'canonical_name' | 'domain' | 'urls'>): string[] {
  return [...new Set([row.domain, ...row.urls, row.canonical_name].map((t) => t.trim()).filter(Boolean))];
}

/**
 * Poll every due prompt against every configured engine and store the samples.
 *
 * One failure does not abort the pass, for the same reason the rank poll's
 * does not: a prompt that trips the connector's truncation guard must not stop
 * every other customer's prompts from being sampled, which is what an uncaught
 * throw in a scheduled handler does.
 */
export async function runScheduledAiPoll(
  db: Db,
  env: AiPollEnv,
  cap = DEFAULT_AI_POLL_CAP,
  nSamples = AI_POLL_SAMPLES,
): Promise<ScheduledAiPollSummary> {
  const connectors: LlmEngineConnector[] = createLlmConnectors(aiPollConnectorEnv(env));
  const summary: ScheduledAiPollSummary = {
    attempted: 0,
    polled: 0,
    samplesStored: 0,
    failed: [],
    capped: false,
    engines: connectors.map((c) => c.engine),
  };
  if (connectors.length === 0) return summary;

  const due = await listDuePrompts(db, cap);
  summary.capped = due.length === cap;
  if (due.length === 0) return summary;

  // The extraction pass asks the same engine which companies each answer
  // names. One connector offers completions here; without one, only the
  // deterministic pass runs and share of voice covers tracked brands alone.
  const extractor = pickExtractor(connectors);
  const brandsByProject = new Map<string, KnownBrand[]>();

  for (const row of due) {
    summary.attempted++;
    const query: PromptQuery = {
      prompt: row.prompt,
      entityId: row.entity_id,
      citationTargets: citationTargets(row),
    };
    // Per engine, not per prompt: one engine's outage should cost that
    // engine's sample, not the sample the other engine already produced.
    let stored = 0;
    for (const connector of connectors) {
      try {
        const result = await connector.poll(query, nSamples);
        const samples = await insertCitationEvents(db, [result]);
        stored += result.samples.length;
        await mineStoredSamples(db, row.project_id, samples, extractor, brandsByProject);
      } catch (error) {
        summary.failed.push({
          projectId: row.project_id,
          prompt: row.prompt,
          error: `${connector.engine}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    if (stored > 0) {
      summary.polled++;
      summary.samplesStored += stored;
    }
  }
  return summary;
}

/**
 * Attach mentions to freshly stored samples: tracked brands by matching, the
 * rest by asking the model. A failure here is logged into the summary by the
 * caller's catch and costs the mentions, never the sample — the cited share
 * is already stored.
 */
export async function mineStoredSamples(
  db: Db,
  projectId: string,
  samples: readonly StoredSample[],
  extractor: LlmCompleter | null,
  cache: Map<string, KnownBrand[]> = new Map(),
): Promise<void> {
  let brands = cache.get(projectId);
  if (!brands) {
    brands = await listKnownBrands(db, projectId);
    cache.set(projectId, brands);
  }
  for (const sample of samples) {
    const mentions = await mineMentions(sample.answerText, brands, extractor);
    await recordMentions(db, sample.id, mentions);
  }
}

/** The first connector that can answer a bare instruction, or null. */
export function pickExtractor(connectors: readonly LlmEngineConnector[]): LlmCompleter | null {
  for (const c of connectors) if (isLlmCompleter(c)) return c;
  return null;
}
