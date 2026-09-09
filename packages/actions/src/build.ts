/**
 * Shared assembly + lifecycle helpers for `Action` objects (Fix Queue / C1 core).
 *
 * Generators (./schema.ts etc.) produce the `Diff`; this module wraps it into a
 * complete `Action` in the `proposed` state with an opening audit entry, and
 * provides the deterministic state-machine + audit-append used by the Fix Queue
 * to move an action proposed → approved → deployed → verified → rolled_back.
 */
import type { Action, ActionStatus, ActionType, AuditEntry, Diff, DeployTarget } from '@engine/core';

/**
 * Why a generator produced nothing, in words a customer can act on. A fix that
 * cannot be built is a normal outcome (the page has no heading, the brand has
 * no kind), and saying which is the difference between a product that explains
 * itself and one that reports "no action could be generated".
 */
export interface Skipped {
  reason: string;
}

/** A generator either produces an Action or explains why it could not. */
export type Generated = Action | Skipped;

export function isSkipped(result: Generated): result is Skipped {
  return 'reason' in result;
}

/** Injected id/clock so generated actions are reproducible in tests. */
export interface BuildEnv {
  now: () => string;
  makeId: () => string;
}

export function defaultEnv(): BuildEnv {
  return {
    now: () => new Date().toISOString(),
    makeId: () => `act_${Math.random().toString(16).slice(2, 10)}`,
  };
}

/** Assemble a fresh `proposed` Action with its opening audit entry. */
export function buildAction(params: {
  findingId: string;
  type: ActionType;
  target: DeployTarget;
  diff: Diff;
  env: BuildEnv;
  actor?: string;
}): Action {
  const { findingId, type, target, diff, env, actor = 'system' } = params;
  return {
    id: env.makeId(),
    findingId,
    type,
    target,
    diff,
    status: 'proposed',
    auditLog: [{ timestamp: env.now(), actor, event: 'proposed' }],
  };
}

/**
 * Legal Fix Queue transitions. A proposed fix can be approved or rejected
 * (back to nothing — modelled as staying proposed here); an approved fix
 * deploys; a deployed fix is verified or rolled back; a verified fix can still
 * be rolled back if later monitoring regresses. Terminal: rolled_back.
 */
/**
 * Fix types whose `after` is model-written prose built from the page's own
 * crawled text, and so must be read by a person before anyone approves them
 * (review "Security and platform notes"). Everything else in the queue is a
 * deterministic transform whose output is fully described by the diff on the
 * card; a content rewrite is words that will appear on the customer's site.
 */
const REVIEW_REQUIRED: ReadonlySet<ActionType> = new Set<ActionType>(['content']);

export function requiresHumanReview(type: ActionType): boolean {
  return REVIEW_REQUIRED.has(type);
}

const TRANSITIONS: Record<ActionStatus, ActionStatus[]> = {
  proposed: ['approved'],
  approved: ['deployed'],
  deployed: ['verified', 'rolled_back'],
  verified: ['rolled_back'],
  rolled_back: [],
};

export function canTransition(from: ActionStatus, to: ActionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Apply a status transition, appending an audit entry. Returns a new Action
 * (never mutates). Throws on an illegal transition so the Fix Queue can't skip
 * approval or "verify" something that was never deployed.
 */
export function transition(
  action: Action,
  to: ActionStatus,
  env: BuildEnv,
  actor = 'system',
  detail?: object,
): Action {
  if (!canTransition(action.status, to)) {
    throw new Error(`Illegal action transition: ${action.status} → ${to}`);
  }
  // A content rewrite cannot be approved by a click that never showed the
  // wording. `reviewMarked` is the only way to set `reviewedAt`, and it takes
  // the text the reviewer actually saw.
  if (to === 'approved' && requiresHumanReview(action.type) && !action.reviewedAt) {
    throw new Error('This fix rewrites words on your page, so it has to be read and confirmed before it can be approved.');
  }
  const entry: AuditEntry = { timestamp: env.now(), actor, event: to, ...(detail ? { detail } : {}) };
  return { ...action, status: to, auditLog: [...action.auditLog, entry] };
}

/**
 * Record that a person read this fix's wording, optionally replacing it with
 * the text they edited. Returns a new Action with `reviewedAt`/`reviewedBy`
 * set and a `reviewed` audit entry, so the trail shows who confirmed what.
 * A re-review overwrites the timestamp — a customer may edit twice before
 * approving, and the audit log keeps both entries.
 */
export function reviewMarked(action: Action, env: BuildEnv, reviewer: string, editedAfter?: string): Action {
  if (action.status !== 'proposed') {
    throw new Error(`Only a proposed fix can be reviewed; this one is ${action.status}.`);
  }
  const edited = editedAfter !== undefined && editedAfter !== action.diff.after;
  const entry: AuditEntry = {
    timestamp: env.now(),
    actor: reviewer,
    event: 'reviewed',
    ...(edited ? { detail: { edited: true } } : {}),
  };
  return {
    ...action,
    diff: edited ? { ...action.diff, after: editedAfter as string } : action.diff,
    reviewedAt: env.now(),
    reviewedBy: reviewer,
    auditLog: [...action.auditLog, entry],
  };
}
