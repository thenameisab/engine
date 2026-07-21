-- C3 added the 'internal-link' ActionType (packages/core/src/contract.ts), but
-- the actions.type CHECK constraint from 0001_init still listed only the
-- original six types. The generator built a valid internal-link action and the
-- insert then failed the constraint (SQLSTATE 23514) — caught live driving the
-- propose route against the real DB. Rebuild the constraint with the full
-- current ActionType vocabulary so an internal-link (and any future type) can
-- persist.
alter table actions drop constraint actions_type_check;
alter table actions add constraint actions_type_check
  check (type in ('schema', 'meta', 'redirect', 'robots', 'content', 'internal-link', 'gbp'));
