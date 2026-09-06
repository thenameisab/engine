import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createAccount } from './accounts.js';
import type { Db } from '../db.js';

/**
 * `createAccount` writes two rows — the account, and the `account_members` row
 * that is the only path any user has to it. `listAccountsForUser` joins through
 * `account_members`, so an account written without its member row is invisible
 * to everyone, forever, and nothing sweeps it up.
 *
 * The failure is between the two statements, which no fake can reproduce by
 * calling the repository normally: it has to be injected. So the driver below
 * records the statements it is given, fails the one the test names, and only
 * "commits" what a transaction callback returned without throwing — enough to
 * assert the account insert is undone when the member insert fails.
 */
interface Statement {
  sql: string;
  values: unknown[];
}

function normalize(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

/** The table a statement writes to, so assertions read as the fact they check. */
function target(statement: Statement): string {
  return /^insert into (\w+)/.exec(statement.sql)?.[1] ?? statement.sql;
}

interface FakeDb {
  db: Db;
  /** Statements that survived — a transaction's are discarded when it throws. */
  committed: Statement[];
  /** Every statement attempted, committed or rolled back. */
  attempted: Statement[];
}

/** `failOn`: substring of the statement that should throw when executed. */
function fakeDb(failOn?: string): FakeDb {
  const committed: Statement[] = [];
  const attempted: Statement[] = [];

  function makeQuery(sink: Statement[]) {
    return (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = normalize(strings);
      const statement = { sql, values };
      attempted.push(statement);
      if (failOn && sql.includes(failOn)) {
        return Promise.reject(new Error(`simulated failure: ${failOn}`));
      }
      sink.push(statement);
      // Enough of a row for `toAccount` to work on the insert...returning.
      return Promise.resolve(
        sql.startsWith('insert into accounts')
          ? [{ id: 'acc-1', name: values[0], branding: {}, created_at: new Date('2026-01-01T00:00:00Z') }]
          : [],
      );
    };
  }

  const query = makeQuery(committed) as unknown as Db;
  (query as unknown as { begin: unknown }).begin = async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    const pending: Statement[] = [];
    const result = await fn(makeQuery(pending));
    // Reached only when the callback resolved; a throw propagates and `pending`
    // is dropped on the floor, which is what a rollback means here.
    committed.push(...pending);
    return result;
  };

  return { db: query, committed, attempted };
}

describe('createAccount', () => {
  it('writes the account and its owner membership', async () => {
    const { db, committed } = fakeDb();
    const account = await createAccount(db, 'Acme', 'user-1');

    expect(account.id).toBe('acc-1');
    expect(account.name).toBe('Acme');
    expect(committed.map(target)).toEqual(['accounts', 'account_members']);
    expect(committed[1].values).toEqual(['acc-1', 'user-1']);
  });

  it('leaves no account behind when the membership insert fails', async () => {
    const { db, committed, attempted } = fakeDb('insert into account_members');

    await expect(createAccount(db, 'Acme', 'user-1')).rejects.toThrow(/simulated failure/);

    // The account insert was attempted — and rolled back with the member row.
    // Without the transaction this is where an orphan account is created: a
    // row in `accounts` that `listAccountsForUser` can never join to.
    expect(attempted.map(target)).toEqual(['accounts', 'account_members']);
    expect(committed).toEqual([]);
  });

  it('runs both inserts on the same transaction handle, not the pool', async () => {
    // A `db.begin` whose body still reached for the outer `db` would commit the
    // account independently and defeat the whole thing. The fake's outer query
    // and transaction query are different functions, so a statement landing in
    // `committed` before the callback returns would mean the outer one was used.
    const seen: string[] = [];
    const { db } = fakeDb();
    const outer = db as unknown as { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
    const realBegin = outer.begin;
    outer.begin = (fn) => realBegin((tx) => {
      seen.push('begin');
      return fn(tx);
    });

    await createAccount(db, 'Acme', 'user-1');
    expect(seen).toEqual(['begin']);
  });
});

/**
 * The behavioural tests above run against a fake driver, which can only prove
 * that `createAccount` uses `db.begin`. This guards the same property at the
 * source level, so a second account-creating path added later cannot reintroduce
 * the orphan without tripping something.
 */
describe('account creation stays transactional', () => {
  it('has no insert into accounts outside a transaction', async () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'accounts.ts');
    const source = (await readFile(file, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*/g, '');

    const inserts = [...source.matchAll(/(\w+)\s*(?:<[^>]*>)?`\s*insert into accounts\b/g)];
    expect(inserts.length, 'accounts.ts should still create accounts').toBeGreaterThan(0);
    // The tag is the transaction handle, never the pool. `db\`insert into
    // accounts\`` is exactly the bug this file exists for.
    for (const [, tag] of inserts) expect(tag).not.toBe('db');
  });
});
