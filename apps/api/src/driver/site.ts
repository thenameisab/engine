/**
 * The five tools about the site itself: what is wrong with it, what the crawl
 * saw, and what is being done about it.
 *
 * `findings` and `actions` are entity-keyed and action-keyed respectively, so
 * both join through `entities` to reach `project_id`. `audit_runs` and
 * `audit_requests` are project-keyed directly.
 *
 * Two distinctions in here are load bearing and easy to lose:
 *
 *  - A crawl that stopped at its page limit has not seen the whole site, so
 *    every count derived from it is a floor. `crawl_coverage` reports
 *    `stoppedAtLimit` and `site_health` repeats it, because a health score over
 *    a partial crawl is a different claim from one over a complete crawl.
 *  - A fix that has not been checked is not a fix that failed. `fix_verification`
 *    keeps "verified false" and "never checked" apart; the audit_requests schema
 *    already models it as three states and migration 0029's own comment says
 *    why.
 */
import {
  intArg,
  noDataYet,
  ok,
  strArg,
  zero,
  type ToolHandler,
} from './context.js';

/* ── findings ─────────────────────────────────────────────────────────────── */

export const findings: ToolHandler = async (ctx, args) => {
  const max = intArg(args, 'limit', 25);
  const source = strArg(args, 'source');
  const issueType = strArg(args, 'issueType');
  const minSeverity = typeof args.minSeverity === 'number' ? args.minSeverity : null;
  const includeResolved = args.includeResolved === true;
  const tables = ['findings', 'entities'];

  const rows = await ctx.db<
    {
      id: string;
      entity: string;
      source: string;
      issue_type: string;
      severity: string;
      predicted_impact: string;
      evidence: unknown;
      created_at: string;
      resolved_at: string | null;
    }[]
  >`
    select f.id, e.canonical_name as entity, f.source, f.issue_type, f.severity,
           f.predicted_impact, f.evidence, f.created_at::text as created_at,
           f.resolved_at::text as resolved_at
    from findings f
    join entities e on e.id = f.entity_id
    where e.project_id::text = ${ctx.projectId}
      and (${includeResolved} or f.resolved_at is null)
      and (${source ?? null}::text is null or f.source = ${source ?? null})
      and (${issueType ?? null}::text is null or f.issue_type = ${issueType ?? null})
      and (${minSeverity}::numeric is null or f.severity >= ${minSeverity})
    order by f.severity desc, f.predicted_impact desc, f.created_at desc
    limit ${max}
  `;

  const list = rows.map((r) => ({
    id: r.id,
    entity: r.entity,
    source: r.source,
    issueType: r.issue_type,
    severity: Number(r.severity),
    predictedImpact: Number(r.predicted_impact),
    evidence: r.evidence,
    foundAt: r.created_at,
    resolvedAt: r.resolved_at,
  }));

  const data = {
    findings: list,
    filters: {
      source: source ?? null,
      issueType: issueType ?? null,
      minSeverity,
      includeResolved,
    },
  };
  const provenance = { tables, rowIds: list.map((f) => f.id) };

  if (list.length > 0) return ok(data, provenance);

  // An empty findings list has two very different causes, and telling a
  // customer their site is clean when nothing has ever been audited is the
  // worst answer this tool can give.
  const [{ n }] = await ctx.db<{ n: string }[]>`
    select count(*)::text as n from findings f
    join entities e on e.id = f.entity_id where e.project_id::text = ${ctx.projectId}
  `;
  const everFound = Number(n);
  if (everFound === 0) {
    const [{ runs }] = await ctx.db<{ runs: string }[]>`
      select count(*)::text as runs from audit_runs where project_id::text = ${ctx.projectId}
    `;
    return Number(runs) === 0
      ? noDataYet(data, provenance, {
          reason: 'This site has never been audited, so no findings exist yet.',
          action: 'Queue a crawl to audit the site.',
        })
      : zero(data, provenance, {
          reason: `The site has been audited ${runs} time(s) and produced no findings at all.`,
          action: 'Call site_health and crawl_coverage to confirm the crawl actually reached the site.',
        });
  }

  return zero(data, provenance, {
    reason: `This project has ${everFound} findings, but none matched the filters used.`,
    action: 'Call findings again with no filters to see which sources and issue types exist.',
  });
};

/* ── crawl_coverage ───────────────────────────────────────────────────────── */

export const crawlCoverage: ToolHandler = async (ctx) => {
  const tables = ['audit_runs', 'crawled_pages'];

  const [[run], [{ stored }]] = await Promise.all([
    ctx.db<
      {
        id: string;
        pages_audited: number;
        findings_count: number;
        health_score: number;
        created_at: string;
        robots_found: boolean | null;
        sitemap_urls: number | null;
        links_discovered: number | null;
        blocked_by_robots: number | null;
        stopped_at_limit: boolean | null;
        max_pages: number | null;
      }[]
    >`
      select id, pages_audited, findings_count, health_score, created_at::text as created_at,
             robots_found, sitemap_urls, links_discovered, blocked_by_robots,
             stopped_at_limit, max_pages
      from audit_runs where project_id::text = ${ctx.projectId}
      order by created_at desc limit 1
    `,
    ctx.db<{ stored: string }[]>`
      select count(*)::text as stored from crawled_pages where project_id::text = ${ctx.projectId}
    `,
  ]);

  if (!run) {
    return noDataYet({ lastCrawl: null, pagesStored: Number(stored) }, { tables }, {
      reason: 'This site has never been crawled, so nothing is known about what it contains.',
      action: 'Queue a crawl. Until then findings, site_health and page-level answers stay empty.',
    });
  }

  const data = {
    lastCrawl: {
      auditRunId: run.id,
      ranAt: run.created_at,
      pagesAudited: run.pages_audited,
      findingsFound: run.findings_count,
      healthScore: run.health_score,
      robotsFound: run.robots_found,
      sitemapUrls: run.sitemap_urls,
      linksDiscovered: run.links_discovered,
      blockedByRobots: run.blocked_by_robots,
      stoppedAtLimit: run.stopped_at_limit,
      maxPages: run.max_pages,
    },
    pagesStored: Number(stored),
    // Stated in the result rather than left for the model to work out, because
    // it changes how every count from this crawl should be described.
    countsAreComplete: run.stopped_at_limit !== true,
    note:
      run.stopped_at_limit === true
        ? `The crawl stopped at its limit of ${run.max_pages ?? 'the configured maximum'} pages, so it did not see the whole site. Every count from it is a floor, not a total.`
        : 'The crawl finished without hitting its page limit, so its counts cover everything it could reach.',
  };

  return ok(data, { tables, rowIds: [run.id] });
};

/* ── fix_queue ────────────────────────────────────────────────────────────── */

export const fixQueue: ToolHandler = async (ctx, args) => {
  const max = intArg(args, 'limit', 25);
  const status = strArg(args, 'status');
  const tables = ['actions', 'findings', 'entities'];

  const rows = await ctx.db<
    {
      id: string;
      type: string;
      status: string;
      target: unknown;
      created_at: string;
      updated_at: string;
      issue_type: string;
      severity: string;
      entity: string;
    }[]
  >`
    select a.id, a.type, a.status, a.target, a.created_at::text as created_at,
           a.updated_at::text as updated_at, f.issue_type, f.severity, e.canonical_name as entity
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id::text = ${ctx.projectId}
      and (${status ?? null}::text is null or a.status = ${status ?? null})
    order by a.updated_at desc
    limit ${max}
  `;

  const fixes = rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    target: r.target,
    answersIssue: r.issue_type,
    severity: Number(r.severity),
    entity: r.entity,
    proposedAt: r.created_at,
    lastChangedAt: r.updated_at,
  }));

  const data = {
    fixes,
    statusFilter: status ?? null,
    note: 'proposed is a draft that changes nothing; deployed means written to the live site; verified means the deployed page was fetched again and carried the change.',
  };
  const provenance = { tables, rowIds: fixes.map((f) => f.id) };

  if (fixes.length > 0) return ok(data, provenance);

  const [{ n }] = await ctx.db<{ n: string }[]>`
    select count(*)::text as n from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where e.project_id::text = ${ctx.projectId}
  `;
  const total = Number(n);

  return total === 0
    ? zero(data, provenance, {
        reason: 'Nothing has been proposed for this project yet, so the fix queue is empty.',
        action: 'Call findings to see what could be fixed, then propose a fix for one of them.',
      })
    : zero(data, provenance, {
        reason: `The queue holds ${total} fixes, none of them in the "${status}" state.`,
        action: 'Call fix_queue with no status filter to see every fix and its current state.',
      });
};

/* ── fix_verification ─────────────────────────────────────────────────────── */

export const fixVerification: ToolHandler = async (ctx, args) => {
  const actionId = strArg(args, 'actionId');
  const tables = ['actions', 'audit_requests', 'findings', 'entities'];

  if (!actionId || !/^[0-9a-f-]{36}$/i.test(actionId)) {
    return zero({ fix: null, checks: [] }, { tables }, {
      reason: `"${actionId ?? ''}" is not a valid fix id.`,
      action: 'Call fix_queue to get the ids of fixes in this project.',
    });
  }

  // Scoped through the same join as fix_queue: an id from another project must
  // read as "not in this project", never as that project's row.
  const [action] = await ctx.db<
    { id: string; status: string; type: string; updated_at: string; entity: string }[]
  >`
    select a.id, a.status, a.type, a.updated_at::text as updated_at, e.canonical_name as entity
    from actions a
    join findings f on f.id = a.finding_id
    join entities e on e.id = f.entity_id
    where a.id::text = ${actionId} and e.project_id::text = ${ctx.projectId}
  `;

  if (!action) {
    return zero({ fix: null, checks: [] }, { tables }, {
      reason: `No fix with id ${actionId} exists in this project.`,
      action: 'Call fix_queue to list the fixes that do.',
    });
  }

  const checks = await ctx.db<
    { id: string; status: string; verified: boolean | null; created_at: string; finished_at: string | null; error: string | null }[]
  >`
    select id, status, verified, created_at::text as created_at,
           finished_at::text as finished_at, error
    from audit_requests
    where kind = 'verify' and action_id::text = ${actionId} and project_id::text = ${ctx.projectId}
    order by created_at desc
  `;

  const completed = checks.find((c) => c.status === 'done' && c.verified !== null);
  const outcome = completed
    ? completed.verified === true
      ? 'verified'
      : 'not-found-on-page'
    : checks.some((c) => c.status === 'queued' || c.status === 'running')
      ? 'check-in-progress'
      : 'never-checked';

  const data = {
    fix: { id: action.id, type: action.type, status: action.status, entity: action.entity, lastChangedAt: action.updated_at },
    outcome,
    checks: checks.map((c) => ({
      id: c.id,
      status: c.status,
      verified: c.verified,
      requestedAt: c.created_at,
      finishedAt: c.finished_at,
      error: c.error,
    })),
    note: 'outcome "never-checked" means nobody has looked yet. It is not the same as "not-found-on-page", which means the live page was fetched and did not carry the change.',
  };
  const provenance = { tables, rowIds: [action.id, ...checks.map((c) => c.id)] };

  return outcome === 'never-checked'
    ? noDataYet(data, provenance, {
        reason:
          action.status === 'deployed'
            ? 'This fix has been deployed but its live page has not been checked yet.'
            : `This fix is "${action.status}", so there is nothing deployed to verify.`,
        action:
          action.status === 'deployed'
            ? 'Run a verification check on the Fix Queue.'
            : 'A fix is verified after it is deployed. Deploy it first, from the Fix Queue.',
      })
    : ok(data, provenance);
};

/* ── site_health ──────────────────────────────────────────────────────────── */

export const siteHealth: ToolHandler = async (ctx) => {
  const tables = ['audit_runs', 'findings', 'entities'];

  const [[run], bySource, bySeverity] = await Promise.all([
    ctx.db<
      { id: string; pages_audited: number; findings_count: number; health_score: number; created_at: string; stopped_at_limit: boolean | null }[]
    >`
      select id, pages_audited, findings_count, health_score, created_at::text as created_at, stopped_at_limit
      from audit_runs where project_id::text = ${ctx.projectId}
      order by created_at desc limit 1
    `,
    ctx.db<{ source: string; n: string }[]>`
      select f.source, count(*)::text as n from findings f
      join entities e on e.id = f.entity_id
      where e.project_id::text = ${ctx.projectId} and f.resolved_at is null
      group by f.source order by count(*) desc
    `,
    ctx.db<{ band: string; n: string }[]>`
      select case when f.severity >= 70 then 'high' when f.severity >= 40 then 'medium' else 'low' end as band,
             count(*)::text as n
      from findings f
      join entities e on e.id = f.entity_id
      where e.project_id::text = ${ctx.projectId} and f.resolved_at is null
      group by 1
    `,
  ]);

  const open = bySource.reduce((sum, r) => sum + Number(r.n), 0);
  const data = {
    healthScore: run?.health_score ?? null,
    lastAuditedAt: run?.created_at ?? null,
    pagesAudited: run?.pages_audited ?? null,
    crawlWasComplete: run ? run.stopped_at_limit !== true : null,
    openFindings: open,
    bySource: Object.fromEntries(bySource.map((r) => [r.source, Number(r.n)])),
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r.band, Number(r.n)])),
    note: 'Severity bands: high is 70 and above, medium 40 to 69, low below 40.',
  };
  const provenance = { tables, ...(run ? { rowIds: [run.id] } : {}) };

  if (!run) {
    return noDataYet(data, provenance, {
      reason: 'This site has never been audited, so it has no health score.',
      action: 'Queue a crawl to produce one.',
    });
  }

  return open === 0
    ? zero(data, provenance, {
        reason: `The last audit on ${run.created_at.slice(0, 10)} covered ${run.pages_audited} pages and left no open findings.`,
        action: 'Nothing needs fixing from the technical audit. Call crawl_coverage to confirm the crawl reached the whole site.',
      })
    : ok(data, provenance);
};

export const SITE_HANDLERS = {
  findings,
  crawl_coverage: crawlCoverage,
  fix_queue: fixQueue,
  fix_verification: fixVerification,
  site_health: siteHealth,
} satisfies Record<string, ToolHandler>;
