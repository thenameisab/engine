/**
 * Pure presentation helpers — no DOM, unit-tested. Keeping the geometry math
 * (confidence-band bar positions, sparkline paths) out of the view code means
 * the fiddly bits are verifiable in isolation.
 */
import type { ActionCard, ApiAction, ScoreBand, ActionStatus, SerpOrganic } from './types.js';

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Map a confidence band onto a 0–100% range-bar. The bar shows a local window
 * padded by the band width on each side, so a wider band visibly fills more of
 * the track — uncertainty is legible, never hidden. Tick marks the point value.
 */
export function bandPositions(band: ScoreBand): { leftPct: number; rightPct: number; tickPct: number } {
  const width = Math.max(band.high - band.low, 2);
  const domainMin = band.low - width;
  const domainMax = band.high + width;
  const span = domainMax - domainMin || 1;
  const pct = (v: number) => clamp(((v - domainMin) / span) * 100, 0, 100);
  const left = pct(band.low);
  const right = pct(band.high);
  return {
    leftPct: left,
    rightPct: 100 - right, // CSS `right` inset
    tickPct: pct(band.point),
  };
}

/** Build an SVG polyline `d` for a sparkline mapping a series into a viewBox. */
export function sparklinePath(series: number[], width: number, height: number, pad = 3): string {
  if (series.length === 0) return '';
  if (series.length === 1) {
    const y = height / 2;
    return `M0,${y} L${width},${y}`;
  }
  const min = Math.min(...series);
  const max = Math.max(...series);
  const range = max - min || 1;
  const innerH = height - pad * 2;
  const step = width / (series.length - 1);
  const pts = series.map((v, i) => {
    const x = i * step;
    const y = pad + innerH * (1 - (v - min) / range);
    return `${round(x)},${round(y)}`;
  });
  return `M${pts.join(' L')}`;
}

/** Close a line path into a filled area down to the baseline. */
export function sparklineArea(series: number[], width: number, height: number, pad = 3): string {
  const line = sparklinePath(series, width, height, pad);
  if (!line) return '';
  return `${line} L${round(width)},${height} L0,${height} Z`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** A signed, one-decimal delta, e.g. +4.2 / −1.0 (real minus sign). */
export function fmtDelta(n: number): string {
  const s = n.toFixed(1);
  return n >= 0 ? `+${s}` : s.replace('-', '−');
}

/** Hostname of a URL, lowercased, without a leading www. Empty if unparseable. */
export function hostname(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Normalize a user-entered domain to a bare host for matching. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

/** The position of the first organic result whose host matches `domain`, or null if not found. */
export function domainRank(organic: SerpOrganic[], domain: string): number | null {
  const target = normalizeDomain(domain);
  if (!target) return null;
  for (const o of organic) {
    const host = hostname(o.url);
    if (host === target || host.endsWith(`.${target}`)) return o.position;
  }
  return null;
}

/** Human label for a SERP feature key. */
export function serpFeatureLabel(feature: string): string {
  return feature.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Map a persisted Action from the API onto the card the Fix Queue renders. */
export function toActionCard(a: ApiAction): ActionCard {
  return {
    id: a.id,
    kind: actionKindLabel(a.type),
    title: actionTitle(a),
    impact: impactPoints(a.predictedImpact),
    effort: effortLabel(a.target.kind),
    status: a.status,
  };
}

/**
 * Diagnosis scores predicted impact on 0–1 (severity weight x page value); the
 * card reads "+N impact" on a 0–10 scale. Rescale here rather than changing the
 * Finding contract — 0–1 is the right shape for the scoring math, and "+0.855
 * impact" is the wrong shape for a human deciding what to approve first.
 */
export function impactPoints(predictedImpact: number): number {
  return Math.round(clamp(predictedImpact, 0, 1) * 10);
}

/**
 * A card needs a human sentence, but an Action carries only a typed diff. Derive
 * the sentence from the diff rather than storing prose: the diff is what actually
 * deploys, so a title built from it cannot drift from what the fix does.
 */
export function actionTitle(a: ApiAction): string {
  const where = targetLabel(a.target);
  switch (a.type) {
    case 'meta':
      return `Regenerate ${a.diff.field ?? 'meta'} · ${where}`;
    case 'schema':
      return `Inject JSON-LD · ${where}`;
    case 'robots':
      return `Update robots.txt · ${where}`;
    case 'redirect':
      return `Fix redirect · ${where}`;
    case 'content':
      return `Content rewrite · ${where}`;
    case 'gbp':
      return `Update business profile · ${where}`;
    default:
      return `${actionKindLabel(a.type)} · ${where}`;
  }
}

/** Where a fix lands, in the user's terms. */
export function targetLabel(t: ApiAction['target']): string {
  switch (t.kind) {
    case 'cms-plugin':
      return [t.plugin, t.siteId].filter(Boolean).join(' · ') || 'cms plugin';
    case 'edge-worker':
      return t.workerName ?? 'edge worker';
    case 'github-pr':
      return t.repo ?? 'repo';
    case 'gbp-api':
      return t.locationId ?? 'location';
    default:
      return t.kind;
  }
}

export function actionKindLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

/** How much work a fix costs the user, read off where it deploys. */
export function effortLabel(targetKind: string): string {
  switch (targetKind) {
    case 'cms-plugin':
      return '1-click';
    case 'edge-worker':
      return 'edge';
    case 'github-pr':
      return 'PR';
    case 'gbp-api':
      return 'auto';
    default:
      return targetKind;
  }
}

const STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: 'Proposed',
  approved: 'Approved',
  deployed: 'Deployed',
  verified: 'Verified',
  rolled_back: 'Rolled back',
};

export function statusLabel(status: ActionStatus): string {
  return STATUS_LABELS[status];
}

/** The Fix Queue lanes, in lifecycle order (rolled_back shown as its own lane). */
export const LANE_ORDER: ActionStatus[] = ['proposed', 'approved', 'deployed', 'verified'];

/** The legal next transition for an action, or null at a terminal state. */
export function nextAction(status: ActionStatus): { to: ActionStatus; label: string } | null {
  switch (status) {
    case 'proposed':
      return { to: 'approved', label: 'Approve' };
    case 'approved':
      return { to: 'deployed', label: 'Deploy' };
    case 'deployed':
      return { to: 'verified', label: 'Verify' };
    default:
      return null;
  }
}
