-- Let the crawl queue carry verification work as well as crawls.
--
-- "Verified" has been a lane in the Fix Queue since M1.4 and nothing has ever
-- put an action into it on its own. The only route to it was a Verify button
-- that asked the *browser* to supply the deployed page's HTML, which the
-- browser does not have and cannot fetch cross-origin — so the button posted
-- an empty string, the matcher compared it against the proposed diff, and it
-- failed every single time. A control that cannot succeed is worse than no
-- control: it teaches the customer that deploys do not stick.
--
-- Verification is a machine step. It needs something that can fetch a URL from
-- outside the browser, and the crawl runner already is that. A `kind` column on
-- the existing queue rather than a second table, so one runner drains one
-- queue and there is one place to look when work is stuck.
alter table audit_requests
  add column kind text not null default 'crawl' check (kind in ('crawl', 'verify')),
  -- Which fix is being checked. Null for a crawl; required for a verify, which
  -- the check constraint below enforces rather than leaving to the caller.
  add column action_id uuid references actions(id) on delete cascade,
  -- Set when a verify request completed: true when the deployed page carried
  -- the change, false when it did not. Null while queued, and null forever on a
  -- crawl. Three states, because "we looked and it is not there yet" is a
  -- different thing to tell a customer than "we have not looked".
  add column verified boolean;

alter table audit_requests
  add constraint audit_requests_verify_has_action
  check ((kind = 'verify') = (action_id is not null));

-- The Fix Queue card reads the newest verify request for one action.
create index audit_requests_action_created_idx
  on audit_requests (action_id, created_at desc)
  where action_id is not null;

-- "One live request per project" was written when the only request was a crawl.
-- A verify request would now collide with a running crawl and be silently
-- dropped as a duplicate — the fix would deploy and never be checked, which is
-- exactly the state this migration exists to end. The rule still holds for
-- crawls, which are expensive and must not double up; verifies are one HTTP
-- GET each and are keyed per action instead.
drop index audit_requests_one_live_per_project;
create unique index audit_requests_one_live_crawl_per_project on audit_requests (project_id)
  where kind = 'crawl' and status in ('queued', 'running');
create unique index audit_requests_one_live_verify_per_action on audit_requests (action_id)
  where kind = 'verify' and status in ('queued', 'running');
