/**
 * The Finding -> Action contract (Architecture §3.1, "the moat contract").
 * Every Pillar B diagnosis module emits a Finding. Zero or more Action
 * templates attach to it; the Fix Queue (Pillar C) executes Actions.
 * Frozen here in Phase 1 so C-layer work is integration, not redesign.
 */
export type FindingSource = 'technical' | 'content' | 'entity' | 'local';

export interface ActionTemplate {
  type: ActionType;
  label: string;
  description: string;
}

export interface Finding {
  id: string;
  entityId: string;
  source: FindingSource;
  /**
   * What is actually wrong, e.g. `ai-crawler-blocked`. The identity of the
   * problem: it selects the severity weight and the action templates, and it is
   * part of the finding's fingerprint.
   *
   * Deliberately a `string`, not a union. Each Pillar B source owns its own
   * vocabulary (B1 technical issues are `IssueType` in @engine/diagnosis; B2
   * content findings will differ), and core cannot import from the packages
   * that depend on it. `source` says which vocabulary applies.
   *
   * Required, not optional: without it a persisted finding cannot say what it
   * is. It cannot be recovered afterwards — the fingerprint hashes it one-way,
   * and inferring it from `actionTemplates` collapses distinct problems
   * (`schema-missing` and `schema-invalid` share one template). An optional
   * field would let that gap return silently.
   */
  issueType: string;
  severity: number;
  predictedImpact: number;
  evidence: object;
  actionTemplates: ActionTemplate[];
  createdAt: string;
}

export type ActionType = 'schema' | 'meta' | 'redirect' | 'robots' | 'content' | 'gbp';

export type DeployTarget =
  | { kind: 'cms-plugin'; plugin: 'wordpress' | 'shopify'; siteId: string }
  | { kind: 'edge-worker'; workerName: string }
  | { kind: 'github-pr'; repo: string; branch: string }
  | { kind: 'gbp-api'; locationId: string };

export type ActionStatus = 'proposed' | 'approved' | 'deployed' | 'verified' | 'rolled_back';

export interface Diff {
  before: string;
  after: string;
  format: 'json-ld' | 'html' | 'text' | 'file';
  /** Which element a 'meta' Diff targets — required for a deploy target to know where to write it. */
  field?: 'title' | 'description';
}

export interface AuditEntry {
  timestamp: string;
  actor: string;
  event: string;
  detail?: object;
}

export interface Action {
  id: string;
  findingId: string;
  type: ActionType;
  target: DeployTarget;
  diff: Diff;
  status: ActionStatus;
  auditLog: AuditEntry[];
}
