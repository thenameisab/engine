import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { migrate, planFromDatabase } from './runner.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const DEFAULT_DIR = path.join(REPO_ROOT, 'infra/migrations/postgres');
const DEV_VARS = path.join(REPO_ROOT, 'apps/api/.dev.vars');

/**
 * `DATABASE_URL` from the environment, else from apps/api/.dev.vars — the same
 * file `wrangler dev` reads, so a developer who can run the API can run the
 * migrations without re-pasting a connection string.
 */
async function resolveDatabaseUrl(): Promise<string> {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  try {
    const contents = await readFile(DEV_VARS, 'utf8');
    for (const line of contents.split('\n')) {
      const match = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (match) return match[1]!.replace(/^["']|["']$/g, '');
    }
  } catch {
    // No .dev.vars — fall through to the error below.
  }

  throw new Error(
    'DATABASE_URL is not set. Export it, or add it to apps/api/.dev.vars (see .dev.vars.example).',
  );
}

/** Never log a connection string: it carries the password. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.find((arg) => !arg.startsWith('-')) ?? 'migrate';
  const dryRun = args.includes('--dry-run');

  const url = await resolveDatabaseUrl();
  const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });

  console.log(`→ ${describeTarget(url)}`);

  try {
    if (command === 'status') {
      const plan = await planFromDatabase(sql, DEFAULT_DIR);
      for (const row of plan.applied) console.log(`  applied  ${row.version}_${row.name}`);
      for (const file of plan.pending) console.log(`  pending  ${file.filename}`);
      if (plan.applied.length === 0 && plan.pending.length === 0) console.log('  no migrations found');
      console.log(`\n${plan.applied.length} applied, ${plan.pending.length} pending.`);
      return;
    }

    if (command !== 'migrate') {
      throw new Error(`Unknown command "${command}". Expected "migrate" or "status".`);
    }

    await migrate(sql, { dir: DEFAULT_DIR, dryRun, onEvent: (m) => console.log(`  ${m}`) });
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
