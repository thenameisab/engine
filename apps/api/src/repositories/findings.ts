import type { ActionTemplate, Finding, FindingSource } from '@engine/core';
import { toJsonb } from '../db.js';
import type { Db } from '../db.js';

interface FindingRow {
  id: string;
  entity_id: string;
  source: FindingSource;
  issue_type: string;
  // `numeric` columns arrive as strings from postgres.js — the driver refuses to
  // silently narrow arbitrary-precision numerics into a lossy JS float. Both are
  // small bounded scores, so converting is safe here; doing it in one place
  // keeps a string from leaking out into the scoring math as `"7" > 10 === false`.
  severity: string;
  predicted_impact: string;
  evidence: object;
  action_templates: ActionTemplate[];
  created_at: Date;
}

function toFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    entityId: row.entity_id,
    source: row.source,
    issueType: row.issue_type,
    severity: Number(row.severity),
    predictedImpact: Number(row.predicted_impact),
    evidence: row.evidence,
    actionTemplates: row.action_templates,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Persist the findings from one audit run, keyed on the deterministic id that
 * diagnosis minted (stored as `fingerprint` — see migration 0003).
 *
 * The returned Findings carry their **database** id, not the `fnd_…` fingerprint
 * they arrived with. That swap is the point: `actions.finding_id` is a uuid FK,
 * so an Action can only be generated against a finding that has been persisted
 * first. The fingerprint stays behind as the dedupe key.
 *
 * Re-auditing an unchanged site is a no-op beyond refreshing scores: `created_at`
 * is deliberately not touched on conflict, so it keeps meaning "first seen".
 *
 * Upserts are issued per finding rather than as one bulk statement — an audit
 * yields tens of rows, not thousands, and each upsert is individually idempotent,
 * so a partial failure is fixed by re-running rather than by cleanup.
 */
/**
 * Whether a finding exists *and* belongs to this project — the same
 * findings -> entities -> project_id hop `listActionsByProject` reads through,
 * since `findings` has no project_id either.
 *
 * `id` is caller-supplied, so it is compared as text rather than interpolated as
 * a uuid: Postgres rejects a malformed uuid *literal* with `invalid input syntax
 * for type uuid` (a 500) before it ever gets as far as not matching a row. Under
 * the cast we want the ordinary "no such finding" answer for both a well-formed
 * uuid that doesn't exist and a string that was never a uuid.
 */
export async function findingBelongsToProject(db: Db, findingId: string, projectId: string): Promise<boolean> {
  const rows = await db<{ ok: number }[]>`
    select 1 as ok
    from findings f
    join entities e on e.id = f.entity_id
    where f.id::text = ${findingId} and e.project_id::text = ${projectId}
    limit 1
  `;
  return rows.length > 0;
}

/**
 * One finding by id, tenancy-checked against its project through the same
 * findings -> entities -> project_id hop the list query uses. Returns the full
 * Finding (with its persisted uuid and action templates) the propose route
 * needs to dispatch a generator, or null when it isn't this project's — so the
 * caller gets a 404, never another project's finding. `id::text` for the same
 * malformed-uuid reason as `findingBelongsToProject`.
 */
export async function getFindingInProject(db: Db, findingId: string, projectId: string): Promise<Finding | null> {
  const rows = await db<FindingRow[]>`
    select f.id, f.entity_id, f.source, f.issue_type, f.severity,
           f.predicted_impact, f.evidence, f.action_templates, f.created_at
    from findings f
    join entities e on e.id = f.entity_id
    where f.id::text = ${findingId} and e.project_id::text = ${projectId}
    limit 1
  `;
  return rows.length > 0 ? toFinding(rows[0]) : null;
}

export async function upsertFindings(db: Db, findings: readonly Finding[]): Promise<Finding[]> {
  const persisted: Finding[] = [];
  for (const finding of findings) {
    const [row] = await db<FindingRow[]>`
      insert into findings (entity_id, fingerprint, source, issue_type, severity, predicted_impact, evidence, action_templates)
      values (
        ${finding.entityId}, ${finding.id}, ${finding.source}, ${finding.issueType}, ${finding.severity},
        ${finding.predictedImpact}, ${toJsonb(db, finding.evidence)}, ${toJsonb(db, finding.actionTemplates)}
      )
      on conflict (entity_id, fingerprint) do update set
        issue_type = excluded.issue_type,
        severity = excluded.severity,
        predicted_impact = excluded.predicted_impact,
        evidence = excluded.evidence,
        action_templates = excluded.action_templates
      returning id, entity_id, source, issue_type, severity, predicted_impact, evidence, action_templates, created_at
    `;
    persisted.push(toFinding(row));
  }
  return persisted;
}

/**
 * The project's finding inventory — the read side of /audit. Until now findings
 * were write-only: `upsertFindings` persisted them and nothing could read them
 * back, so the dashboard's Audit view had no choice but to render mocks.
 *
 * Reaches the project through `findings -> entities` for the same reason
 * `listActionsByProject` does: findings carry no project_id, and adding one
 * would let a finding disagree with its own entity about which project it is
 * in. The entity is the join, exactly as the entity-first model intends.
 *
 * Ordered by predicted impact, matching how runAudit leads its inventory (§8):
 * the worst thing first is the whole point of the view.
 */
export async function listFindingsByProject(db: Db, projectId: string): Promise<Finding[]> {
  const rows = await db<FindingRow[]>`
    select f.id, f.entity_id, f.source, f.issue_type, f.severity,
           f.predicted_impact, f.evidence, f.action_templates, f.created_at
    from findings f
    join entities e on e.id = f.entity_id
    where e.project_id::text = ${projectId}
    order by f.predicted_impact desc, f.created_at desc
  `;
  return rows.map(toFinding);
}

/**
 * One entity's own findings, worst-impact first. The direct `entity_id`
 * lookup this Copilot query needs (M2.2) — no project hop required, since
 * the caller already resolved and tenancy-checked the entity.
 */
export async function listFindingsByEntity(db: Db, entityId: string, limit = 5): Promise<Finding[]> {
  const rows = await db<FindingRow[]>`
    select id, entity_id, source, issue_type, severity, predicted_impact, evidence, action_templates, created_at
    from findings
    where entity_id = ${entityId}
    order by predicted_impact desc, created_at desc
    limit ${limit}
  `;
  return rows.map(toFinding);
}
