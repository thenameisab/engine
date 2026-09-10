-- Let an audit run say what the crawl could reach, not only what it found.
--
-- Production's last crawl audited **one page**. The Audit screen showed a thin
-- finding list, which reads as "your site is nearly clean" when it actually
-- means "we only ever saw your home page". The number of pages was already
-- stored; the *reason* was thrown away with the crawler's process, so nothing
-- could tell a customer whether their sitemap was unreachable, their links
-- unfollowable, their robots.txt in the way, or their page budget spent.
--
-- Every column is nullable. Runs recorded before this migration genuinely have
-- no coverage to report, and inventing a plausible zero for them would be
-- worse than admitting it: "no sitemap found" and "we did not record whether a
-- sitemap was found" are different statements, and only one of them is true of
-- an old row.
alter table audit_runs
  add column robots_found boolean,
  add column sitemap_urls integer,
  add column links_discovered integer,
  add column blocked_by_robots integer,
  add column stopped_at_limit boolean,
  add column max_pages integer;
