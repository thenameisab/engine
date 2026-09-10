-- 0031: record the HTTP status the crawler actually got.
--
-- `crawled_pages` had no status column, so a page that answered 403 was stored
-- as indistinguishable from one that answered 200. The crawler was not the
-- problem: `crawlPage` reads `response.status()` and puts it on the record, and
-- `validate.ts` checks it — the insert simply never had a column to put it in,
-- so the value was measured, transmitted, validated and dropped.
--
-- Measured consequence, 2026-09-10: production stored tartanhq.com's homepage
-- as 515 characters of CloudFront's "403 ERROR / Request blocked" page, and B2
-- scored the customer's site over it — weak-eeat 0, weak-entity-coverage 0,
-- sparse-internal-linking 0, health 45. Those read as "this site is bad" when
-- they meant "we were served an error page". The row had looked like that
-- since at least 2026-09-09 and nothing could tell.
--
-- Nullable with no backfill. Every existing row predates any status being
-- stored, and a default of 200 would assert that those pages answered 200 —
-- which is exactly the false claim this migration exists to stop. A null reads
-- as "not recorded", and the next crawl of that URL fills it in.
alter table crawled_pages add column status_code integer;

comment on column crawled_pages.status_code is
  'Final HTTP status after redirects. Null for rows written before migration 0031 — not recorded, not assumed to be 200.';
