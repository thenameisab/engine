-- Make findings persistable and re-auditable (M1.3 -> M1.4).
--
-- B1 diagnosis (packages/diagnosis) mints a *deterministic* id per finding —
-- FNV-1a over (entityId, url, issueType) — so the same unresolved issue keeps
-- the same id across crawls. That id is not a uuid and cannot be this table's
-- primary key (actions.finding_id is a uuid FK), but it is exactly the natural
-- key we need: without it, every re-crawl would insert duplicate findings and
-- generate duplicate Actions, and the Fix Queue would fill with the same fix
-- proposed over and over.
--
-- So the diagnosis id is stored as `fingerprint` and made unique per entity.
-- `/audit` upserts on it: re-running an audit refreshes the scoring of a known
-- finding in place and preserves its original created_at (first-seen time).

alter table findings add column fingerprint text;

-- Backfill any pre-existing rows (this table was only ever written by hand
-- during development). `legacy_<id>` is unique by construction, so these rows
-- keep their identity and simply never match a fresh diagnosis fingerprint.
update findings set fingerprint = 'legacy_' || id::text where fingerprint is null;

alter table findings alter column fingerprint set not null;

-- The upsert target for /audit.
create unique index findings_entity_fingerprint_idx on findings (entity_id, fingerprint);
