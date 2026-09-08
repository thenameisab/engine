/**
 * Pure readiness evaluation: given an environment record (Worker bindings,
 * `process.env`, `.dev.vars`, …), report which integrations are wired up.
 * No I/O — feeds `GET /health/integrations` and any startup validation.
 */
import { INTEGRATIONS, type IntegrationDef, type IntegrationStatus } from './integrations.js';

/** A single missing/blank required var, for actionable readiness output. */
export interface MissingVar {
  name: string;
  description: string;
}

export interface IntegrationReadiness {
  id: string;
  name: string;
  category: IntegrationDef['category'];
  /** Brand domain for the logo, or '' when the integration has no vendor. */
  logoDomain: string;
  requiredForMvp: boolean;
  status: IntegrationStatus;
  /** Required vars that are absent or blank. Empty when status is 'configured'. */
  missing: MissingVar[];
  /** Optional vars that are present (useful signal for partially-tuned setups). */
  optionalPresent: string[];
}

export interface ReadinessReport {
  integrations: IntegrationReadiness[];
  /** True when every `requiredForMvp` integration is fully configured. */
  mvpReady: boolean;
  summary: { configured: number; partial: number; missing: number; total: number };
}

type EnvRecord = Record<string, string | undefined>;

function isPresent(env: EnvRecord, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

/** Evaluate one integration's status against the env. */
export function evaluateIntegration(def: IntegrationDef, env: EnvRecord): IntegrationReadiness {
  const requiredVars = def.env.filter((v) => v.required);
  const optionalVars = def.env.filter((v) => !v.required);

  const missing = requiredVars
    .filter((v) => !isPresent(env, v.name))
    .map((v) => ({ name: v.name, description: v.description }));
  const requiredPresent = requiredVars.length - missing.length;

  let status: IntegrationStatus;
  if (missing.length === 0) status = 'configured';
  else if (requiredPresent > 0) status = 'partial';
  else status = 'missing';

  return {
    id: def.id,
    name: def.name,
    category: def.category,
    logoDomain: def.logoDomain,
    requiredForMvp: def.requiredForMvp,
    status,
    missing,
    optionalPresent: optionalVars.filter((v) => isPresent(env, v.name)).map((v) => v.name),
  };
}

/** Full readiness report across every registered integration. */
export function evaluateReadiness(env: EnvRecord): ReadinessReport {
  const integrations = INTEGRATIONS.map((def) => evaluateIntegration(def, env));
  const summary = {
    configured: integrations.filter((i) => i.status === 'configured').length,
    partial: integrations.filter((i) => i.status === 'partial').length,
    missing: integrations.filter((i) => i.status === 'missing').length,
    total: integrations.length,
  };
  const mvpReady = integrations
    .filter((i) => i.requiredForMvp)
    .every((i) => i.status === 'configured');

  return { integrations, mvpReady, summary };
}
