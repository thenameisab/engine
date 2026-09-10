import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { app } from './index.js';
import { AI_POLL_CRON, MAX_PROMPTS_PER_ENTITY, MAX_PROMPT_LENGTH } from './repositories/aiPoll.js';
import { RANK_POLL_CRON } from './repositories/rankPoll.js';

/**
 * The AI-answer routes at the boundary. Like ./routes.keywords.test.ts these
 * need no database: every rejection here happens before `createDb`, and a
 * `DATABASE_URL` that cannot connect is what proves the ordering.
 */
const env = {
  AUTH_MODE: 'disabled',
  // A dead loopback port. Refused at once, with no name to look up: the old
  // `never.connected.invalid` host relied on DNS failing quickly, and on CI it
  // did not — three role reads against it timed out a 5-second test.
  DATABASE_URL: 'postgres://127.0.0.1:1/db',
  SARVAM_API_KEY: 'sk-test',
} as const;

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';

function send(path: string, body: unknown, method = 'POST'): Promise<Response> {
  return app.request(
    path,
    { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    env,
  );
}

describe('POST /projects/:id/ai/stream', () => {
  it('rejects a model that is not in the registry, before calling the vendor', async () => {
    // The vendor's own rejection enumerates every model on the account
    // ("should be one of sarvam-105b, ..."), which is not something a
    // customer's error toast should carry.
    const res = await send(`/projects/${PROJECT}/ai/stream`, {
      mode: 'prompt',
      entityId: ENTITY,
      prompt: 'best payslip ocr',
      model: 'glm-5.2',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('model');
  });

  it('requires a prompt in prompt mode', async () => {
    const res = await send(`/projects/${PROJECT}/ai/stream`, { mode: 'prompt', entityId: ENTITY, prompt: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('prompt');
  });

  it('requires a question in ask mode', async () => {
    const res = await send(`/projects/${PROJECT}/ai/stream`, { mode: 'ask' });
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('question');
  });

  it('rejects a body that is not JSON', async () => {
    const res = await app.request(
      `/projects/${PROJECT}/ai/stream`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
      env,
    );
    expect(res.status).toBe(400);
  });

  it('answers 503 when no engine is wired, rather than opening an empty stream', async () => {
    const res = await app.request(
      `/projects/${PROJECT}/ai/stream`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'ask', question: 'how is acme doing' }) },
      { AUTH_MODE: 'disabled', DATABASE_URL: env.DATABASE_URL } as never,
    );
    expect(res.status).toBe(503);
    // The message names no variable and no vendor.
    const body = await res.json();
    expect(body.error).not.toMatch(/SARVAM|API_KEY/i);
  });
});

describe('PUT /projects/:id/entities/:id/prompts', () => {
  it('rejects prompts that are not an array of strings', async () => {
    const res = await send(`/projects/${PROJECT}/entities/${ENTITY}/prompts`, { prompts: 'what is payslip ocr' }, 'PUT');
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('prompts');
  });

  it('rejects a prompt longer than the cap', async () => {
    const res = await send(
      `/projects/${PROJECT}/entities/${ENTITY}/prompts`,
      { prompts: ['x'.repeat(MAX_PROMPT_LENGTH + 1)] },
      'PUT',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).field).toBe('prompts');
  });

  it('rejects more prompts than a brand may track', async () => {
    // Each prompt is three model calls per engine on every pass, so the cap is
    // a cost ceiling and has to be enforced before the write.
    const prompts = Array.from({ length: MAX_PROMPTS_PER_ENTITY + 1 }, (_, i) => `prompt number ${i}`);
    const res = await send(`/projects/${PROJECT}/entities/${ENTITY}/prompts`, { prompts }, 'PUT');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/up to 20 prompts/);
  });

  it('counts a de-duplicated list against the cap, not the raw one', async () => {
    // 21 entries that collapse to one prompt is one prompt. Rejecting it would
    // punish a paste, and accepting 21 rows would bill for 21.
    const prompts = Array.from({ length: MAX_PROMPTS_PER_ENTITY + 1 }, () => 'best payslip ocr');
    const res = await send(`/projects/${PROJECT}/entities/${ENTITY}/prompts`, { prompts }, 'PUT');
    // Past validation, so it failed on the unreachable database instead.
    expect(res.status).not.toBe(400);
  });
});

describe('the cron expressions', () => {
  /**
   * Three copies of these strings exist: two constants and `wrangler.toml`.
   * Drift means a pass never runs and another runs twice, with nothing failing
   * at build time — the AI poll would simply never fire and the Google sync
   * would run in its slot.
   */
  it('match the expressions in wrangler.toml', async () => {
    const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '';
    expect(crons).toContain(`"${RANK_POLL_CRON}"`);
    expect(crons).toContain(`"${AI_POLL_CRON}"`);
  });

  it('are three distinct expressions, so each pass has its own slot', async () => {
    const toml = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    const crons = (/crons\s*=\s*\[([^\]]*)\]/.exec(toml)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
    expect(crons).toHaveLength(3);
    expect(new Set(crons).size).toBe(3);
    // The AI poll must not share a minute with the rank poll: both open
    // database connections and both are billed per call.
    expect(AI_POLL_CRON).not.toBe(RANK_POLL_CRON);
  });
});
