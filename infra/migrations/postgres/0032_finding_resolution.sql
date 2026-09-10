-- 0032: let a finding stop being true.
--
-- `upsertFindings` is insert-or-update on (entity_id, fingerprint) and nothing
-- ever deleted a row, so a finding survived every later audit that no longer
-- reported it. The inventory was append-only: once observed, a problem was
-- permanent.
--
-- Measured on 2026-09-10: five findings were computed from CloudFront's 403
-- page — weak-eeat, weak-entity-coverage and sparse-internal-linking among
-- them — and no number of clean crawls could retract them. Worse than a stale
-- read, because `/actions/generate` will build and deploy a fix for a finding
-- that is still listed, so a problem that no longer exists can still be
-- "fixed" against a live site.
--
-- Resolved, not deleted. A finding that was true and is now false is the
-- product's evidence that a fix worked, which is the whole claim of the Fix
-- Queue — deleting the row would throw away the only record that anything
-- improved. `actions.finding_id` is an FK to this table as well, so a delete
-- would cascade away the action history that did the fixing.
--
-- Null means open. Not defaulted and not backfilled: every existing row was
-- written when nothing could resolve anything, so all of them are open by
-- definition, and that is what null already says.
alter table findings add column resolved_at timestamptz;

-- Every read of the inventory now filters on `resolved_at is null`, joined
-- from entities. Impact ordering is part of the same query (§8 leads with the
-- worst thing), so it belongs in the index.
create index findings_entity_open_idx
  on findings (entity_id, predicted_impact desc)
  where resolved_at is null;

comment on column findings.resolved_at is
  'When a later audit re-examined this finding''s page and no longer reported it. Null means open. A recurrence sets it back to null rather than inserting a second row.';
