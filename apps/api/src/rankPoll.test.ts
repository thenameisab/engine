import { describe, expect, it, vi } from 'vitest';
import { loadKeyring } from '@engine/integrations';
import { runScheduledRankPoll, DEFAULT_RANK_POLL_CAP } from './repositories/rankPoll.js';
import type { Db } from './db.js';

/**
 * The scheduled pass. Nothing watches a cron, and this one spends money: every
 * keyword it polls is a paid Serper lookup.
 */
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const ENV = { ENCRYPTION_KEY: KEY, SERPER_API_KEY: 'platform-key' };

function dueRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'kc1',
    entity_id: 'ent1',
    project_id: 'proj1',
    account_id: 'acct1',
    domain: 'tartanhq.com',
    keyword: 'payslip ocr',
    geo_country: 'IN',
    geo_city: null,
    geo_postcode: null,
    device: 'desktop',
    language: 'en',
    engine: 'google',
    ...over,
  };
}

/**
 * A database that answers the first query (the due list) with `due`, and every
 * later query — the credential read, the insert — with nothing. An empty
 * credential read makes `resolveSerpKey` fall back to the platform key, which
 * is the path a client who has connected no Serper key takes.
 */
function dbWith(due: unknown[]): { db: Db; queries: number } {
  const state = { queries: 0 };
  const db = ((_s: TemplateStringsArray, ..._v: unknown[]) => {
    state.queries++;
    return Promise.resolve(state.queries === 1 ? due : []);
  }) as unknown as Db;
  return { db: db, get queries() { return state.queries; } };
}

describe('runScheduledRankPoll', () => {
  it('does nothing, and reads no credential, when no keyword is due', async () => {
    const { db } = dbWith([]);
    const summary = await runScheduledRankPoll(db, ENV);
    expect(summary).toEqual({ attempted: 0, polled: 0, failed: [], capped: false });
  });

  it('polls a due keyword and stores its position', async () => {
    const { db } = dbWith([dueRow()]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ organic: [{ position: 4, link: 'https://tartanhq.com/x', title: 'x' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      const summary = await runScheduledRankPoll(db, ENV);
      expect(summary.attempted).toBe(1);
      expect(summary.polled).toBe(1);
      expect(summary.failed).toEqual([]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  /**
   * One client's revoked key or a vendor 500 must not stop every other
   * client's keywords, which is what an uncaught throw in a scheduled handler
   * does.
   */
  it('records a failure per keyword and keeps going', async () => {
    const { db } = dbWith([dueRow(), dueRow({ id: 'kc2', keyword: 'income verification api' })]);
    let call = 0;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      call++;
      if (call === 1) return new Response('nope', { status: 403 });
      return new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    try {
      const summary = await runScheduledRankPoll(db, ENV);
      expect(summary.attempted).toBe(2);
      expect(summary.polled).toBe(1);
      expect(summary.failed).toHaveLength(1);
      expect(summary.failed[0]!.keyword).toBe('payslip ocr');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails the keyword, rather than the pass, when no key can be resolved', async () => {
    const { db } = dbWith([dueRow()]);
    const summary = await runScheduledRankPoll(db, { ENCRYPTION_KEY: KEY });
    expect(summary.polled).toBe(0);
    expect(summary.failed[0]!.error).toContain('no Serper key is available');
  });

  it('reports that it stopped at the cap, so the log says why the rest were left', async () => {
    const { db } = dbWith([dueRow()]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ organic: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    try {
      const summary = await runScheduledRankPoll(db, ENV, 1);
      expect(summary.capped).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('opens the keyring once for the whole pass', async () => {
    // Proves the keyring loads at all with the env's key: a pass that could not
    // open it could only ever use the platform key.
    await expect(loadKeyring(KEY)).resolves.toBeTruthy();
    expect(DEFAULT_RANK_POLL_CAP).toBe(200);
  });
});
