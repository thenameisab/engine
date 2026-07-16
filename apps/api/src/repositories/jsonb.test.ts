import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * A source-level guard, not a behavioural test, because the behaviour it
 * protects only misbehaves against a real Postgres — and CI has no database.
 *
 * `${JSON.stringify(value)}::jsonb` looks correct and even round-trips through
 * its own repository, so no unit test with a fake driver would catch it: the
 * cast makes Postgres infer the parameter as jsonb, the driver JSON-encodes the
 * already-encoded string, and the column silently holds a jsonb *string*. The
 * damage only shows up in SQL — `target->>'kind'` is null, `jsonb_array_length`
 * errors, and every jsonb predicate matches nothing.
 *
 * Binding through `toJsonb()` (see ../db.ts) is the fix. This test keeps the
 * old idiom from creeping back in.
 */
describe('jsonb binding convention', () => {
  it('no repository casts a stringified value to jsonb', async () => {
    const files = (await readdir(HERE)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(path.join(HERE, file), 'utf8');
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      if (/JSON\.stringify\([^)]*\)\s*\}\s*::\s*jsonb/.test(withoutComments)) offenders.push(file);
    }

    expect(offenders, 'use toJsonb(db, value) instead of `${JSON.stringify(v)}::jsonb`').toEqual([]);
  });
});
