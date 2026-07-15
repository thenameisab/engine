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
