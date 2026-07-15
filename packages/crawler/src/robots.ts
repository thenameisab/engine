/**
 * robots.txt parsing for B1.6 (AI-crawler access audit) and general
 * indexability signals. Pure string parsing, no I/O — the crawler fetches the
 * text; this module just interprets it.
 */
import type { AiCrawler, CrawlerAccess } from '@engine/diagnosis';

interface RobotsGroup {
  allow: string[];
  disallow: string[];
}

/** Parsed robots.txt: one rule group per user-agent, lowercased keys. */
export type RobotsRules = Map<string, RobotsGroup>;

const AI_CRAWLERS: AiCrawler[] = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

/** Parse robots.txt into per-user-agent allow/disallow rule groups. */
export function parseRobotsTxt(text: string): RobotsRules {
  const groups: RobotsRules = new Map();
  let currentAgents: string[] = [];
  let sawRuleSinceAgent = true; // forces a fresh group on the next User-agent line

  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]!.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      const ua = value.toLowerCase();
      if (sawRuleSinceAgent) {
        // A new block of consecutive User-agent lines starts a fresh group set.
        currentAgents = [];
        sawRuleSinceAgent = false;
      }
      currentAgents.push(ua);
      if (!groups.has(ua)) groups.set(ua, { allow: [], disallow: [] });
    } else if (field === 'allow' || field === 'disallow') {
      for (const ua of currentAgents) {
        const group = groups.get(ua);
        if (group) group[field].push(value);
      }
      sawRuleSinceAgent = true;
    }
  }
  return groups;
}

/** Longest-match-wins per the de facto (Google) robots.txt spec; ties favor Allow. */
function matchLength(pattern: string, path: string): number {
  if (pattern === '') return 0;
  // Minimal wildcard support: '*' matches any run of characters, '$' anchors the end.
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const parts = body.split('*');
  let cursor = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const idx = path.indexOf(part, cursor);
    if (idx === -1 || (i === 0 && idx !== 0)) return -1;
    cursor = idx + part.length;
  }
  if (anchored && cursor !== path.length) return -1;
  return pattern.length;
}

function groupForAgent(rules: RobotsRules, userAgent: string): RobotsGroup | undefined {
  return rules.get(userAgent.toLowerCase()) ?? rules.get('*');
}

/** Is `userAgent` allowed to fetch `path` per the parsed robots.txt? Default allow. */
export function isAllowed(rules: RobotsRules, userAgent: string, path: string): boolean {
  const group = groupForAgent(rules, userAgent);
  if (!group) return true;

  let bestLen = -1;
  let bestAllowed = true;
  for (const pattern of group.disallow) {
    const len = matchLength(pattern, path);
    if (len > bestLen) {
      bestLen = len;
      bestAllowed = false;
    }
  }
  for (const pattern of group.allow) {
    const len = matchLength(pattern, path);
    if (len > bestLen) {
      bestLen = len;
      bestAllowed = true;
    }
  }
  return bestAllowed;
}

/** B1.6: per-AI-crawler allow/blocked verdict for one URL path, from robots.txt alone. */
export function computeAiCrawlerAccessFromRobots(
  rules: RobotsRules,
  path: string,
): Record<AiCrawler, CrawlerAccess> {
  const result = {} as Record<AiCrawler, CrawlerAccess>;
  for (const bot of AI_CRAWLERS) {
    result[bot] = isAllowed(rules, bot, path) ? 'allowed' : 'blocked';
  }
  return result;
}

export { AI_CRAWLERS };
