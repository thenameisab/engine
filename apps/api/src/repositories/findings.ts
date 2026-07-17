import type { ActionTemplate, Finding, FindingSource } from '@engine/core';
import { toJsonb } from '../db.js';
import type { Db } from '../db.js';

interface FindingRow {
  id: string;
  entity_id: string;
  source: FindingSource;
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

export async function upsertFindings(db: Db, findings: readonly Finding[]): Promise<Finding[]> {
  const persisted: Finding[] = [];
  for (const finding of findings) {
    const [row] = await db<FindingRow[]>`
      insert into findings (entity_id, fingerprint, source, severity, predicted_impact, evidence, action_templates)
      values (
        ${finding.entityId}, ${finding.id}, ${finding.source}, ${finding.severity},
        ${finding.predictedImpact}, ${toJsonb(db, finding.evidence)}, ${toJsonb(db, finding.actionTemplates)}
      )
      on conflict (entity_id, fingerprint) do update set
        severity = excluded.severity,
        predicted_impact = excluded.predicted_impact,
        evidence = excluded.evidence,
        action_templates = excluded.action_templates
      returning id, entity_id, source, severity, predicted_impact, evidence, action_templates, created_at
    `;
    persisted.push(toFinding(row));
  }
  return persisted;
}
