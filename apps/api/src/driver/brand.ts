/**
 * The four tools about the brand's standing: how recognisable it is to machines,
 * where competitors are ahead, how the local listing looks, and what is
 * connected.
 *
 * `integration_status` is the odd one out and the most important of the four.
 * It is the tool the model should reach for before telling a customer they have
 * no search traffic, because on a new account the honest answer is almost always
 * "nothing is connected" rather than "nothing is happening". §9a decision 6 ships
 * Driver with no gate on Google data, which makes that the first impression for
 * most accounts, so the tool's description tells the model to call it and the
 * Google tools' own `not-connected` results point at the same fact.
 */
import {
  intArg,
  noDataYet,
  ok,
  strArg,
  zero,
  type ToolHandler,
} from './context.js';

/* ── entity_strength ──────────────────────────────────────────────────────── */

export const entityStrength: ToolHandler = async (ctx, args) => {
  const entity = strArg(args, 'entity');
  const tables = ['entity_graph_audits', 'entities'];

  const rows = await ctx.db<
    {
      entity: string;
      score: string;
      wikidata_score: string;
      schema_score: string;
      sameas_score: string;
      corroboration_score: string;
      corroborating_domains: number;
      updated_at: string;
    }[]
  >`
    select e.canonical_name as entity, a.score, a.wikidata_score, a.schema_score,
           a.sameas_score, a.corroboration_score, a.corroborating_domains,
           a.updated_at::text as updated_at
    from entity_graph_audits a
    join entities e on e.id = a.entity_id
    where a.project_id::text = ${ctx.projectId}
      and (${entity ?? null}::text is null or lower(e.canonical_name) = lower(${entity ?? null}))
    order by a.score desc
  `;

  const entities = rows.map((r) => ({
    entity: r.entity,
    score: Number(r.score),
    components: {
      wikidata: Number(r.wikidata_score),
      schema: Number(r.schema_score),
      sameAs: Number(r.sameas_score),
      corroboration: Number(r.corroboration_score),
    },
    corroboratingDomains: r.corroborating_domains,
    measuredAt: r.updated_at,
  }));

  const data = { entities, entityFilter: entity ?? null, note: 'Scores are out of 100. The four components are what the overall score is built from.' };
  const provenance = { tables };

  if (entities.length > 0) return ok(data, provenance);

  const [{ n }] = await ctx.db<{ n: string }[]>`
    select count(*)::text as n from entities where project_id::text = ${ctx.projectId}
  `;
  return Number(n) === 0
    ? noDataYet(data, provenance, {
        reason: 'This project has no tracked entities, so there is nothing to score.',
        action: 'Add the brand as an entity.',
      })
    : noDataYet(data, provenance, {
        reason: entity
          ? `No entity audit has been run for "${entity}".`
          : `This project has ${n} entities and none of them has been audited yet.`,
        action: 'Run the entity audit to produce a score.',
      });
};

/* ── competitor_gaps ──────────────────────────────────────────────────────── */

export const competitorGaps: ToolHandler = async (ctx, args) => {
  const max = intArg(args, 'limit', 25);
  const competitor = strArg(args, 'competitor');
  const gapType = strArg(args, 'gapType');
  const tables = ['competitor_gaps', 'competitor_sets', 'entities'];

  const rows = await ctx.db<
    { id: string; gap_type: string; item: string; held_by_count: number; held_by: unknown; impact: string; updated_at: string }[]
  >`
    select id, gap_type, item, held_by_count, held_by, impact, updated_at::text as updated_at
    from competitor_gaps
    where project_id::text = ${ctx.projectId}
      and (${gapType ?? null}::text is null or gap_type = ${gapType ?? null})
      and (${competitor ?? null}::text is null
           or held_by::text ilike ${'%' + (competitor ?? '') + '%'})
    order by impact desc, held_by_count desc
    limit ${max}
  `;

  const gaps = rows.map((r) => ({
    id: r.id,
    gapType: r.gap_type,
    item: r.item,
    heldByCount: r.held_by_count,
    heldBy: r.held_by,
    impact: Number(r.impact),
    measuredAt: r.updated_at,
  }));

  const data = { gaps, filters: { competitor: competitor ?? null, gapType: gapType ?? null } };
  const provenance = { tables, rowIds: gaps.map((g) => g.id) };

  if (gaps.length > 0) return ok(data, provenance);

  // An empty gap list means "we are not behind" only if competitors are
  // actually configured. With none configured it means nothing was compared.
  const [{ n }] = await ctx.db<{ n: string }[]>`
    select count(*)::text as n from competitor_sets where project_id::text = ${ctx.projectId}
  `;
  const configured = Number(n);

  if (configured === 0) {
    return noDataYet(data, provenance, {
      reason: 'No competitors are configured for this project, so nothing has been compared.',
      action: 'Add competitors on the Competitors screen, then run the competitor audit.',
    });
  }

  const [{ any }] = await ctx.db<{ any: string }[]>`
    select count(*)::text as any from competitor_gaps where project_id::text = ${ctx.projectId}
  `;
  return Number(any) === 0
    ? zero(data, provenance, {
        reason: `${configured} competitors are configured and the audit found no gaps against them.`,
        action: 'This is a real result. Re-run the competitor audit after adding more competitors to test it.',
      })
    : zero(data, provenance, {
        reason: `${any} gaps exist for this project, but none matched the filters used.`,
        action: 'Call competitor_gaps with no filters to see which gap types and competitors exist.',
      });
};

/* ── local_visibility ─────────────────────────────────────────────────────── */

export const localVisibility: ToolHandler = async (ctx, args) => {
  const entity = strArg(args, 'entity');
  const tables = ['local_audits', 'local_profiles', 'entities'];

  const rows = await ctx.db<
    {
      entity: string;
      score: string;
      gbp_score: string;
      nap_score: string;
      review_score: string | null;
      reviews_considered: number;
      updated_at: string;
      profile: unknown;
    }[]
  >`
    select e.canonical_name as entity, a.score, a.gbp_score, a.nap_score, a.review_score,
           a.reviews_considered, a.updated_at::text as updated_at, p.profile
    from local_audits a
    join entities e on e.id = a.entity_id
    left join local_profiles p on p.entity_id = a.entity_id
    where a.project_id::text = ${ctx.projectId}
      and (${entity ?? null}::text is null or lower(e.canonical_name) = lower(${entity ?? null}))
    order by a.score desc
  `;

  const audits = rows.map((r) => ({
    entity: r.entity,
    score: Number(r.score),
    components: {
      googleBusinessProfile: Number(r.gbp_score),
      nameAddressPhone: Number(r.nap_score),
      // Null, not zero. Migration 0028 made this column nullable precisely so
      // "no reviews to score" and "scored zero on reviews" stay apart.
      reviews: r.review_score === null ? null : Number(r.review_score),
    },
    reviewsConsidered: r.reviews_considered,
    profile: r.profile ?? null,
    measuredAt: r.updated_at,
  }));

  const data = {
    audits,
    entityFilter: entity ?? null,
    note: 'A null review component means there were no reviews to score, which is not the same as a review score of zero.',
  };
  const provenance = { tables };

  return audits.length > 0
    ? ok(data, provenance)
    : noDataYet(data, provenance, {
        reason: entity
          ? `No local audit has been run for "${entity}".`
          : 'No local audit has been run for any entity in this project.',
        action:
          'Run the local audit. It needs a Google Business Profile location for the entity, so ' +
          'connect Business Profile on Integrations if it is not already.',
      });
};

/* ── integration_status ───────────────────────────────────────────────────── */

const PROVIDER_LABEL: Record<string, string> = {
  gsc: 'Google Search Console',
  ga4: 'Google Analytics',
  gbp: 'Google Business Profile',
};

export const integrationStatus: ToolHandler = async (ctx) => {
  const tables = ['integration_connections', 'integration_assignments'];

  const [connections, assignments] = await Promise.all([
    ctx.db<{ provider: string; status: string; external_label: string | null; last_error: string | null; connected_at: string }[]>`
      select provider, status, external_label, last_error, connected_at::text as connected_at
      from integration_connections where account_id::text = ${ctx.accountId}
      order by provider
    `,
    ctx.db<{ provider: string; resource_id: string; resource_label: string | null; last_synced_at: string | null; last_sync_error: string | null; last_sync_rows: number | null }[]>`
      select a.provider, a.resource_id, a.resource_label, a.last_synced_at::text as last_synced_at,
             a.last_sync_error, a.last_sync_rows
      from integration_assignments a
      where a.project_id::text = ${ctx.projectId}
      order by a.provider
    `,
  ]);

  const providers = ['gsc', 'ga4', 'gbp'].map((provider) => {
    const connection = connections.find((c) => c.provider === provider);
    const assignment = assignments.find((a) => a.provider === provider);
    const connected = connection?.status === 'connected';
    return {
      provider,
      name: PROVIDER_LABEL[provider] ?? provider,
      connected,
      needsReconnect: connection?.status === 'needs_reauth',
      connectedAccount: connection?.external_label ?? null,
      connectedAt: connection?.connected_at ?? null,
      propertyAssigned: assignment ? (assignment.resource_label ?? assignment.resource_id) : null,
      lastSyncedAt: assignment?.last_synced_at ?? null,
      lastSyncRows: assignment?.last_sync_rows ?? null,
      lastSyncError: assignment?.last_sync_error ?? null,
      // The single field that says what a customer should do next, so the model
      // never has to infer a setup step from four booleans.
      nextStep: !connection
        ? `Connect ${PROVIDER_LABEL[provider]} on the Integrations screen.`
        : connection.status === 'needs_reauth'
          ? `Reconnect ${PROVIDER_LABEL[provider]}; its access has expired.`
          : connection.status === 'revoked'
            ? `${PROVIDER_LABEL[provider]} was disconnected. Connect it again.`
            : !assignment
              ? `Choose which ${PROVIDER_LABEL[provider]} property this project reads from.`
              : assignment.last_sync_error
                ? 'The last sync failed. Run "Sync now" on the Integrations screen.'
                : !assignment.last_synced_at
                  ? 'Connected and assigned. Waiting for the first sync, which runs nightly.'
                  : null,
    };
  });

  const ready = providers.filter((p) => p.connected && p.propertyAssigned && p.lastSyncedAt);
  const data = {
    providers,
    readyCount: ready.length,
    note: 'Search and traffic tools can only return figures for providers that are connected, assigned a property, and synced at least once.',
  };
  const provenance = { tables };

  return ready.length > 0
    ? ok(data, provenance)
    : zero(data, provenance, {
        reason:
          connections.length === 0
            ? 'No data sources are connected to this account.'
            : 'Data sources are connected but none is fully set up and synced for this project yet.',
        action:
          'The per-provider nextStep in this result says exactly what each one needs. ' +
          'Until at least one is ready, the search and traffic tools have nothing to report.',
      });
};

export const BRAND_HANDLERS = {
  entity_strength: entityStrength,
  competitor_gaps: competitorGaps,
  local_visibility: localVisibility,
  integration_status: integrationStatus,
} satisfies Record<string, ToolHandler>;
