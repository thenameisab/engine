-- What kind of thing an account is: a company, an agency, or one person.
--
-- Onboarding has asked this since step 5 — "This site belongs to: a company ·
-- an agency's client · me" — and thrown the answer away. It was used locally to
-- pick the account name and the entity kind (`Organization` or `Person`), and
-- `onSubmit` then called `POST /accounts` with `{ name }` alone. So the product
-- collected the one fact that decides how it should speak to a customer and had
-- no way to read it back.
--
-- Three consequences, all live on main: the agency-only branding panel has no
-- data to gate on, so it is shown to a company that has no clients to brand
-- for; the client vocabulary ("Clients", "New client") is shown to an
-- individual with exactly one site; and nothing can hide the client layer that
-- step 1 said should be hidden for non-agencies.
--
-- `company` as the default, because that is what onboarding preselects and what
-- every row created before this migration was implicitly treated as. A check
-- constraint rather than an enum type: the same three values are already a
-- closed union in `packages/core` and in the dashboard's `SITE_OWNER_KINDS`, and
-- a check is alterable in one statement where an enum needs a type migration.
alter table accounts
  add column kind text not null default 'company'
  check (kind in ('company', 'agency', 'individual'));
