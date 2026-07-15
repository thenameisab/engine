/**
 * sitemap.xml parsing for B1.3 (inSitemap coverage). A lightweight regex
 * extractor rather than a full XML parser — sitemap.xml is a constrained,
 * predictable format and pulling in a DOM/XML dependency isn't worth it here.
 */

export type ParsedSitemap =
  | { kind: 'sitemapindex'; locs: string[] }
  | { kind: 'urlset'; locs: string[] };

/** Extract `Sitemap:` directive URLs from a robots.txt body. */
export function extractSitemapDeclarations(robotsTxt: string): string[] {
  return [...robotsTxt.matchAll(/^sitemap:\s*(\S+)/gim)].map((m) => m[1]!.trim());
}

/** Extract every `<loc>` value and classify the document as an index or a leaf urlset. */
export function parseSitemapXml(xml: string): ParsedSitemap {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi)].map((m) => m[1]!.trim());
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'sitemapindex' : 'urlset';
  return { kind, locs };
}

/** Normalize a URL for set membership comparisons (drop trailing slash + hash/query noise from the path only). */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Fetch a sitemap (following sitemap-index nesting) and return the full set of
 * normalized page URLs it declares. Caps total sub-sitemaps fetched so a
 * malicious/huge index can't blow the crawl budget.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  fetchImpl: typeof fetch = fetch,
  maxSubSitemaps = 50,
): Promise<Set<string>> {
  const urls = new Set<string>();
  const queue = [sitemapUrl];
  let fetched = 0;

  while (queue.length > 0 && fetched < maxSubSitemaps) {
    const next = queue.shift()!;
    fetched++;
    let text: string;
    try {
      const res = await fetchImpl(next);
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue;
    }
    const parsed = parseSitemapXml(text);
    if (parsed.kind === 'sitemapindex') {
      queue.push(...parsed.locs);
    } else {
      for (const loc of parsed.locs) urls.add(normalizeUrl(loc));
    }
  }
  return urls;
}
