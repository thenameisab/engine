/**
 * One-time sign-in codes (migration 0033).
 *
 * The code exists in plaintext exactly twice: in the email, and in the
 * request that presents it back. What the table holds is SHA-256 over
 * `<row id>:<code>`, compared timing-safe.
 */
import { timingSafeEqual } from '@engine/auth';
import type { Db } from '../db.js';

/** Ten minutes: long enough to open an inbox, short enough that a leaked mailbox is a narrow window. */
export const LOGIN_CODE_TTL_SECONDS = 10 * 60;
/** Guesses one code tolerates before it is dead. */
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
const CODE_DIGITS = 6;

/** Six random digits, from the CSPRNG, leading zeros kept. */
export function generateLoginCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

async function hashCode(id: string, code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${id}:${code}`));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/** Store a fresh code for an address and return the plaintext to send. */
export async function createLoginCode(db: Db, email: string): Promise<{ id: string; code: string; expiresAt: Date }> {
  const address = email.trim().toLowerCase();
  const code = generateLoginCode();
  const expiresAt = new Date(Date.now() + LOGIN_CODE_TTL_SECONDS * 1000);
  // Two statements, because the hash needs the id and the id comes from the
  // insert. The interim row has a placeholder hash that matches no code.
  const [row] = await db<{ id: string }[]>`
    insert into login_codes (email, code_hash, expires_at)
    values (${address}, 'pending', ${expiresAt})
    returning id
  `;
  const id = row!.id;
  await db`update login_codes set code_hash = ${await hashCode(id, code)} where id = ${id}`;
  return { id, code, expiresAt };
}

export type VerifyCodeResult =
  | { ok: true }
  /** No live code for the address, or the guess was wrong. One answer for both, so the endpoint is not an oracle. */
  | { ok: false };

/**
 * Check a presented code against the newest live code for the address.
 *
 * Every call counts as an attempt against that code, and a code that has
 * spent its attempts is dead even if the next guess is right. A correct code
 * is consumed in the same statement that confirms it, so two concurrent
 * presentations of one code sign in at most one of them.
 */
export async function verifyLoginCode(db: Db, email: string, code: string): Promise<VerifyCodeResult> {
  const address = email.trim().toLowerCase();
  const [row] = await db<{ id: string; code_hash: string; attempts: number }[]>`
    select id, code_hash, attempts
    from login_codes
    where email = ${address}
      and consumed_at is null
      and expires_at > now()
      and code_hash <> 'pending'
    order by created_at desc
    limit 1
  `;
  if (!row) return { ok: false };
  if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) return { ok: false };

  const matches = timingSafeEqual(await hashCode(row.id, code), row.code_hash);
  if (!matches) {
    await db`update login_codes set attempts = attempts + 1 where id = ${row.id}`;
    return { ok: false };
  }
  const consumed = await db<{ id: string }[]>`
    update login_codes
    set consumed_at = now()
    where id = ${row.id} and consumed_at is null
    returning id
  `;
  return consumed.length === 1 ? { ok: true } : { ok: false };
}

/** Codes sent to an address in the last `windowSeconds` — the request throttle. */
export async function countRecentCodes(db: Db, email: string, windowSeconds: number): Promise<number> {
  const address = email.trim().toLowerCase();
  const rows = await db<{ count: string }[]>`
    select count(*)::text as count
    from login_codes
    where email = ${address} and created_at > now() - make_interval(secs => ${windowSeconds})
  `;
  return Number(rows[0]?.count ?? 0);
}
