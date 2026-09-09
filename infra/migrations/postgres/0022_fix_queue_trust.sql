-- Fix Queue trust: the three facts a proposed fix needs before a customer can
-- be asked to approve it (docs/reviews/2026-09-08-ship-readiness-review.md, B6).
--
-- 1. Page headings, so a proposed <title> can be written from what the page is
--    about instead of the brand name alone. The crawler already collects them;
--    only the fix-relevant slice was persisted, and headings were not in it.
-- 2. The kind of thing a brand is, so generated JSON-LD carries a real
--    schema.org type instead of the `Thing` supertype.
-- 3. Who read a fix and when, so a wording change cannot be approved by a
--    click that never showed the wording.

alter table crawled_pages
  add column headings jsonb not null default '[]'::jsonb;

-- Every entity in Engine today is the business or brand a site belongs to, so
-- 'Organization' is the correct backfill, not a guess. The customer picks a
-- more specific kind (LocalBusiness, Product, …) when they set up a site or
-- edit the brand.
alter table entities
  add column schema_type text not null default 'Organization';

alter table actions
  add column reviewed_at timestamptz,
  add column reviewed_by text;
