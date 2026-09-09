import { describe, expect, it, vi, afterEach } from 'vitest';
import worker from './index.js';
import { AI_POLL_CRON } from './repositories/aiPoll.js';
import { RANK_POLL_CRON } from './repositories/rankPoll.js';

/**
 * The nightly sync's own gate.
 *
 * Worth its own test because nothing watches a cron. This gate asked for
 * `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the environment, which was
 * right until migration 0019 moved Engine's OAuth client into
 * `platform_credentials` and made the environment a fallback. After that it
 * skipped the sync on exactly the deployments where an administrator had
 * configured the client through the product and a customer had connected — and
 * logged "not configured" while the connect flow plainly worked.
 */
const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

// A database that cannot be reached. Reaching it at all is the thing under
// test: the pre-migration gate returned before any query.
const UNREACHABLE = 'postgres://never.connected.invalid/db';

function logs() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void lines.push(args.join(' ')));
  return lines;
}

const event = {} as ScheduledController;
const ctx = {} as ExecutionContext;

afterEach(() => vi.restoreAllMocks());

describe('scheduled sync gate', () => {
  it('skips with no encryption key, without touching the database', async () => {
    const lines = logs();
    await worker.scheduled(event, { DATABASE_URL: UNREACHABLE } as never, ctx);
    expect(lines.join('\n')).toContain('no encryption key is configured');
  });

  it('accepts the rotation form of the key', async () => {
    const lines = logs();
    await worker.scheduled(
      event,
      { DATABASE_URL: UNREACHABLE, ENCRYPTION_KEYS: `v1:${ENCRYPTION_KEY}` } as never,
      ctx,
    ).catch(() => undefined);
    // Past the key gate, so it went on to look for the client.
    expect(lines.join('\n')).not.toContain('no encryption key is configured');
  });

  it('looks in the database for the client, not only the environment', async () => {
    logs();
    // The gate now queries `platform_credentials`, so an unreachable database
    // surfaces as a failed run rather than a "not configured" skip. Before
    // migration 0019 this returned early on the env check and never asked.
    await expect(
      worker.scheduled(event, { DATABASE_URL: UNREACHABLE, ENCRYPTION_KEY } as never, ctx),
    ).rejects.toThrow(/never\.connected\.invalid/);
  });

  it('needs no query when the client is configured in the environment', async () => {
    const lines = logs();
    // Past both gates and into runScheduledSync, whose own first query is what
    // fails here — proving the gate itself did not stop it.
    await expect(
      worker.scheduled(
        event,
        {
          DATABASE_URL: UNREACHABLE,
          ENCRYPTION_KEY,
          GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'GOCSPX-secret',
        } as never,
        ctx,
      ),
    ).rejects.toThrow(/never\.connected\.invalid/);
    expect(lines.join('\n')).not.toContain('scheduled sync skipped');
  });
});

/**
 * The three-way cron branch.
 *
 * Nothing watches a cron, and the branch is a string comparison against
 * `wrangler.toml` — so the failure mode is silent: one pass never runs and
 * another runs twice in its slot. `routes.aiAnswers.test.ts` checks the
 * expressions match the toml; these check the dispatch picks the right pass.
 */
describe('scheduled cron dispatch', () => {
  it('routes the AI cron to the AI poll, not the Google sync', async () => {
    const lines = logs();
    await worker.scheduled(
      { cron: AI_POLL_CRON } as ScheduledController,
      { DATABASE_URL: UNREACHABLE } as never,
      ctx,
    ).catch(() => undefined);
    const out = lines.join('\n');
    // With no LLM key the AI poll skips before it queries, which is itself
    // proof it was the pass that ran.
    expect(out).toContain('scheduled AI poll skipped');
    expect(out).not.toContain('scheduled sync');
  });

  it('routes the rank cron to the rank poll, not the AI poll', async () => {
    const lines = logs();
    await worker.scheduled(
      { cron: RANK_POLL_CRON } as ScheduledController,
      { DATABASE_URL: UNREACHABLE } as never,
      ctx,
    ).catch(() => undefined);
    const out = lines.join('\n');
    expect(out).toContain('scheduled rank poll skipped');
    expect(out).not.toContain('AI poll');
  });

  it('routes an unrecognised cron to the Google sync, so no slot does nothing', async () => {
    const lines = logs();
    await worker.scheduled(
      { cron: '15 3 * * *' } as ScheduledController,
      { DATABASE_URL: UNREACHABLE } as never,
      ctx,
    ).catch(() => undefined);
    expect(lines.join('\n')).toContain('no encryption key is configured');
  });
});
