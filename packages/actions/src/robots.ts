/**
 * robots.txt AI-crawler policy fix — the C4.4 executable action for the GEO-
 * native "AI crawler blocked" finding (B1.6). Deterministic text transform:
 * remove/relax the `Disallow` rules that block the named AI user agents, or
 * append explicit allow blocks if none exist. No LLM.
 */
import type { Action } from '@engine/core';
import type { ActionContext } from './context.js';
import { buildAction, type BuildEnv } from './build.js';

/**
 * Produce a robots.txt that unblocks `crawlers`. For each blocked agent we emit
 * an explicit `User-agent: <bot>` / `Allow: /` block, and drop any existing
 * blanket `Disallow: /` that sat under that agent. Existing rules for other
 * agents are preserved verbatim.
 */
export function unblockCrawlers(current: string, crawlers: readonly string[]): string {
  const lines = current.split('\n');
  const out: string[] = [];
  let activeAgent: string | null = null;

  for (const line of lines) {
    const agentMatch = /^\s*User-agent:\s*(.+?)\s*$/i.exec(line);
    if (agentMatch) {
      activeAgent = agentMatch[1];
      out.push(line);
      continue;
    }
    // Drop a `Disallow: /` that applies to one of the blocked AI agents.
    if (activeAgent && crawlers.includes(activeAgent) && /^\s*Disallow:\s*\/\s*$/i.test(line)) {
      out.push(`Allow: /`);
      continue;
    }
    out.push(line);
  }

  // Ensure every named crawler has an explicit allow block.
  const text = out.join('\n');
  const additions: string[] = [];
  for (const bot of crawlers) {
    const hasBlock = new RegExp(`^\\s*User-agent:\\s*${escapeRegExp(bot)}\\s*$`, 'im').test(text);
    if (!hasBlock) additions.push(`\nUser-agent: ${bot}\nAllow: /`);
  }
  return (text.replace(/\s*$/, '') + additions.join('')).replace(/^\n+/, '') + '\n';
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function generateRobotsAction(findingId: string, ctx: ActionContext, env: BuildEnv): Action | null {
  const crawlers = ctx.blockedCrawlers ?? [];
  if (crawlers.length === 0) return null;
  const before = ctx.currentRobotsTxt ?? '';
  const after = unblockCrawlers(before, crawlers);
  return buildAction({
    findingId,
    type: 'robots',
    target: ctx.target,
    diff: { before, after, format: 'text' },
    env,
  });
}
