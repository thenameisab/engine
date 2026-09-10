/**
 * The attempt log behind login rate limiting (migration 0033, issue 13).
 *
 * A limit is "at most N attempts of this kind, for this subject, in this
 * window". The subject is an email address or a client IP, and a route
 * usually checks both: the address limit stops one account being hammered
 * from many places, the IP limit stops one place trying many accounts.
 */
import type { Db } from '../db.js';

export type AttemptKind = 'password' | 'code-request' | 'code-verify';

export interface RateLimit {
  kind: AttemptKind;
  subject: string;
  /** Attempts allowed inside the window, inclusive. */
  limit: number;
  windowSeconds: number;
}

export interface RateLimitVerdict {
  allowed: boolean;
  /** Seconds until the oldest counted attempt leaves the window. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Count the attempts in the window and say whether one more is allowed.
 *
 * Read-only: the caller records the attempt separately, after the check, so a
 * request refused here is not itself counted — otherwise a locked-out address
 * could never unlock while someone kept trying.
 */
export async function checkRateLimit(db: Db, rule: RateLimit): Promise<RateLimitVerdict> {
  const rows = await db<{ count: string; oldest: Date | null }[]>`
    select count(*)::text as count, min(created_at) as oldest
    from auth_attempts
    where kind = ${rule.kind}
      and subject = ${rule.subject}
      and created_at > now() - make_interval(secs => ${rule.windowSeconds})
  `;
  const count = Number(rows[0]?.count ?? 0);
  if (count < rule.limit) return { allowed: true, retryAfterSeconds: 0 };
  const oldest = rows[0]?.oldest ? new Date(rows[0].oldest).getTime() : Date.now();
  const retryAfterSeconds = Math.max(1, Math.ceil((oldest + rule.windowSeconds * 1000 - Date.now()) / 1000));
  return { allowed: false, retryAfterSeconds };
}

/**
 * Record one attempt. Prunes anything older than a day on the way past: no
 * window is that long, so those rows can never change a verdict.
 */
export async function recordAttempt(db: Db, kind: AttemptKind, subject: string): Promise<void> {
  await db`insert into auth_attempts (kind, subject) values (${kind}, ${subject})`;
  await db`delete from auth_attempts where created_at < now() - interval '1 day'`;
}

/** The first rule that refuses, or null when every rule allows. */
export async function firstRefusal(db: Db, rules: RateLimit[]): Promise<RateLimitVerdict | null> {
  for (const rule of rules) {
    const verdict = await checkRateLimit(db, rule);
    if (!verdict.allowed) return verdict;
  }
  return null;
}
