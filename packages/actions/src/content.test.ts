import { describe, it, expect, vi } from 'vitest';
import type { BuildEnv } from './build.js';
import type { ActionContext } from './context.js';
import { buildRewritePrompt, generateRewrite, generateContentAction } from './content.js';

const ENV: BuildEnv = { now: () => '2026-07-20T00:00:00.000Z', makeId: () => 'act_fixed' };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe('buildRewritePrompt', () => {
  it('selects the right instruction per issue type', () => {
    const p = buildRewritePrompt('not-answer-first', 'some text');
    expect(p.user).toContain('directly and completely answers');
    expect(p.user).toContain('some text');
  });

  it('falls back to a generic instruction for an unrecognized issue type', () => {
    const p = buildRewritePrompt('something-else', 'x');
    expect(p.user).toContain('Improve this content for AI-search extractability.');
  });

  it('includes entity name and keywords when supplied', () => {
    const p = buildRewritePrompt('weak-entity-coverage', 'x', { name: 'Acme Corp', keywords: ['Fix Queue'] });
    expect(p.user).toContain('Acme Corp');
    expect(p.user).toContain('Fix Queue');
  });

  it('never claims to invent facts', () => {
    const p = buildRewritePrompt('weak-eeat', 'x');
    expect(p.system).toContain('never invent new facts');
  });
});

describe('generateRewrite', () => {
  it('posts to OpenAI chat completions and returns the rewritten text', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '  Rewritten answer.  ' } }] }));
    const out = await generateRewrite('not-answer-first', 'Old text', undefined, {
      apiKey: 'sk-test',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toBe('Rewritten answer.');

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.messages).toHaveLength(2);
  });

  it('throws naming the HTTP status on failure', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'nope' }, 429));
    await expect(
      generateRewrite('weak-eeat', 'x', undefined, { apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('429');
  });

  it('throws when OpenAI returns no content', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [] }));
    await expect(
      generateRewrite('weak-eeat', 'x', undefined, { apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('no content');
  });
});

describe('generateContentAction', () => {
  const ctx: ActionContext = {
    url: 'https://acme.com/guide',
    target: { kind: 'edge-worker', workerName: 'acme-edge' },
    currentBodyText: 'Original page content that needs rewriting.',
    entity: { schemaType: 'Organization', name: 'Acme Corp' },
  };

  it('generates a proposed content diff from the LLM rewrite', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 'New content.' } }] }));
    const action = await generateContentAction(
      { id: 'fnd_1', issueType: 'not-answer-first' },
      ctx,
      { apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch },
      ENV,
    );
    expect(action!.type).toBe('content');
    expect(action!.status).toBe('proposed');
    expect(action!.diff).toEqual({
      before: 'Original page content that needs rewriting.',
      after: 'New content.',
      format: 'text',
    });
  });

  it('returns null when there is no current body text to rewrite', async () => {
    const fetchImpl = vi.fn();
    const action = await generateContentAction(
      { id: 'fnd_1', issueType: 'not-answer-first' },
      { ...ctx, currentBodyText: undefined },
      { apiKey: 'sk-test', fetchImpl: fetchImpl as unknown as typeof fetch },
      ENV,
    );
    expect(action).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
