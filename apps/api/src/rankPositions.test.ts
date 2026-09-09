import { describe, expect, it } from 'vitest';
import type { SerpResult } from '@engine/connectors';
import { insertSerpPositions } from './repositories/rankPositions.js';
import type { Db } from './db.js';

/**
 * Which position a poll records. This stored the lowest position in the SERP
 * regardless of whose result it was, so every row said the tracked entity
 * ranked first and named a competitor's URL — and the visibility score read
 * those rows as the customer's organic standing.
 */
const ENTITY = '11111111-1111-4111-8111-111111111111';

/** Captures the values each insert was called with. */
function recordingDb(): { db: Db; values: unknown[][] } {
  const values: unknown[][] = [];
  const db = ((_strings: TemplateStringsArray, ...vals: unknown[]) => {
    values.push(vals);
    return Promise.resolve([]);
  }) as unknown as Db;
  return { db, values };
}

function result(organic: { position: number; url: string }[]): SerpResult {
  return {
    query: { keyword: 'payslip ocr', geo: { country: 'IN' }, device: 'desktop', language: 'en', engine: 'google' },
    organic: organic.map((o) => ({ ...o, title: '' })),
    features: [],
    vendor: 'serper',
    rawSnapshotRef: 'ref',
    polledAt: '2026-09-09T00:00:00.000Z',
  } as SerpResult;
}

/** `position` and `url` are the 9th and 10th values in the insert. */
function stored(values: unknown[]): { position: unknown; url: unknown } {
  return { position: values[8], url: values[9] };
}

describe('insertSerpPositions', () => {
  it("records the tracked domain's own position, not the SERP leader's", async () => {
    const { db, values } = recordingDb();
    await insertSerpPositions(
      db,
      ENTITY,
      [result([
        { position: 1, url: 'https://parseur.com/extract-data/payslip-ocr' },
        { position: 2, url: 'https://surepass.io/payslip-ocr-api/' },
        { position: 6, url: 'https://tartanhq.com/products/payslip-ocr' },
      ])],
      'tartanhq.com',
    );
    expect(stored(values[0]!)).toEqual({ position: 6, url: 'https://tartanhq.com/products/payslip-ocr' });
  });

  it('records null when the domain is not in the returned results', async () => {
    const { db, values } = recordingDb();
    await insertSerpPositions(
      db,
      ENTITY,
      [result([{ position: 1, url: 'https://parseur.com/extract-data/payslip-ocr' }])],
      'tartanhq.com',
    );
    expect(stored(values[0]!)).toEqual({ position: null, url: null });
  });

  it('matches a subdomain of the tracked domain but not a lookalike', async () => {
    const { db, values } = recordingDb();
    await insertSerpPositions(
      db,
      ENTITY,
      [result([
        { position: 3, url: 'https://nottartanhq.com/a' },
        { position: 5, url: 'https://docs.tartanhq.com/b' },
      ])],
      'tartanhq.com',
    );
    expect(stored(values[0]!)).toEqual({ position: 5, url: 'https://docs.tartanhq.com/b' });
  });

  it('takes the best of several results from the tracked domain', async () => {
    const { db, values } = recordingDb();
    await insertSerpPositions(
      db,
      ENTITY,
      [result([
        { position: 9, url: 'https://tartanhq.com/blog' },
        { position: 4, url: 'https://tartanhq.com/products' },
      ])],
      'tartanhq.com',
    );
    expect(stored(values[0]!).position).toBe(4);
  });

  it('accepts a domain given as a full URL, as the project row may hold one', async () => {
    const { db, values } = recordingDb();
    await insertSerpPositions(
      db,
      ENTITY,
      [result([{ position: 2, url: 'https://tartanhq.com/x' }])],
      'https://www.tartanhq.com/',
    );
    expect(stored(values[0]!).position).toBe(2);
  });
});
