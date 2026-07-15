/**
 * View-model types for the dashboard. Deliberately self-contained (not imported
 * from @engine/* ) so the browser build has zero cross-package resolution — the
 * dashboard shapes the API's JSON into exactly what each view needs.
 */

/** The A3 unified score with its honest confidence band. */
export interface ScoreBand {
  point: number;
  low: number;
  high: number;
}

export interface ChannelContribution {
  key: 'organic' | 'ai' | 'local';
  label: string;
  /** Present as a band when the channel carries uncertainty (AI Share of Model). */
  value: number;
  low?: number;
  high?: number;
  sub: string;
}

export interface PulseData {
  score: ScoreBand;
  deltaVsPrior: number;
  /** Trend series (older → newest), each a point value, for the sparkline. */
  trend: number[];
  contributions: ChannelContribution[];
  wins: SignalRow[];
  risks: SignalRow[];
}

export interface SignalRow {
  title: string;
  meta: string;
  move: number;
}

export type ActionStatus = 'proposed' | 'approved' | 'deployed' | 'verified' | 'rolled_back';

export interface ActionCard {
  id: string;
  kind: string; // Schema / Robots / Meta / Redirect …
  title: string;
  impact?: number;
  effort?: string;
  status: ActionStatus;
}

export interface FindingRow {
  id: string;
  type: string;
  title: string;
  severity: 'high' | 'medium' | 'low';
  predictedImpact: number;
  autoFixable: boolean;
  url: string;
}

export interface AuditData {
  healthScore: number;
  autoFixableCount: number;
  findings: FindingRow[];
}

/** Mirrors @engine/config's ReadinessReport shape (structural, not imported). */
export interface IntegrationReadiness {
  id: string;
  name: string;
  category: string;
  requiredForMvp: boolean;
  status: 'configured' | 'partial' | 'missing';
  missing: { name: string; description: string }[];
  optionalPresent: string[];
}

export interface ReadinessReport {
  integrations: IntegrationReadiness[];
  mvpReady: boolean;
  summary: { configured: number; partial: number; missing: number; total: number };
}

/** Whether a view is showing live API data or the built-in sample. */
export type DataSource = 'live' | 'sample';

export interface Loaded<T> {
  data: T;
  source: DataSource;
}
