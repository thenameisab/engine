/**
 * M2.5 agency white-label: accounts, the users who belong to them, and the
 * projects (clients) each account owns. Before this, `accounts`/`projects`
 * existed only as rows seeded straight into Postgres — no route created
 * either, and no table linked a signed-in identity to an account at all.
 */
import type { Account, AccountBranding, AccountKind, Project } from '@engine/core';
import { toJsonb, type Db } from '../db.js';

interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  branding: AccountBranding;
  created_at: Date;
}

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    branding: row.branding ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

interface ProjectRow {
  id: string;
  account_id: string;
  name: string;
  domain: string;
  created_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    domain: row.domain,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Lazily sync the authenticated caller into `users` so `account_members` has
 * a real row to FK against. There is no Neon Auth webhook wired, so this runs
 * once per request instead of once per signup — `on conflict` makes repeated
 * calls a no-op update rather than a duplicate-key error.
 */
export async function upsertUser(
  db: Db,
  user: { id: string; email?: string; name?: string },
): Promise<void> {
  await db`
    insert into users (id, email, name)
    values (${user.id}, ${user.email ?? null}, ${user.name ?? null})
    on conflict (id) do update set email = excluded.email, name = excluded.name
  `;
}

/** Whether any user row carries this address — the email sign-in gate's first list. */
export async function hasUserWithEmail(db: Db, email: string): Promise<boolean> {
  const rows = await db<{ one: number }[]>`
    select 1 as one from users where lower(email) = ${email.trim().toLowerCase()} limit 1
  `;
  return rows.length === 1;
}

/**
 * The `users` row for an email sign-in, created if missing.
 *
 * Unlike `upsertUser`, this never overwrites `name`: a code sign-in knows the
 * address and nothing else, and writing null over a name the person set from
 * the roster or the CLI would erase it on every login.
 */
export async function ensureLocalUser(db: Db, user: { id: string; email: string }): Promise<{ id: string; email: string; name: string | null }> {
  const [row] = await db<{ id: string; email: string; name: string | null }[]>`
    insert into users (id, email, name)
    values (${user.id}, ${user.email}, null)
    on conflict (id) do update set email = excluded.email
    returning id, email, name
  `;
  return row!;
}

/**
 * Create an account and make the caller its owner, in one call.
 *
 * One transaction, because the two rows are one fact. `listAccountsForUser`
 * reaches accounts only by joining `account_members`, so an account whose
 * member insert failed is invisible to every user — including the person who
 * just created it, who sees an error and tries again. Nothing lists it, nothing
 * cleans it up, and no later query notices: the row is simply orphaned.
 */
export async function createAccount(
  db: Db,
  name: string,
  ownerUserId: string,
  kind: AccountKind = 'company',
): Promise<Account> {
  return db.begin(async (tx) => {
    const [row] = await tx<AccountRow[]>`
      insert into accounts (name, kind)
      values (${name}, ${kind})
      returning id, name, kind, branding, created_at
    `;
    await tx`
      insert into account_members (account_id, user_id, role)
      values (${row.id}, ${ownerUserId}, 'owner')
    `;
    return toAccount(row);
  }) as Promise<Account>;
}

export async function isAccountMember(db: Db, accountId: string, userId: string): Promise<boolean> {
  const rows = await db`
    select 1 from account_members where account_id::text = ${accountId} and user_id = ${userId}
  `;
  return rows.length > 0;
}

/**
 * The caller's role on an account, or null if they are not a member.
 *
 * `isAccountMember` answers "may they read this?", which was the only question
 * every route before this needed. Connecting or disconnecting a Google account
 * is different: the credential is shared by the whole account, so a `member`
 * revoking it breaks every project's data sync for everyone. That is an owner
 * decision, and distinguishing the two requires the role, not just membership.
 */
export async function getAccountRole(db: Db, accountId: string, userId: string): Promise<'owner' | 'member' | null> {
  const rows = await db<{ role: 'owner' | 'member' }[]>`
    select role from account_members where account_id::text = ${accountId} and user_id = ${userId}
  `;
  return rows[0]?.role ?? null;
}

/**
 * Change what kind of thing an account is.
 *
 * Returns the stored row rather than echoing the requested kind, so the
 * Settings select re-renders from what the database actually holds.
 */
export async function setAccountKind(db: Db, accountId: string, kind: AccountKind): Promise<Account | null> {
  const [row] = await db<AccountRow[]>`
    update accounts set kind = ${kind} where id::text = ${accountId}
    returning id, name, kind, branding, created_at
  `;
  return row ? toAccount(row) : null;
}

/**
 * How many accounts this user belongs to — the agency downgrade guard.
 *
 * An agency's clients are not a parent/child link; they are simply the other
 * accounts the same person belongs to, which is how `listAccountsForUser` and
 * the Integrations "connected under another client" note already read them.
 * So the question "does this agency still have clients?" is a count of
 * memberships, not a column.
 */
export async function countAccountsForUser(db: Db, userId: string): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from account_members where user_id = ${userId}
  `;
  return row?.n ?? 0;
}

/** Resolves a project to its owning account, so a project-scoped route can check membership. */
export async function getProjectAccountId(db: Db, projectId: string): Promise<string | null> {
  const rows = await db<{ account_id: string }[]>`
    select account_id from projects where id::text = ${projectId}
  `;
  return rows[0]?.account_id ?? null;
}

/**
 * Every account a user belongs to, each with its project list — the
 * multi-client grid's data source. Scoped by `userId`, not a caller-supplied
 * `accountId`, so there is no cross-tenant path here to check: a user can
 * only ever see rows their own `account_members` membership joins to.
 */
export async function listAccountsForUser(
  db: Db,
  userId: string,
): Promise<Array<Account & { projects: Project[]; role: 'owner' | 'member' }>> {
  // `m.role` rides along because the join is already here. Settings needs it to
  // render the account-type control read-only for a member instead of offering
  // a select the API would refuse — the caller's own role on their own account
  // should not cost a second request.
  const accountRows = await db<(AccountRow & { role: 'owner' | 'member' })[]>`
    select a.id, a.name, a.kind, a.branding, a.created_at, m.role
    from accounts a
    join account_members m on m.account_id = a.id
    where m.user_id = ${userId}
    order by a.created_at desc
  `;
  const accounts = accountRows.map((row) => ({ ...toAccount(row), role: row.role }));

  const projectRows = accounts.length > 0
    ? await db<ProjectRow[]>`
        select id, account_id, name, domain, created_at
        from projects
        where account_id::text = any(${accounts.map((a) => a.id)})
        order by created_at desc
      `
    : [];
  const projectsByAccount = new Map<string, Project[]>();
  for (const row of projectRows.map(toProject)) {
    const list = projectsByAccount.get(row.accountId) ?? [];
    list.push(row);
    projectsByAccount.set(row.accountId, list);
  }

  return accounts.map((a) => ({ ...a, projects: projectsByAccount.get(a.id) ?? [] }));
}

export async function createProject(
  db: Db,
  accountId: string,
  project: { name: string; domain: string },
): Promise<Project> {
  const [row] = await db<ProjectRow[]>`
    insert into projects (account_id, name, domain)
    values (${accountId}, ${project.name}, ${project.domain})
    returning id, account_id, name, domain, created_at
  `;
  return toProject(row);
}

/**
 * Rename a site.
 *
 * The name only. `domain` is what every crawled page, audit run and finding in
 * this project was gathered from, so changing it would leave all of that
 * history describing a site this project is no longer pointed at. Pointing
 * Engine at a different address is adding a site, not renaming one.
 */
export async function renameProject(db: Db, projectId: string, name: string): Promise<Project | null> {
  const rows = await db<ProjectRow[]>`
    update projects set name = ${name} where id::text = ${projectId}
    returning id, account_id, name, domain, created_at
  `;
  return rows[0] ? toProject(rows[0]) : null;
}

export async function getProject(db: Db, projectId: string): Promise<Project | null> {
  const rows = await db<ProjectRow[]>`
    select id, account_id, name, domain, created_at from projects where id = ${projectId}
  `;
  return rows[0] ? toProject(rows[0]) : null;
}

export async function listProjectsByAccount(db: Db, accountId: string): Promise<Project[]> {
  const rows = await db<ProjectRow[]>`
    select id, account_id, name, domain, created_at
    from projects
    where account_id::text = ${accountId}
    order by created_at desc
  `;
  return rows.map(toProject);
}

export async function getAccount(db: Db, accountId: string): Promise<Account | null> {
  const rows = await db<AccountRow[]>`
    select id, name, kind, branding, created_at from accounts where id::text = ${accountId}
  `;
  return rows[0] ? toAccount(rows[0]) : null;
}

/**
 * Apply a branding patch, one field at a time.
 *
 * `PATCH` promises a partial update, so this merges rather than replaces: a
 * field the caller did not send keeps its stored value. It used to assign
 * `branding = <body>` outright, so saving one field from a form that held only
 * that field silently wiped the other two.
 *
 * `set` writes values; `clear` removes keys. Removal has to delete the key, not
 * store `''`, because every reader falls back with `branding.companyName ??
 * account.name` — an empty string is not null, so it would defeat the fallback
 * and render a blank name and an `<img src="">`.
 *
 * One statement rather than read-modify-write, so two concurrent saves cannot
 * interleave and lose a field. `branding` is `not null default '{}'`, so the
 * left side of `||` never needs a coalesce.
 */
export async function updateAccountBranding(
  db: Db,
  accountId: string,
  patch: { set: AccountBranding; clear: string[] },
): Promise<Account> {
  const [row] = await db<AccountRow[]>`
    update accounts
    set branding = (branding || ${toJsonb(db, patch.set)}) - ${patch.clear}::text[]
    where id::text = ${accountId}
    returning id, name, kind, branding, created_at
  `;
  return toAccount(row);
}
