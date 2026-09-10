/**
 * The scheduled A1 rank poll.
 *
 * `POST /projects/:id/rank/poll` has existed since M1.1, and `keyword_configs`
 * has been writable since A4's push route, but nothing ever called either on a
 * schedule — so `serp_positions` accumulated no history and the visibility
 * score's organic surface stayed null for every customer. This drains the
 * tracked keywords that are due and writes their positions.
 *
 * Runs against whichever Serper key the client's account resolves to
 * (`resolveSerpKey`), so a client on their own key spends their own credit and
 * a client on ours spends ours.
 */
import { createSerpConnector, type SerpQuery } from '@engine/connectors';
import { loadKeyring, type Keyring } from '@engine/integrations';
import { insertSerpPositions } from './rankPositions.js';
import { recordCompetitorStandings } from './competitor.js';
import { resolveSerpKey } from './serpKey.js';
import type { Db } from '../db.js';

export interface RankPollEnv {
  SERPER_API_KEY?: string;
  SERP_PROVIDER?: string;
  ENCRYPTION_KEY?: string;
  ENCRYPTION_KEYS?: string;
}

interface DueRow {
  id: string;
  entity_id: string;
  project_id: string;
  account_id: string;
  domain: string;
  keyword: string;
  geo_country: string;
  geo_city: string | null;
  geo_postcode: string | null;
  device: SerpQuery['device'];
  language: string;
  engine: SerpQuery['engine'];
}

export interface ScheduledRankPollSummary {
  attempted: number;
  polled: number;
  failed: { projectId: string; keyword: string; error: string }[];
  /** True when the run stopped at `cap` with more keywords still due. */
  capped: boolean;
}

/**
 * A cap on lookups per run. Serper bills per lookup, and the platform key is a
 * prepaid balance shared by every client on the fallback, so a mistake in a
 * cadence or a customer tracking a thousand keywords must not be able to drain
 * it overnight. Hitting the cap is logged; the rest are picked up by the next
 * run, oldest first.
 */
export const DEFAULT_RANK_POLL_CAP = 200;

/**
 * The cron expression that selects this pass, matched against
 * `wrangler.toml`'s `[triggers]` byte for byte. It lives here rather than in
 * the Worker entry module because only handlers may be named exports there —
 * the runtime refuses a string with "Incorrect type for map entry" and the
 * Worker fails to start, which no build or typecheck catches.
 */
export const RANK_POLL_CRON = '30 4 * * *';

/**
 * The tracked keywords whose cadence is due, least recently polled first.
 *
 * The windows are 20 hours and 6.5 days rather than 24 hours and 7 days on
 * purpose. A cron fires at a fixed time with a little drift, so a keyword
 * polled at 04:30:05 would not be 24 hours old when the next run starts at
 * 04:30:01 — a daily keyword would silently become every-other-day. The slack
 * is smaller than the gap between runs, so nothing is polled twice either.
 *
 * `on_demand` is excluded: that cadence means "only when someone asks".
 */
export async function listDueKeywords(db: Db, cap = DEFAULT_RANK_POLL_CAP): Promise<DueRow[]> {
  return db<DueRow[]>`
    select kc.id, kc.entity_id, p.id as project_id, p.account_id, p.domain,
           kc.keyword, kc.geo_country, kc.geo_city, kc.geo_postcode,
           kc.device, kc.language, kc.engine
    from keyword_configs kc
    join entities e on e.id = kc.entity_id
    join projects p on p.id = e.project_id
    left join lateral (
      select max(sp.polled_at) as polled_at
      from serp_positions sp
      where sp.entity_id = kc.entity_id
        and sp.keyword = kc.keyword
        and sp.device = kc.device
        and sp.engine = kc.engine
    ) last on true
    where kc.cadence <> 'on_demand'
      and (
        last.polled_at is null
        or last.polled_at < now() - (
          case kc.cadence when 'daily' then interval '20 hours' else interval '6 days 12 hours' end
        )
      )
    order by last.polled_at asc nulls first, kc.created_at asc
    limit ${cap}
  `;
}

function toQuery(row: DueRow): SerpQuery {
  return {
    keyword: row.keyword,
    geo: { country: row.geo_country, city: row.geo_city ?? undefined, postcode: row.geo_postcode ?? undefined },
    device: row.device,
    language: row.language,
    engine: row.engine,
  };
}

/**
 * Poll every due keyword and store its position.
 *
 * One failure does not abort the pass: a client whose key was revoked must not
 * stop every other client's keywords from being polled, which is what an
 * uncaught throw in a scheduled handler does.
 */
export async function runScheduledRankPoll(
  db: Db,
  env: RankPollEnv,
  cap = DEFAULT_RANK_POLL_CAP,
): Promise<ScheduledRankPollSummary> {
  const due = await listDueKeywords(db, cap);
  const summary: ScheduledRankPollSummary = { attempted: 0, polled: 0, failed: [], capped: due.length === cap };
  if (due.length === 0) return summary;

  const keyring: Keyring = await loadKeyring(env.ENCRYPTION_KEYS ?? env.ENCRYPTION_KEY);

  // One key lookup per account rather than per keyword: an account with 25
  // tracked keywords would otherwise open its sealed credential 25 times.
  const keyByAccount = new Map<string, string | null>();

  for (const row of due) {
    summary.attempted++;
    try {
      if (!keyByAccount.has(row.account_id)) {
        keyByAccount.set(row.account_id, await resolveSerpKey(db, row.account_id, keyring, env));
      }
      const apiKey = keyByAccount.get(row.account_id) ?? undefined;
      const connector = createSerpConnector({ ...env, SERPER_API_KEY: apiKey } as Record<string, string | undefined>);
      if (!connector) {
        throw new Error('no Serper key is available for this client');
      }
      const result = await connector.fetch(toQuery(row));
      await insertSerpPositions(db, row.entity_id, [result], row.domain);
      // The same response, already paid for, also says where this entity's
      // competitors stand. Reading them costs no extra lookup, and it is the
      // only thing that gives a competitor added by domain any facts to be
      // compared on. A failure here must not lose the customer's own row,
      // which is already written.
      try {
        await recordCompetitorStandings(db, row.project_id, row.entity_id, [result]);
      } catch (error) {
        console.warn(
          `competitor standings not recorded for ${row.project_id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      summary.polled++;
    } catch (error) {
      summary.failed.push({
        projectId: row.project_id,
        keyword: row.keyword,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
