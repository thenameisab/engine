
## 2026-09-10 (the page budget matches the site)
- User's decisions: the sending domain is `adityagaur.xyz`, their own site's domain on the same Cloudflare account; **no Workers Paid upgrade**, the account stays on Free; **`maxPages` default is 250**.
- Branch `feat/max-pages-250` off the #105 merge (`d6bd383`; #105 `feat/shell-and-craft` landed while the crawl work was in flight — its main CI run had `build`, `migrate`, `deploy-api`, `deploy` all green, checked). The uncommitted log entries from the crawl work ride here; the stash pop conflicted with #105's log entry and was resolved by keeping both.
- `AUDIT_REQUEST_MAX_PAGES_DEFAULT` 50 → **250** in `apps/api/src/validate.ts`, with the measurement and the cost model written above the constant. The comment that bounded `maxPages` because "a runner spends real minutes per page" now says time, since the minutes are free. The 500 hard limit is unchanged. No dashboard copy names the default — the audit screen reads `coverage.maxPages` off the run, so "stopped at its 250-page limit" will say 250 without a change.
- Test fixtures that say `maxPages: 50` are literal request values, not the default, and stay.
