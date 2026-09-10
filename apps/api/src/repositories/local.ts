import { runLocalAudit, type LocalAuditResult, type LocalProfileFacts, type LocalVisibility } from '@engine/local';
import { getEntityInProject } from './entities.js';
import { upsertFindings } from './findings.js';
import { toJsonb, type Db } from '../db.js';

/**
 * B5 orchestration: store a location's profile facts, run the deterministic
 * local audit over them, persist the source:'local' findings (into the shared
 * inventory B1/B2/B3 write) and the local visibility breakdown (migration
 * 0013), and read both back. Thin by design — every check lives in
 * `@engine/local`, unit-tested without a database. A location is an entity, so
 * everything keys on entity_id.
 */

/** The settable profile document (LocalProfileFacts minus the entity identity). */
export type ProfileInput = Omit<LocalProfileFacts, 'entityId' | 'canonicalName'>;

/** Store/replace a location's profile facts. Returns false if the entity isn't in the project. */
export async function setLocalProfile(db: Db, projectId: string, entityId: string, profile: ProfileInput): Promise<boolean> {
  const entity = await getEntityInProject(db, projectId, entityId);
  if (!entity) return false;
  await db`
    insert into local_profiles (entity_id, project_id, profile, updated_at)
    values (${entityId}, ${projectId}, ${toJsonb(db, profile)}, now())
    on conflict (entity_id) do update set profile = excluded.profile, updated_at = now()
  `;
  return true;
}

/** Read a location's stored profile facts, or null if none set. */
export async function getLocalProfile(db: Db, projectId: string, entityId: string): Promise<ProfileInput | null> {
  const rows = await db<{ profile: ProfileInput }[]>`
    select profile from local_profiles where entity_id = ${entityId} and project_id = ${projectId}
  `;
  return rows.length > 0 ? rows[0].profile : null;
}

export interface LocalAuditRunResult extends LocalAuditResult {
  entityId: string;
}

/**
 * Run + persist a location's local audit. Returns null if the entity isn't in
 * the project, or 'no-profile' if no profile facts have been set yet (an empty
 * audit would be a lie, not a result).
 */
export async function runProjectLocalAudit(
  db: Db,
  projectId: string,
  entityId: string,
): Promise<LocalAuditRunResult | null | 'no-profile'> {
  const entity = await getEntityInProject(db, projectId, entityId);
  if (!entity) return null;
  const profile = await getLocalProfile(db, projectId, entityId);
  if (!profile) return 'no-profile';

  const facts: LocalProfileFacts = { entityId: entity.id, canonicalName: entity.canonicalName, ...profile };
  const result = runLocalAudit(facts);

  if (result.findings.length > 0) await upsertFindings(db, result.findings);
  await upsertVisibility(db, projectId, result.visibility);

  return { ...result, entityId: entity.id };
}

async function upsertVisibility(db: Db, projectId: string, v: LocalVisibility): Promise<void> {
  await db`
    insert into local_audits
      (entity_id, project_id, score, gbp_score, nap_score, review_score, reviews_considered, updated_at)
    values (
      ${v.entityId}, ${projectId}, ${v.score}, ${v.components.gbpCompleteness}, ${v.components.napConsistency},
      ${v.components.reviewHealth}, ${v.reviewsConsidered}, now()
    )
    on conflict (entity_id) do update set
      score = excluded.score,
      gbp_score = excluded.gbp_score,
      nap_score = excluded.nap_score,
      review_score = excluded.review_score,
      reviews_considered = excluded.reviews_considered,
      updated_at = now()
  `;
}

export interface LocalVisibilityRecord extends LocalVisibility {
  updatedAt: string;
}

/** The project's persisted local visibility scores, weakest first (join to the entity name). */
export async function listLocalVisibility(db: Db, projectId: string): Promise<LocalVisibilityRecord[]> {
  const rows = await db<
    {
      entity_id: string;
      canonical_name: string;
      score: string;
      gbp_score: string;
      nap_score: string;
      review_score: string | null;
      reviews_considered: number;
      updated_at: Date;
    }[]
  >`
    select a.entity_id, e.canonical_name, a.score, a.gbp_score, a.nap_score, a.review_score,
           a.reviews_considered, a.updated_at
    from local_audits a
    join entities e on e.id = a.entity_id
    where a.project_id = ${projectId}
    order by a.score asc
  `;
  return rows.map((r) => ({
    entityId: r.entity_id,
    canonicalName: r.canonical_name,
    score: Number(r.score),
    components: {
      gbpCompleteness: Number(r.gbp_score),
      napConsistency: Number(r.nap_score),
      reviewHealth: r.review_score === null ? null : Number(r.review_score),
    },
    reviewsConsidered: r.reviews_considered,
    updatedAt: r.updated_at.toISOString(),
  }));
}
