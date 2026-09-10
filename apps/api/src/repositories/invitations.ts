/**
 * Account invitations (migration 0033, issue 1b).
 *
 * An invitation says "this address may join this account as this role". It
 * carries no secret: the invitee proves the address by signing in with a code
 * sent to it, and that sign-in accepts every open invitation for the address.
 * Membership is written to `account_members` and nowhere else.
 */
import type { Db } from '../db.js';

/** A week. Long enough to be read on Monday, short enough that a stale invite is not a standing door. */
export const INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60;

export type MemberRole = 'owner' | 'member';

export interface Invitation {
  id: string;
  accountId: string;
  email: string;
  role: MemberRole;
  invitedBy: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

interface InvitationRow {
  id: string;
  account_id: string;
  email: string;
  role: MemberRole;
  invited_by: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  created_at: Date;
}

function toInvitation(r: InvitationRow): Invitation {
  return {
    id: r.id,
    accountId: r.account_id,
    email: r.email,
    role: r.role,
    invitedBy: r.invited_by,
    expiresAt: r.expires_at.toISOString(),
    acceptedAt: r.accepted_at ? r.accepted_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

/**
 * Invite an address to an account, or refresh the open invitation it already
 * has. Refreshing rather than duplicating: the unique index allows one open
 * row per (account, email), and a second invite means "send it again", which
 * is a new expiry and a new email, not a new fact.
 */
export async function createInvitation(
  db: Db,
  input: { accountId: string; email: string; role: MemberRole; invitedBy: string },
): Promise<Invitation> {
  const address = input.email.trim().toLowerCase();
  const expiresAt = new Date(Date.now() + INVITATION_TTL_SECONDS * 1000);
  const [row] = await db<InvitationRow[]>`
    insert into invitations (account_id, email, role, invited_by, expires_at)
    values (${input.accountId}, ${address}, ${input.role}, ${input.invitedBy}, ${expiresAt})
    on conflict (account_id, email) where accepted_at is null do update set
      role = excluded.role,
      invited_by = excluded.invited_by,
      expires_at = excluded.expires_at
    returning id, account_id, email, role, invited_by, expires_at, accepted_at, created_at
  `;
  return toInvitation(row!);
}

/** Open, unexpired invitations for an account — the owner's pending list. */
export async function listOpenInvitations(db: Db, accountId: string): Promise<Invitation[]> {
  const rows = await db<InvitationRow[]>`
    select id, account_id, email, role, invited_by, expires_at, accepted_at, created_at
    from invitations
    where account_id = ${accountId} and accepted_at is null and expires_at > now()
    order by created_at desc
  `;
  return rows.map(toInvitation);
}

/** Withdraw an open invitation. True when a row was removed. */
export async function deleteInvitation(db: Db, accountId: string, invitationId: string): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    delete from invitations
    where id = ${invitationId} and account_id = ${accountId} and accepted_at is null
    returning id
  `;
  return rows.length === 1;
}

/** Whether any open, unexpired invitation names this address — the sign-in gate's second list. */
export async function hasOpenInvitation(db: Db, email: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const rows = await db<{ one: number }[]>`
    select 1 as one from invitations
    where email = ${address} and accepted_at is null and expires_at > now()
    limit 1
  `;
  return rows.length === 1;
}

/**
 * Turn every open invitation for an address into a membership for the user
 * who just proved they own it. One transaction: the membership and the
 * acceptance are one fact, and a membership written without the acceptance
 * would re-fire on the next sign-in.
 *
 * Returns the account ids joined, for the response and the log.
 */
export async function acceptInvitations(db: Db, email: string, userId: string): Promise<string[]> {
  const address = email.trim().toLowerCase();
  return db.begin(async (tx) => {
    const open = await tx<{ id: string; account_id: string; role: MemberRole }[]>`
      select id, account_id, role from invitations
      where email = ${address} and accepted_at is null and expires_at > now()
      for update
    `;
    if (open.length === 0) return [];
    for (const inv of open) {
      // An existing member keeps their current role: an invite cannot demote
      // an owner to member by being accepted late.
      await tx`
        insert into account_members (account_id, user_id, role)
        values (${inv.account_id}, ${userId}, ${inv.role})
        on conflict (account_id, user_id) do nothing
      `;
    }
    await tx`update invitations set accepted_at = now() where id = any(${open.map((o) => o.id)}::uuid[])`;
    return [...new Set(open.map((o) => o.account_id))];
  });
}
