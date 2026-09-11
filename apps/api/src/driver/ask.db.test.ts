import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../db.js';
import { askDriver } from './ask.js';

/**
 * One Driver turn, end to end, against a real Postgres with a stubbed vendor.
 *
 * The loop is unit-tested in `@engine/driver` against a scripted connector, and
 * the tools are db-tested in `tools.db.test.ts`. Neither proves the seam: that
 * the model's tool call reaches the right handler, that the handler runs under
 * the *session's* scope rather than anything the model said, and that what
 * comes back is an envelope the next round can actually carry.
 *
 * The vendor is stubbed at `fetch`, which is the only place it is reachable
 * from, so everything between the route and the wire is the real code path.
 *
 * Runs only when `TEST_DATABASE_URL` points at a migrated database.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('askDriver (Postgres)', () => {
  let db: Db;
  let accountId: string;
  let projectId: string;
  let entityId: string;

  /** A second project the model will be encouraged to reach for and must not get. */
  let otherProjectId: string;

  beforeAll(async () => {
    db = createDb(url!);
    const [account] = await db<{ id: string }[]>`
      insert into accounts (name) values (${`ask-test ${crypto.randomUUID()}`}) returning id
    `;
    accountId = account.id;
    const [project] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${accountId}, 'Ask Test Co', 'asktest.example') returning id
    `;
    projectId = project.id;
    const [entity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${projectId}, 'Ask Test Co') returning id
    `;
    entityId = entity.id;

    const [otherAccount] = await db<{ id: string }[]>`
      insert into accounts (name) values (${`ask-other ${crypto.randomUUID()}`}) returning id
    `;
    const [otherProject] = await db<{ id: string }[]>`
      insert into projects (account_id, name, domain)
      values (${otherAccount.id}, 'OTHER-TENANT', 'othertenant.example') returning id
    `;
    otherProjectId = otherProject.id;
    const [otherEntity] = await db<{ id: string }[]>`
      insert into entities (project_id, canonical_name) values (${otherProjectId}, 'OTHER-TENANT') returning id
    `;
    await db`
      insert into findings (entity_id, source, severity, predicted_impact, evidence, action_templates, fingerprint, issue_type)
      values (${otherEntity.id}, 'technical', 99, 9, '{}'::jsonb, '[]'::jsonb, ${crypto.randomUUID()}, 'OTHER-TENANT-ISSUE')
    `;
    await db`
      insert into audit_runs (project_id, pages_audited, findings_count, health_score)
      values (${otherProjectId}, 999, 999, 1)
    `;
  });

  afterAll(async () => {
    await db`delete from accounts where id::text = ${accountId}`;
    await db`delete from projects where id::text = ${otherProjectId}`;
    await db.end();
  });

  beforeEach(async () => {
    await db`delete from findings where entity_id::text = ${entityId}`;
    await db`delete from audit_runs where project_id::text = ${projectId}`;
  });

  /* ── the stubbed vendor ─────────────────────────────────────────────────── */

  /** One non-streamed chat completion, in the vendor's shape. */
  function completion(message: Record<string, unknown>, usage?: Record<string, number>): Response {
    return new Response(
      JSON.stringify({
        choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  function toolCall(name: string, args: Record<string, unknown> = {}, id = name) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }

  /** Replays scripted vendor responses and records every outbound body. */
  function vendor(...responses: Response[]) {
    const bodies: Record<string, unknown>[] = [];
    let i = 0;
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return responses[i++] ?? completion({ content: 'script exhausted' });
    });
    return { fetchImpl, bodies };
  }

  /**
   * `askDriver` builds its own connector from the env, so the vendor is stubbed
   * where the connector reaches it: the global `fetch`.
   */
  async function ask(question: string, responses: Response[], history?: never) {
    const { fetchImpl, bodies } = vendor(...responses);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    try {
      const answer = await askDriver(db, { SARVAM_API_KEY: 'test-key', DATABASE_URL: url! }, projectId, {
        question,
        ...(history ? { history } : {}),
      });
      return { answer, bodies, fetchImpl };
    } finally {
      globalThis.fetch = original;
    }
  }

  /* ── the seam ───────────────────────────────────────────────────────────── */

  it('runs the tool the model asked for and answers from its result', async () => {
    await db`
      insert into audit_runs (project_id, pages_audited, findings_count, health_score)
      values (${projectId}, 42, 2, 73)
    `;
    await db`
      insert into findings (entity_id, source, severity, predicted_impact, evidence, action_templates, fingerprint, issue_type)
      values (${entityId}, 'technical', 80, 5, '{}'::jsonb, '[]'::jsonb, ${crypto.randomUUID()}, 'missing_schema')
    `;

    const { answer, bodies } = await ask('how healthy is the site?', [
      completion({ content: null, tool_calls: [toolCall('site_health')] }),
      completion({ content: 'Your health score is 73 over 42 pages, with 1 open finding.' }, {
        prompt_tokens: 900,
        completion_tokens: 40,
        total_tokens: 940,
      }),
    ]);

    expect(answer.source).toBe('driver');
    expect(answer.text).toContain('73');
    expect(answer.turn!.stopReason).toBe('answered');
    expect(answer.turn!.rounds[0]!.toolCalls[0]!.name).toBe('site_health');

    // The second request carries the real tool result, read from Postgres.
    const toolMessage = (bodies[1]!.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMessage!.content).toContain('<tool_result name="site_health" state="ok">');
    expect(toolMessage!.content).toContain('"healthScore": 73');
  });

  it('runs a round of tools concurrently and answers every call', async () => {
    const { bodies } = await ask('how is everything?', [
      completion({
        content: null,
        tool_calls: [toolCall('site_health'), toolCall('integration_status'), toolCall('crawl_coverage')],
      }),
      completion({ content: 'Here is the summary.' }),
    ]);

    const second = bodies[1]!.messages as { role: string; tool_call_id?: string }[];
    expect(second.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).sort()).toEqual([
      'crawl_coverage',
      'integration_status',
      'site_health',
    ]);
  });

  it('injects scope from the session, so a model that asks for another project gets its own', async () => {
    // The model sends a projectId anyway. The schema does not declare one, so
    // validation rejects the call — and the rejection is what the model is
    // told, rather than the other project's rows.
    const { answer, bodies } = await ask('show me findings', [
      completion({ content: null, tool_calls: [toolCall('findings', { projectId: otherProjectId })] }),
      completion({ content: 'I could not read that.' }),
    ]);

    const toolMessage = (bodies[1]!.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMessage!.content).toContain('state="error"');
    expect(toolMessage!.content).toContain('does not accept');
    expect(toolMessage!.content).not.toContain('OTHER-TENANT');
    expect(answer.source).toBe('driver');
  });

  it('never reaches the other project even when the tool call is well formed', async () => {
    await db`
      insert into findings (entity_id, source, severity, predicted_impact, evidence, action_templates, fingerprint, issue_type)
      values (${entityId}, 'technical', 50, 3, '{}'::jsonb, '[]'::jsonb, ${crypto.randomUUID()}, 'ours_only')
    `;
    const { bodies } = await ask('show me findings', [
      completion({ content: null, tool_calls: [toolCall('findings')] }),
      completion({ content: 'One finding.' }),
    ]);

    const toolMessage = (bodies[1]!.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMessage!.content).toContain('ours_only');
    expect(toolMessage!.content).not.toContain('OTHER-TENANT-ISSUE');
  });

  it('sends the catalogue and the system prompt on the first request', async () => {
    const { bodies } = await ask('hello', [completion({ content: 'hi' })]);

    const first = bodies[0]!;
    expect((first.tools as unknown[]).length).toBe(19);
    const system = (first.messages as { role: string; content: string }[])[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain('asktest.example');
    expect(system.content).toContain('</tool_result>');
    // The model is never told a tool's tier or the tables it reads.
    expect(JSON.stringify(first.tools)).not.toContain('"tier"');
    expect(JSON.stringify(first.tools)).not.toContain('"tables"');
  });

  it('feeds a bad-argument rejection back as a message the model can act on', async () => {
    const { bodies } = await ask('findings please', [
      completion({ content: null, tool_calls: [toolCall('findings', { limit: 'lots' })] }),
      completion({ content: 'Let me try that again.' }),
    ]);

    const toolMessage = (bodies[1]!.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    expect(toolMessage!.content).toContain('must be a integer');
  });

  it('answers a hallucinated tool name instead of failing the turn', async () => {
    const { answer, bodies } = await ask('what does the pricing page say?', [
      completion({ content: null, tool_calls: [toolCall('page_content', { url: '/pricing' })] }),
      completion({ content: 'I cannot read page content yet.' }),
    ]);

    const toolMessage = (bodies[1]!.messages as { role: string; content: string }[]).find((m) => m.role === 'tool');
    // Quotes are escaped because the envelope JSON-encodes the payload.
    expect(toolMessage!.content).toContain('no tool called \\"page_content\\"');
    expect(answer.source).toBe('driver');
  });

  /* ── §4.8 degradation ───────────────────────────────────────────────────── */

  describe('degradation', () => {
    it('falls back to the deterministic Copilot when no model key is configured', async () => {
      const answer = await askDriver(db, { DATABASE_URL: url! }, projectId, { question: 'how is search doing?' });

      expect(answer.source).toBe('copilot-fallback');
      expect(answer.fellBackBecause).toContain('no conversational model is configured');
      expect(answer.text.length).toBeGreaterThan(0);
    });

    it('falls back when the vendor fails, rather than failing the turn', async () => {
      const { answer } = await ask('how is search doing?', [
        new Response('upstream unavailable', { status: 503 }),
      ]);

      expect(answer.source).toBe('copilot-fallback');
      expect(answer.fellBackBecause).toContain('503');
      expect(answer.text.length).toBeGreaterThan(0);
    });

    it('falls back when the turn stops early with nothing to show', async () => {
      // Every round asks for a tool and never answers, so the loop spends its
      // rounds and the forced answer comes back empty.
      const keepCalling = () => completion({ content: null, tool_calls: [toolCall('site_health')] });
      const { answer } = await ask('how is the site?', [
        keepCalling(),
        keepCalling(),
        keepCalling(),
        keepCalling(),
        completion({ content: '' }),
      ]);

      expect(answer.source).toBe('copilot-fallback');
      expect(answer.fellBackBecause).toContain('no-answer');
    });
  });
});
