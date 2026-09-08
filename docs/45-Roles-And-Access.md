# Engine — Roles and access

**Status:** v1.0 · Last updated 2026-09-08
**Source of truth in code:** `users.platform_role` (migration 0020),
`account_members.role` (migration 0006).

---

## Two independent axes

"Admin" was one word covering two unrelated questions. Separating them is what
this document exists to record.

**Platform role** — *does this person work on Engine?*
`users.platform_role` is `admin` or `user`. It decides who may configure
Engine's own OAuth client and who may promote other people. It has nothing to do
with any customer account.

**Account role** — *what may this person do inside one customer account?*
`account_members.role` is `owner` or `member`. An owner may connect and
disconnect that account's integrations, because the credential is shared by
everyone in the account. This existed before and is unchanged.

The two do not interact. A platform admin who is not a member of an account has
no access to that account's data, and a platform user who owns an account has
full control of it.

---

## What each role can do, against the current feature set

| Surface | `user` | `admin` |
|---|---|---|
| Pulse, SERP Inspector, Fix Queue, Audit | Own accounts' projects | Own accounts' projects |
| Entity Graph, Competitors, Backlinks, Local SEO | Own accounts' projects | Own accounts' projects |
| Clients (accounts and projects) | Own accounts | Own accounts |
| Integrations — connect / disconnect | Own account, **owner** role only | Own account, **owner** role only |
| Integrations — assign a property to a project | Own account, any member | Own account, any member |
| Integration audit trail (`integration_events`) | Own account, **owner** role only | Own account, **owner** role only |
| **Settings → Platform: Engine's OAuth client** | Hidden · API returns 404 | Full |
| **Settings → Platform: Users and roles** | Hidden · API returns 404 | Full |
| **Platform wiring (`/health/integrations`)** | Hidden · API returns 404 | Full |

The first six rows are identical in both columns. **That is deliberate.**

### Why an admin has no extra access to customer data

It would be easy to let a platform admin read every customer's Pulse and Audit,
and a support person will eventually want exactly that. It is not here because
it is a different decision with different consequences: every such read is a
staff member looking at a customer's private data, and doing it properly needs a
reason recorded per access, not a boolean on a row.

So `isAccountMember` still governs all customer data, for admins and users
alike. When support access is built it should be a distinct, time-boxed,
audited grant — not an implication of this role.

---

## Why the platform screens answer 404, not 403

A 403 tells the caller that the endpoint exists and that this deployment has
administrators. That is information a customer has no reason to hold, and it
tells someone probing the API exactly which routes are worth attacking. A 404 is
indistinguishable from a route that was never built.

---

## Two refusals the API will not let you past

**You cannot remove your own admin access.** Almost always a misclick, and on a
one-admin deployment it locks the platform screens for everyone.

**The last admin cannot be demoted by anyone.** Zero admins means Engine's OAuth
client can never be changed through the product again, and recovery requires
direct database access.

The count and the update happen in one transaction, so two concurrent demotions
cannot each observe two admins and both proceed.

---

## Bootstrap: creating the first admin

The screen that creates users is itself admin-only, so the first admin cannot be
made in the product. Two ways to break that circle.

**Preferred — the CLI.** The password is prompted, never passed as an argument:
an argument lands in shell history, in `ps` output, and in any CI log that
echoes the command.

```bash
DATABASE_URL='<neon connection string>' pnpm db:user --email you@example.com --role admin
```

It creates the `users` row, sets `platform_role`, and writes a PBKDF2 credential
so the account can sign in. Run again for the same address to reset the password
or change the role. It refuses a password under 12 characters for an account
that can configure the platform.

**Fallback — `PLATFORM_ADMIN_EMAILS`.** A comma-separated list read only when a
user has *no row yet*, which is true on a first sign-in. Once a real admin
exists the variable can be emptied.

The stored role wins over the list, deliberately. If the list overrode the
database, an admin demoted in the product would keep access until someone edited
a Cloudflare variable.

Deliberately **not** `ALLOWED_EMAILS`: that is who may *use* Engine. Reusing it
would make every customer a platform admin the moment one is invited.

An unreachable database denies rather than falling back to the list — otherwise
a demoted admin regains access whenever the database hiccups.

---

## Audit

`user_role_events` records every promotion and demotion: who, whom, from, to,
when. Append-only, with no foreign keys, so the trail survives the deletion of
either party — a promotion that vanishes when the promoted user is removed is
the record you would most want to still have.

Promotion is the most consequential action in the product. It grants the ability
to replace Engine's OAuth client, which every customer's connection depends on,
and to create further admins.
