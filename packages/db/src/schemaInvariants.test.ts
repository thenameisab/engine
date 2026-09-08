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
    // 0014 created this as `refresh_token_sealed`; 0017 renamed it to
    // `secret_sealed` once an API key could live here too. Asserting the
    // original name would pass forever by reading history — the create-table
    // body never changes — while saying nothing about the live schema. So the
    // column is asserted as created, *and* the rename is asserted separately.
    expect(credentials).toMatch(/refresh_token_sealed\s+text\s+not\s+null/i);
    expect(combined).toMatch(
      /alter\s+table\s+integration_credentials\s+rename\s+column\s+refresh_token_sealed\s+to\s+secret_sealed/i,
    );
    // Primary key, so a second credential for one connection is rejected rather
    // than leaving two tokens where only one is ever read.
    expect(credentials).toMatch(/connection_id\s+uuid\s+primary\s+key/i);
    // Cascade, so dropping a connection cannot strand unreachable ciphertext.
    expect(credentials).toMatch(/references\s+integration_connections\(id\)\s+on\s+delete\s+cascade/i);
  });
});

describe('account membership', () => {
  /**
   * An account is reachable only by joining `account_members`
   * (`listAccountsForUser`), so an account with no member row is invisible to
   * every user and never cleaned up.
   *
   * That invariant cannot be written as DDL: a check constraint cannot see
   * another table, and a FK from `accounts` to `account_members` would be
   * circular — the account row must exist before its membership can reference
   * it. So it is held by `createAccount` writing both rows in one transaction
   * (apps/api/src/repositories/accounts.ts), and what the schema can guarantee
   * is only the shape below. These assertions keep that shape honest, and this
   * comment records where the real guard lives.
   */
  it('makes account_members the single, cascading path from a user to an account', async () => {
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const combined = withoutComments(files.map((f) => f.sql).join('\n'));

    const members = tableBody(combined, 'account_members');
    expect(members).not.toBeNull();
    // Cascade both ways, so deleting an account or a user cannot leave a
    // membership row pointing at nothing.
    expect(members).toMatch(/account_id\s+uuid\s+not\s+null\s+references\s+accounts\(id\)\s+on\s+delete\s+cascade/i);
    expect(members).toMatch(/user_id\s+text\s+not\s+null\s+references\s+users\(id\)\s+on\s+delete\s+cascade/i);
    // Composite primary key: one row per (account, user), so a repeated grant
    // is a conflict rather than a duplicate membership.
    expect(members).toMatch(/primary\s+key\s*\(account_id,\s*user_id\)/i);
  });

  it('keeps no second, unjoined owner path on accounts', async () => {
    // An `owner_user_id` column on `accounts` would be a second way to say who
    // owns an account — and the two would drift, with membership checks and the
    // account list disagreeing about who can see what.
    const files = await readMigrationFiles(MIGRATIONS_DIR);
    const combined = withoutComments(files.map((f) => f.sql).join('\n'));

    expect(tableBody(combined, 'accounts')).not.toMatch(/owner|user_id/i);
    expect(combined).not.toMatch(/alter\s+table\s+accounts\s+add\s+column\s+(owner|user_id)/i);
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
