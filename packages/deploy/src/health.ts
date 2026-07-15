/**
 * C1.7 "automatic rollback" — the signal the edge-worker deploy target checks
 * on every request to decide whether a live transform is safe to keep serving.
 * Pure/deterministic: no I/O, so the policy is unit-testable without the
 * Workers runtime. Deliberately conservative (a false positive just means an
 * extra rollback + re-approve, a false negative means a broken customer page).
 */

export interface HealthCheck {
  ok: boolean;
  reason?: string;
}

/** A transform that shrinks the page below this fraction of its original size is treated as broken. */
export const MIN_SIZE_RATIO = 0.5;

const ok: HealthCheck = { ok: true };

/**
 * Check an origin-fetch + HTML-transform pair. Order matters: an origin error
 * is checked first since a transform can't be trusted against a broken origin.
 */
export function checkHtmlDeployHealth(originStatus: number, before: string, after: string): HealthCheck {
  if (originStatus >= 500) return { ok: false, reason: `origin-error-${originStatus}` };
  if (after.length < before.length * MIN_SIZE_RATIO) return { ok: false, reason: 'transform-shrunk-page' };
  const jsonLd = checkJsonLdValidity(after);
  if (!jsonLd.ok) return jsonLd;
  return ok;
}

/** Every injected JSON-LD block must still parse — a mangled schema fix is a broken fix. */
export function checkJsonLdValidity(html: string): HealthCheck {
  const blocks = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  for (const block of blocks) {
    try {
      JSON.parse(block[1]);
    } catch {
      return { ok: false, reason: 'invalid-json-ld' };
    }
  }
  return ok;
}

/** robots.txt must stay non-empty and syntactically a robots file. */
export function checkRobotsDeployHealth(originStatus: number, robotsTxt: string): HealthCheck {
  if (originStatus >= 500) return { ok: false, reason: `origin-error-${originStatus}` };
  if (robotsTxt.trim() === '') return { ok: false, reason: 'robots-empty' };
  if (!/user-agent:/i.test(robotsTxt)) return { ok: false, reason: 'robots-malformed' };
  return ok;
}
