import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import postgres from 'postgres';
import { hashPassword } from '@engine/auth';
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

    if (command === 'user') {
      await userCommand(sql, args);
      return;
    }

    if (command !== 'migrate') {
      throw new Error(`Unknown command "${command}". Expected "migrate", "status" or "user".`);
    }

    await migrate(sql, { dir: DEFAULT_DIR, dryRun, onEvent: (m) => console.log(`  ${m}`) });
  } finally {
    await sql.end();
  }
}


/* ── users ───────────────────────────────────────────────────────────────── */

/**
 * Create or update a sign-in account, and set its platform role.
 *
 * This exists because the first admin cannot be created through the product:
 * the screen that creates users is itself admin-only. Every later user can be
 * added in the UI; this is the one that breaks the circle.
 *
 * The password is read from a prompt rather than an argument. An argument
 * lands in shell history, in `ps` output, and in any CI log that echoes the
 * command — three places a live credential should never be.
 */
async function userCommand(sql: postgres.Sql, args: string[]): Promise<void> {
  const email = valueOf(args, '--email');
  const role = (valueOf(args, '--role') ?? 'user').toLowerCase();
  const name = valueOf(args, '--name');

  if (!email) throw new Error('Usage: pnpm db:user --email <address> [--name <name>] [--role admin|user]');
  if (role !== 'admin' && role !== 'user') throw new Error(`--role must be "admin" or "user", got "${role}"`);

  const normalised = email.trim().toLowerCase();
  // The same principal shape the login route derives, so a user created here
  // and one created by signing in are the same row rather than two.
  const userId = `local:${normalised}`;

  const password = await promptSecret(`Password for ${normalised}: `);
  if (password.length < 12) {
    throw new Error('Refusing a password under 12 characters for an account that can configure the platform.');
  }
  const confirm = await promptSecret('Confirm password: ');
  if (password !== confirm) throw new Error('Passwords did not match.');

  const hash = await hashPassword(password);

  await sql.begin(async (tx) => {
    await tx`
      insert into users (id, email, name, platform_role)
      values (${userId}, ${normalised}, ${name ?? null}, ${role})
      on conflict (id) do update set
        email = excluded.email,
        name = coalesce(excluded.name, users.name),
        platform_role = excluded.platform_role
    `;
    await tx`
      insert into user_credentials (user_id, password_hash, password_changed_at, updated_at)
      values (${userId}, ${hash}, now(), now())
      on conflict (user_id) do update set
        password_hash = excluded.password_hash,
        password_changed_at = now(),
        updated_at = now()
    `;
  });

  console.log(`  ${userId} is now a platform ${role} and can sign in.`);
}

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/**
 * Read a secret from stdin, without echoing it when there is a terminal.
 *
 * Two paths, because one does not cover both cases. Forcing `terminal: true`
 * on piped stdin makes readline treat a pipe as a TTY and the second prompt
 * never resolves — the command hangs after asking for confirmation, having
 * created nothing.
 *
 * So: a real terminal gets the muted prompt, and a pipe gets a plain line read.
 * Nothing is echoed in the pipe case either, because there is no terminal
 * echoing it — the caller supplied the value and already has it. That also
 * makes the command scriptable, which matters for seeding a fresh deployment.
 */
async function promptSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = asMutable._writeToOutput?.bind(rl);
  let muted = false;
  asMutable._writeToOutput = (chunk: string) => {
    if (!muted) original?.(chunk);
  };
  try {
    const answer = rl.question(prompt);
    muted = true;
    const value = await answer;
    process.stdout.write('\n');
    return value;
  } finally {
    muted = false;
    rl.close();
  }
}

/** One line from piped stdin, consumed a chunk at a time so two reads work. */
let pipedBuffer = '';
let pipedDone = false;

async function readPipedLine(): Promise<string> {
  for (;;) {
    const newline = pipedBuffer.indexOf('\n');
    if (newline !== -1) {
      const line = pipedBuffer.slice(0, newline);
      pipedBuffer = pipedBuffer.slice(newline + 1);
      return line.replace(/\r$/, '');
    }
    if (pipedDone) {
      const rest = pipedBuffer;
      pipedBuffer = '';
      return rest.replace(/\r$/, '');
    }
    const chunk: Buffer | null = await new Promise((resolve) => {
      const onData = (d: Buffer) => {
        cleanup();
        resolve(d);
      };
      const onEnd = () => {
        cleanup();
        resolve(null);
      };
      const cleanup = () => {
        process.stdin.off('data', onData);
        process.stdin.off('end', onEnd);
      };
      process.stdin.on('data', onData);
      process.stdin.on('end', onEnd);
    });
    if (chunk === null) pipedDone = true;
    else pipedBuffer += chunk.toString('utf8');
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
