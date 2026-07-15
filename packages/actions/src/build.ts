/**
 * Shared assembly + lifecycle helpers for `Action` objects (Fix Queue / C1 core).
 *
 * Generators (./schema.ts etc.) produce the `Diff`; this module wraps it into a
 * complete `Action` in the `proposed` state with an opening audit entry, and
 * provides the deterministic state-machine + audit-append used by the Fix Queue
 * to move an action proposed → approved → deployed → verified → rolled_back.
 */
import type { Action, ActionStatus, ActionType, AuditEntry, Diff, DeployTarget } from '@engine/core';

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
  const entry: AuditEntry = { timestamp: env.now(), actor, event: to, ...(detail ? { detail } : {}) };
  return { ...action, status: to, auditLog: [...action.auditLog, entry] };
}
