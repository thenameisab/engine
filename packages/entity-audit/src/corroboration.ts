/**
 * B3.4 corroboration: how consistently independent sources across the web
 * confirm the entity. The signal is *breadth of distinct sources*, not raw
 * count — ten mentions on one domain corroborate less than three on three
 * domains — so everything is deduped to registrable domains before scoring.
 */

/**
 * Reduce a URL (or bare domain) to a coarse registrable domain for dedupe.
 * Deliberately simple: strips scheme, path, port, `www.`, and takes the last
 * two labels. Good enough to stop counting `blog.x.com` and `x.com` twice
 * without pulling in a public-suffix list; B3's threshold is coarse anyway.
 */
export function registrableDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  let host = trimmed;
  const scheme = host.indexOf('://');
  if (scheme >= 0) host = host.slice(scheme + 3);
  host = host.split('/')[0].split('?')[0].split('#')[0];
  // A port is not part of the domain. Left in, `acme.com:8443` and `acme.com`
  // count as two distinct sources, and a site served on a non-default port is
  // never recognised as its own.
  host = host.replace(/:\d+$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  if (!host || !host.includes('.')) return host || null;
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  return labels.slice(-2).join('.');
}

/** Distinct registrable domains across all corroborating source lists. */
export function distinctSourceDomains(...sources: string[][]): Set<string> {
  const domains = new Set<string>();
  for (const list of sources) {
    for (const s of list) {
      const d = registrableDomain(s);
      if (d) domains.add(d);
    }
  }
  return domains;
}

/**
 * The corroboration target: at TARGET distinct source domains the entity is
 * considered fully corroborated (score 1). Chosen coarse and conservative —
 * the spec's §10 risk is over-claiming, so the bar to "strong" is modest and
 * the score saturates rather than rewarding link farms.
 */
export const CORROBORATION_TARGET = 5;

/** 0–1 corroboration score from the distinct-domain count, saturating at the target. */
export function corroborationScore(distinctDomains: number): number {
  if (distinctDomains <= 0) return 0;
  return Math.min(1, distinctDomains / CORROBORATION_TARGET);
}
