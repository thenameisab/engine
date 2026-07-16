import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { checksum, parseMigrationFilename, planMigrations } from './plan.js';
import type { AppliedMigration, MigrationFile, MigrationPlan } from './plan.js';

export type Sql = postgres.Sql;

/**
 * Namespaced advisory-lock key. Two `migrate` runs against the same database
 * (a deploy and a laptop, say) must not interleave. Postgres takes a bigint;
 * this stays under 2^53 so it survives the trip as a JS number.
 */
const LOCK_KEY = 8_531_100_411_072_001;

const MIGRATIONS_TABLE = 'schema_migrations';

/** Read + parse every .sql file in a migrations directory, sorted by version. */
export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql'));
  const files = await Promise.all(
    entries.map(async (filename) => {
      const { version, name } = parseMigrationFilename(filename);
      const sql = await readFile(path.join(dir, filename), 'utf8');
      return { version, name, filename, sql };
    }),
  );
  return files.sort((a, b) => a.version.localeCompare(b.version));
}

/**
 * The ledger. Created outside the migration transaction so that `status` works
 * against a database that has never been migrated.
 */
export async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql.unsafe(`
    create table if not exists ${MIGRATIONS_TABLE} (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function readAppliedMigrations(sql: Sql): Promise<AppliedMigration[]> {
  const rows = await sql.unsafe(
    `select version, name, checksum from ${MIGRATIONS_TABLE} order by version`,
  );
  return rows.map((row) => ({
    version: row.version as string,
    name: row.name as string,
    checksum: row.checksum as string,
  }));
}

export async function planFromDatabase(sql: Sql, dir: string): Promise<MigrationPlan> {
  await ensureMigrationsTable(sql);
  const [files, applied] = await Promise.all([readMigrationFiles(dir), readAppliedMigrations(sql)]);
  return planMigrations(files, applied);
}

export interface MigrateOptions {
  dir: string;
  /** Plan and report without writing. */
  dryRun?: boolean;
  onEvent?: (message: string) => void;
}

/**
 * Apply every pending migration.
 *
 * All pending migrations run in a **single** transaction, holding a
 * transaction-scoped advisory lock. Neon's pooled endpoint is a
 * transaction-mode pooler, where a session-scoped lock is not reliably held by
 * the same backend that later releases it — a transaction-scoped lock is. The
 * price is that a migration needing to run outside a transaction (CREATE INDEX
 * CONCURRENTLY, ALTER TYPE ... ADD VALUE) cannot go through this runner; none
 * do today, and a half-applied schema is the worse failure to design against.
 */
export async function migrate(sql: Sql, options: MigrateOptions): Promise<MigrationFile[]> {
  const { dir, dryRun = false, onEvent = () => {} } = options;

  const plan = await planFromDatabase(sql, dir);
  if (plan.pending.length === 0) {
    onEvent('Already up to date.');
    return [];
  }

  if (dryRun) {
    for (const file of plan.pending) onEvent(`would apply ${file.filename}`);
    return plan.pending;
  }

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;

    // Re-read under the lock: another runner may have applied these while we
    // were planning, in which case our pending list is already stale.
    const applied = await readAppliedMigrations(tx as unknown as Sql);
    const locked = planMigrations(await readMigrationFiles(dir), applied);

    for (const file of locked.pending) {
      onEvent(`applying ${file.filename}`);
      await tx.unsafe(file.sql);
      await tx.unsafe(
        `insert into ${MIGRATIONS_TABLE} (version, name, checksum) values ($1, $2, $3)`,
        [file.version, file.name, checksum(file.sql)],
      );
    }
  });

  onEvent(`Applied ${plan.pending.length} migration(s).`);
  return plan.pending;
}
