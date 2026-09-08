import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
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
const MIN_PASSWORD_LENGTH = 12;

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

  const password = await promptNewPassword(`Set a password for ${normalised}`, MIN_PASSWORD_LENGTH);
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
 * Ask for a secret twice, and keep asking until the two agree.
 *
 * Three things this gets right that the first version did not:
 *
 *   **It actually hides the input.** Patching readline's private
 *   `_writeToOutput` silently stopped working — the password was echoed in full
 *   and left in terminal scrollback. Muting a Writable we own instead is not
 *   reliant on an internal that can change under us, and it is testable: the
 *   test asserts the typed value never appears in the output.
 *
 *   **One readline interface, not one per question.** Closing and reopening on
 *   the same stdin can leave a buffered newline that the next interface reads
 *   as an empty line — a mismatch the caller never typed.
 *
 *   **A mistype costs a retry, not the command.** Aborting on the first
 *   mismatch meant re-running everything, which for a prompt you cannot see is
 *   a bad trade.
 */
async function promptNewPassword(label: string, minLength: number): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped: the caller supplied both lines and already has the value. Nothing
    // to hide, and no terminal to hide it from.
    const password = await readPipedLine();
    const confirm = await readPipedLine();
    if (password !== confirm) throw new Error('Passwords did not match.');
    assertLongEnough(password, minLength);
    return password;
  }

  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk as Buffer);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });

  /** Prompt written directly to stdout, so only the *answer* is muted. */
  const askHidden = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    muted = true;
    try {
      return await rl.question('');
    } finally {
      muted = false;
      process.stdout.write('\n');
    }
  };

  try {
    for (let attempt = 1; ; attempt++) {
      const password = await askHidden(`${label} (min ${minLength} characters, not shown): `);
      if (password.length < minLength) {
        if (attempt >= MAX_PASSWORD_ATTEMPTS) assertLongEnough(password, minLength);
        process.stdout.write(`  Too short — ${minLength} characters or more. Try again.\n`);
        continue;
      }
      const confirm = await askHidden('Confirm: ');
      if (password === confirm) return password;
      if (attempt >= MAX_PASSWORD_ATTEMPTS) throw new Error('Passwords did not match.');
      process.stdout.write('  Those did not match. Try again.\n');
    }
  } finally {
    rl.close();
  }
}

const MAX_PASSWORD_ATTEMPTS = 3;

function assertLongEnough(password: string, minLength: number): void {
  if (password.length < minLength) {
    throw new Error(
      `Refusing a password under ${minLength} characters for an account that can configure the platform.`,
    );
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
