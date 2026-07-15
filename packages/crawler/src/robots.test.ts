import { describe, it, expect } from 'vitest';
import { parseRobotsTxt, isAllowed, computeAiCrawlerAccessFromRobots } from './robots.js';

const TXT = `
User-agent: *
Disallow: /forbidden
Disallow: /admin/

User-agent: GPTBot
Disallow: /

User-agent: ClaudeBot
Allow: /
Disallow: /private/

User-agent: PerplexityBot
Disallow: /*.pdf$
`;

describe('parseRobotsTxt + isAllowed', () => {
  it('applies the wildcard group by default', () => {
    const rules = parseRobotsTxt(TXT);
    expect(isAllowed(rules, 'SomeRandomBot', '/forbidden')).toBe(false);
    expect(isAllowed(rules, 'SomeRandomBot', '/forbidden/sub')).toBe(false);
    expect(isAllowed(rules, 'SomeRandomBot', '/ok')).toBe(true);
  });

  it('fully blocks a named bot with Disallow: /', () => {
    const rules = parseRobotsTxt(TXT);
    expect(isAllowed(rules, 'GPTBot', '/')).toBe(false);
    expect(isAllowed(rules, 'GPTBot', '/anything')).toBe(false);
  });

  it('a named bot group overrides the wildcard group entirely', () => {
    const rules = parseRobotsTxt(TXT);
    // ClaudeBot has its own group (Allow: / plus Disallow: /private/), so the
    // wildcard group's /forbidden rule must NOT apply to it.
    expect(isAllowed(rules, 'ClaudeBot', '/forbidden')).toBe(true);
    expect(isAllowed(rules, 'ClaudeBot', '/private/x')).toBe(false);
  });

  it('longest match wins, with $ end-anchoring', () => {
    const rules = parseRobotsTxt(TXT);
    expect(isAllowed(rules, 'PerplexityBot', '/report.pdf')).toBe(false);
    expect(isAllowed(rules, 'PerplexityBot', '/report.pdf.html')).toBe(true);
  });

  it('computeAiCrawlerAccessFromRobots reports per-bot verdicts for a path', () => {
    const rules = parseRobotsTxt(TXT);
    expect(computeAiCrawlerAccessFromRobots(rules, '/')).toEqual({
      GPTBot: 'blocked',
      ClaudeBot: 'allowed',
      PerplexityBot: 'allowed',
      'Google-Extended': 'allowed',
    });
  });

  it('defaults to fully allowed when robots.txt is empty', () => {
    const rules = parseRobotsTxt('');
    expect(computeAiCrawlerAccessFromRobots(rules, '/anything')).toEqual({
      GPTBot: 'allowed',
      ClaudeBot: 'allowed',
      PerplexityBot: 'allowed',
      'Google-Extended': 'allowed',
    });
  });
});
