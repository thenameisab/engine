/**
 * The server-side half of an in-flight OAuth consent (migration 0018).
 *
 * Two jobs, and both are security properties rather than conveniences:
 *
 *   **Hold the PKCE verifier.** It cannot ride in the signed `state`, which is
 *   unforgeable but not secret — it travels in a query string through the
 *   customer's browser and into the vendor's logs. A verifier visible next to
 *   the code it protects protects nothing.
 *
 *   **Spend the state once.** `claimFlow` is a conditional UPDATE, so two
 *   callbacks racing the same nonce cannot both succeed. Without it a captured
 *   callback URL is replayable for the ten minutes until the state expires.
 */
import { loadKeyring, sealCredential, openCredential, type Keyring } from '@engine/integrations';
import type { Db } from '../db.js';

/** Matches the signed state's default TTL in `@engine/auth`. */
const FLOW_TTL_SECONDS = 600;

/**
 * A flow's verifier is sealed with the same AAD shape as a credential, under a
 * provider id suffixed so a flow blob and a credential blob can never be
 * swapped for one another even within the same account and provider.
 */
function flowAadProvider(provider: string): string {
  return `oauth-flow:${provider}`;
}

export interface StartFlowInput {
  nonce: string;
  accountId: string;
  provider: string;
  userId: string;
  codeVerifier: string;
  returnTo?: string;
}

export async function startFlow(db: Db, keyring: Keyring, input: StartFlowInput): Promise<void> {
  const sealed = await sealCredential(keyring, input.accountId, flowAadProvider(input.provider), {
    kind: 'oauth2',
    refreshToken: input.codeVerifier,
  });
  await db`
    insert into oauth_flows (
      nonce, account_id, provider, user_id, code_verifier_sealed, key_version, return_to, expires_at
    )
    values (
      ${input.nonce}, ${input.accountId}, ${input.provider}, ${input.userId},
      ${sealed.sealed}, ${sealed.keyVersion}, ${input.returnTo ?? null},
      now() + ${`${FLOW_TTL_SECONDS} seconds`}::interval
    )
    on conflict (nonce) do nothing
  `;
}

export type ClaimResult =
  | { ok: true; codeVerifier: string; returnTo?: string }
  | { ok: false; reason: 'unknown' | 'already-used' | 'expired' | 'unsealable' };

/**
 * Claim a flow, atomically.
 *
 * The UPDATE ... WHERE consumed_at is null is what makes this single-use: the
 * database decides the winner, so two callbacks arriving together cannot both
 * read "unconsumed" and both proceed. A conditional read followed by a write
 * would have exactly that race, and it is the one an attacker replaying a
 * captured URL is trying to win.
 *
 * A row that exists but was already consumed is reported distinctly from one
 * that never existed. The user-facing message is the same, but the two mean
 * very different things in a log — the first is a replay.
 */
export async function claimFlow(
  db: Db,
  keyring: Keyring,
  nonce: string,
  accountId: string,
  provider: string,
): Promise<ClaimResult> {
  const rows = await db<
    { code_verifier_sealed: string; key_version: string; return_to: string | null; expired: boolean }[]
  >`
    update oauth_flows
    set consumed_at = now()
    where nonce = ${nonce}
      and account_id::text = ${accountId}
      and provider = ${provider}
      and consumed_at is null
    returning code_verifier_sealed, key_version, return_to, (expires_at <= now()) as expired
  `;

  if (rows.length === 0) {
    const existing = await db<{ consumed_at: Date | null }[]>`
      select consumed_at from oauth_flows where nonce = ${nonce}
    `;
    return { ok: false, reason: existing[0] ? 'already-used' : 'unknown' };
  }

  const row = rows[0];
  // Consumed above regardless, so an expired flow is also burned rather than
  // left claimable by a later, luckier attempt.
  if (row.expired) return { ok: false, reason: 'expired' };

  try {
    const opened = await openCredential(keyring, accountId, flowAadProvider(provider), {
      kind: 'oauth2',
      sealed: row.code_verifier_sealed,
      keyVersion: row.key_version,
      public: {},
    });
    /* c8 ignore next -- sealed above as 'oauth2', so this is always the branch. */
    if (opened.credential.kind !== 'oauth2') return { ok: false, reason: 'unsealable' };
    return { ok: true, codeVerifier: opened.credential.refreshToken, returnTo: row.return_to ?? undefined };
  } catch {
    // A key dropped from the keyring mid-flow. Reported rather than thrown: the
    // user's fix is to start again, and the flow is already burned.
    return { ok: false, reason: 'unsealable' };
  }
}

/**
 * Delete expired, unclaimed flows.
 *
 * Called from the scheduled handler. Consumed rows are removed too, on a longer
 * lag, so a replay attempt shortly after a legitimate callback still finds the
 * 'already-used' row rather than an empty table — the distinction is worth an
 * hour of retention.
 */
export async function reapExpiredFlows(db: Db): Promise<number> {
  const rows = await db`
    delete from oauth_flows
    where (consumed_at is null and expires_at <= now())
       or (consumed_at is not null and consumed_at <= now() - interval '1 hour')
    returning nonce
  `;
  return rows.length;
}

/** Load the deployment's encryption keyring, accepting the single-key form. */
export async function keyringFrom(env: { ENCRYPTION_KEYS?: string; ENCRYPTION_KEY?: string }): Promise<Keyring> {
  return loadKeyring(env.ENCRYPTION_KEYS ?? env.ENCRYPTION_KEY);
}
