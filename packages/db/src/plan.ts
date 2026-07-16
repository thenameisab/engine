import { createHash } from 'node:crypto';

/** A migration file on disk, already read. */
export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  sql: string;
}

/** A row of `schema_migrations` — what the database believes it has run. */
export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
}

export interface MigrationPlan {
  pending: MigrationFile[];
  applied: AppliedMigration[];
}

/** sha256 of the migration body, hex. Stored so drift is detectable. */
export function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

const FILENAME_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * `0001_init.sql` → { version: '0001', name: 'init' }. Strict on purpose: a
 * file that does not match is a mistake we want to hear about, not skip
 * silently — a migration that never runs is worse than one that fails loudly.
 */
export function parseMigrationFilename(filename: string): { version: string; name: string } {
  const match = FILENAME_RE.exec(filename);
  if (!match) {
    throw new Error(
      `Migration filename "${filename}" must look like 0001_snake_case_name.sql (4-digit version, lowercase name).`,
    );
  }
  return { version: match[1]!, name: match[2]! };
}

/**
 * Decide what still needs to run.
 *
 * Three things are errors rather than warnings, because each one means the
 * schema in front of us is not the schema the files describe:
 *
 *  - **Drift**: an applied migration's body changed since it ran. The database
 *    can't be re-derived from the files any more, so we stop instead of
 *    pretending the tree is the source of truth.
 *  - **Out-of-order**: a pending version sorts below one already applied.
 *    Running it now would produce a schema no fresh `migrate` could reproduce.
 *  - **Unknown**: the database has a version with no file. Usually a rollback
 *    of code without a rollback of schema; guessing is not safe.
 */
export function planMigrations(files: MigrationFile[], applied: AppliedMigration[]): MigrationPlan {
  const sorted = [...files].sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const file of sorted) {
    if (seen.has(file.version)) {
      throw new Error(`Duplicate migration version ${file.version} (${file.filename}).`);
    }
    seen.add(file.version);
  }

  const appliedByVersion = new Map(applied.map((row) => [row.version, row]));

  const drifted: string[] = [];
  for (const file of sorted) {
    const row = appliedByVersion.get(file.version);
    if (row && row.checksum !== checksum(file.sql)) drifted.push(file.filename);
  }
  if (drifted.length > 0) {
    throw new Error(
      `Migration drift: ${drifted.join(', ')} changed after being applied. ` +
        `Applied migrations are immutable — add a new migration instead of editing an old one.`,
    );
  }

  const unknown = applied.filter((row) => !seen.has(row.version));
  if (unknown.length > 0) {
    throw new Error(
      `Database has migrations with no matching file: ${unknown
        .map((row) => `${row.version}_${row.name}`)
        .join(', ')}. The database is ahead of this checkout.`,
    );
  }

  const pending = sorted.filter((file) => !appliedByVersion.has(file.version));

  const highestApplied = applied.map((row) => row.version).sort((a, b) => a.localeCompare(b)).at(-1);
  if (highestApplied) {
    const outOfOrder = pending.filter((file) => file.version.localeCompare(highestApplied) < 0);
    if (outOfOrder.length > 0) {
      throw new Error(
        `Out-of-order migrations: ${outOfOrder
          .map((file) => file.filename)
          .join(', ')} sort before the applied ${highestApplied}. Renumber them above it.`,
      );
    }
  }

  return { pending, applied };
}
