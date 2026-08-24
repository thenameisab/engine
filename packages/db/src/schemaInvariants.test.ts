import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readMigrationFiles } from './runner.js';

/**
 * Properties of the migration set that must keep holding, checked against the
 * real files rather than a live database.
 *
 * These are not tests of the migration runner — `plan.test.ts` covers that.
 * They guard design decisions a future migration could quietly undo, where the
 * undoing would not fail anything else: no type error, no failing query, no
 * obviously wrong number. Somebody would just have to notice.
 */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../infra/migrations/postgres',
);

/** The `create table <name> ( ... );` body, or null if the table is never created. */
function tableBody(sql: string, table: string): string | null {
  const start = sql.search(new RegExp(`create\\s+table\\s+${table}\\s*\\(`, 'i'));
  if (start === -1) return null;
  const open = sql.indexOf('(', start);
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') {
      depth--;
      if (depth === 0) return sql.slice(open + 1, i);
    }
  }
  return null;
}

/** Strip `--` line comments, so prose about a column is not mistaken for the column. */
function withoutComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('customer OAuth credentials', () => {
  it('are never a column on integration_connections', async () => {
    // The whole reason integration_credentials is a separate 1:1 table. Put the
    // sealed token back on integration_connections and every read of a
    // connection has to remember to exclude it by name — a `select *` written
    // later would put a live customer refresh token into an API response, and
    // nothing else in this repo would catch that.
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const combined = withoutComments(files.map((f) => f.sql).join('\n'));

    const connections = tableBody(combined, 'integration_connections');
    expect(connections).not.toBeNull();
    expect(connections).not.toMatch(/refresh_token/i);
    expect(connections).not.toMatch(/\btoken\b/i);
    expect(connections).not.toMatch(/secret/i);

    // ...and no later migration adds one back.
    expect(combined).not.toMatch(/alter\s+table\s+integration_connections\s+add\s+column\s+\w*token/i);
  });

  it('live on their own table, one per connection, cascading on delete', async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const combined = withoutComments(files.map((f) => f.sql).join('\n'));

    const credentials = tableBody(combined, 'integration_credentials');
    expect(credentials).not.toBeNull();
    expect(credentials).toMatch(/refresh_token_sealed\s+text\s+not\s+null/i);
    // Primary key, so a second credential for one connection is rejected rather
    // than leaving two tokens where only one is ever read.
    expect(credentials).toMatch(/connection_id\s+uuid\s+primary\s+key/i);
    // Cascade, so dropping a connection cannot strand unreachable ciphertext.
    expect(credentials).toMatch(/references\s+integration_connections\(id\)\s+on\s+delete\s+cascade/i);
  });
});

describe('migration set', () => {
  it('has no duplicate version numbers', async () => {
    // A collision is easy to create when two branches are in flight, and the
    // runner would apply only one of them.
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const versions = files.map((f) => f.version);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it('is ordered and gapless, so a partially-migrated database is unambiguous', async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const numbers = files.map((f) => Number(f.version)).sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    numbers.forEach((n, i) => expect(n).toBe(i + 1));
  });
});
