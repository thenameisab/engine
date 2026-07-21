import type { CrawledPage } from '@engine/diagnosis';
import type { Db } from '../db.js';

/**
 * The page context a fix generator needs, rebuilt from storage. `/audit` used
 * to take `CrawledPage`s in the request, score them, and discard them — so the
 * "generate a fix later" step had no title/body/link-count to build a diff
 * from. We persist just the fields a generator reads (not the full crawl
 * record: vitals, robots verdicts, etc. belong to the audit, not the fix), so
 * the dashboard can propose a fix without re-crawling.
 */
export interface StoredPage {
  url: string;
  entityId: string | null;
  title: string | null;
  metaDescription: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  internalLinkCount: number | null;
}

interface PageRow {
  url: string;
  entity_id: string | null;
  title: string | null;
  meta_description: string | null;
  body_text: string | null;
  body_html: string | null;
  internal_link_count: number | null;
}

function toStoredPage(row: PageRow): StoredPage {
  return {
    url: row.url,
    entityId: row.entity_id,
    title: row.title,
    metaDescription: row.meta_description,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    internalLinkCount: row.internal_link_count,
  };
}

/**
 * Persist the fix-relevant slice of each crawled page for one project. Upserted
 * on (project_id, url): a re-crawl refreshes the context in place, so a fix
 * generated afterwards reflects the newest crawl, not a stale one. `entity_id`
 * is passed through as-is — the audit route has already checked every cited
 * entity belongs to this project, so no row can point outside it.
 *
 * Per-row upserts, matching `upsertFindings`: an audit yields tens of pages,
 * each write is idempotent, and a partial failure heals on re-run.
 */
export async function upsertCrawledPages(db: Db, projectId: string, pages: readonly CrawledPage[]): Promise<number> {
  let written = 0;
  for (const page of pages) {
    await db`
      insert into crawled_pages (
        project_id, entity_id, url, title, meta_description, body_text, body_html, internal_link_count, updated_at
      )
      values (
        ${projectId}, ${page.entityId ?? null}, ${page.url}, ${page.title ?? null}, ${page.metaDescription ?? null},
        ${page.bodyText ?? null}, ${page.bodyHtml ?? null}, ${page.internalLinkCount ?? null}, now()
      )
      on conflict (project_id, url) do update set
        entity_id = excluded.entity_id,
        title = excluded.title,
        meta_description = excluded.meta_description,
        body_text = excluded.body_text,
        body_html = excluded.body_html,
        internal_link_count = excluded.internal_link_count,
        updated_at = now()
    `;
    written++;
  }
  return written;
}

/**
 * Sibling pages in the same project as internal-link targets (C3): each other
 * crawled URL that resolves to an entity, offered with that entity's canonical
 * name as the anchor to weave in. This is the "entity-graph decides what to
 * link" input the internal-link generator expects — kept server-side because
 * only the DB knows the project's other pages. The generator itself only links
 * anchors it actually finds in the body, so an irrelevant suggestion is a
 * harmless no-op, not a spurious link.
 */
export async function listInternalLinkTargets(
  db: Db,
  projectId: string,
  excludeUrl: string,
  limit = 25,
): Promise<{ anchor: string; href: string }[]> {
  const rows = await db<{ anchor: string; href: string }[]>`
    select e.canonical_name as anchor, p.url as href
    from crawled_pages p
    join entities e on e.id = p.entity_id
    where p.project_id::text = ${projectId} and p.url <> ${excludeUrl}
    order by p.updated_at desc
    limit ${limit}
  `;
  return rows;
}

/** The stored page for one URL in a project, or null if this project never crawled it. */
export async function getCrawledPage(db: Db, projectId: string, url: string): Promise<StoredPage | null> {
  const rows = await db<PageRow[]>`
    select url, entity_id, title, meta_description, body_text, body_html, internal_link_count
    from crawled_pages
    where project_id::text = ${projectId} and url = ${url}
    limit 1
  `;
  return rows.length > 0 ? toStoredPage(rows[0]) : null;
}
