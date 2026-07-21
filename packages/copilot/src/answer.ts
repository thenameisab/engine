import type { Finding } from '@engine/core';
import type { Citation, CopilotAnswer, CopilotData, DrilldownRef, ParsedIntent, SuggestedAction } from './types.js';

/**
 * Turn retrieved facts into a cited answer. Everything here is deterministic:
 * the prose is assembled from the numbers, and each number is paired with a
 * `Citation` naming the table it came from. The optional phrasing model
 * (phrasing.ts) may later reword `answer` for fluency, but citations,
 * drilldown, and the suggested action are fixed here and never model-authored.
 */

/** Action template types that have a working executor behind the propose route. */
const EXECUTABLE = new Set(['schema', 'meta', 'robots', 'redirect', 'internal-link', 'content']);

function organicCitation(data: CopilotData): Citation {
  return {
    source: 'serp_positions',
    label:
      data.organic.keywordsTracked > 0
        ? `Organic SoV ${data.organic.sov.toFixed(0)}% across ${data.organic.keywordsTracked} keyword(s) (A1)`
        : 'no keywords tracked yet (A1)',
    ref: data.entityId,
  };
}

function aiCitation(data: CopilotData): Citation {
  return {
    source: 'citation_events',
    label:
      data.ai.samplesObserved > 0
        ? `AI Share of Model ${data.ai.band.point.toFixed(0)}% (${data.ai.band.low.toFixed(0)}–${data.ai.band.high.toFixed(0)} range, ${data.ai.samplesObserved} samples) (A2)`
        : 'AI visibility not measured yet (A2)',
    ref: data.entityId,
  };
}

function findingCitation(f: Finding): Citation {
  const url = (f.evidence as { url?: string }).url;
  return {
    source: 'findings',
    label: `${f.issueType}${url ? ` on ${url}` : ''} (impact ${(f.predictedImpact * 10).toFixed(1)}) (B1)`,
    ref: f.id,
  };
}

/**
 * Build the Finding -> Action suggestion from the highest-impact finding that
 * has an executable template. Returns undefined when no top finding is
 * fixable (a documented, non-executable diagnosis) — the answer then simply
 * carries no call-to-action rather than a dead button.
 */
function suggestedAction(projectId: string, findings: Finding[]): SuggestedAction | undefined {
  for (const f of findings) {
    const template = f.actionTemplates.find((t) => EXECUTABLE.has(t.type));
    if (template) {
      return {
        findingId: f.id,
        issueType: f.issueType,
        actionType: template.type,
        proposeHref: `/projects/${projectId}/findings/${f.id}/propose`,
        label: `Propose a ${template.type} fix for “${f.issueType}”`,
      };
    }
  }
  return undefined;
}

function visibilityAnswer(data: CopilotData): string {
  const organic =
    data.organic.keywordsTracked > 0
      ? `holds ${data.organic.sov.toFixed(0)}% organic share of voice across ${data.organic.keywordsTracked} tracked keyword(s)`
      : `has no keywords tracked yet`;
  const ai =
    data.ai.samplesObserved > 0
      ? `and ${data.ai.band.point.toFixed(0)}% AI share of model (${data.ai.band.low.toFixed(0)}–${data.ai.band.high.toFixed(0)} range over ${data.ai.samplesObserved} samples)`
      : `and its AI visibility has not been measured yet`;
  const findings =
    data.topFindings.length > 0
      ? ` There ${data.topFindings.length === 1 ? 'is' : 'are'} ${data.topFindings.length} open finding(s) worth reviewing.`
      : ` No open findings.`;
  return `${data.canonicalName} ${organic} ${ai}.${findings}`;
}

function comparisonAnswer(data: CopilotData): string {
  const hasOrganic = data.organic.keywordsTracked > 0;
  const hasAi = data.ai.samplesObserved > 0;
  if (!hasOrganic && !hasAi) {
    return `${data.canonicalName} has neither organic nor AI visibility data yet, so there is nothing to compare.`;
  }
  if (!hasAi) {
    return `${data.canonicalName} has ${data.organic.sov.toFixed(0)}% organic share of voice, but no AI visibility has been measured yet — connect AI polling to compare.`;
  }
  if (!hasOrganic) {
    return `${data.canonicalName} has ${data.ai.band.point.toFixed(0)}% AI share of model, but no organic keywords are tracked yet — add keywords to compare.`;
  }
  const organic = data.organic.sov;
  const ai = data.ai.band.point;
  const verdict =
    Math.abs(organic - ai) < 5
      ? `roughly level between the two`
      : organic > ai
        ? `stronger in organic search (${organic.toFixed(0)}%) than in AI answers (${ai.toFixed(0)}%)`
        : `stronger in AI answers (${ai.toFixed(0)}%) than in organic search (${organic.toFixed(0)}%)`;
  return `${data.canonicalName} is ${verdict}.`;
}

function findingsAnswer(data: CopilotData): string {
  if (data.topFindings.length === 0) {
    return `${data.canonicalName} has no open findings right now — nothing to fix.`;
  }
  const top = data.topFindings[0];
  const url = (top.evidence as { url?: string }).url;
  const others = data.topFindings.length - 1;
  return (
    `The highest-impact issue for ${data.canonicalName} is “${top.issueType}”${url ? ` on ${url}` : ''}` +
    ` (predicted impact ${(top.predictedImpact * 10).toFixed(1)})` +
    (others > 0 ? `, plus ${others} more open finding(s).` : `.`)
  );
}

function keywordRankAnswer(data: CopilotData): string {
  const kr = data.keywordRank;
  if (!kr) {
    return `I don't have a tracked ranking for that keyword under ${data.canonicalName}.`;
  }
  if (kr.position === null) {
    return `${data.canonicalName} is not ranking in the tracked results for “${kr.keyword}”.`;
  }
  return `${data.canonicalName} ranks at position ${kr.position} for “${kr.keyword}”.`;
}

/**
 * Assemble the full cited answer for a resolved intent. `projectId` is needed
 * only to build the propose-route href for the Finding -> Action suggestion.
 */
export function buildAnswer(intent: ParsedIntent, data: CopilotData, projectId: string): CopilotAnswer {
  const drilldown: DrilldownRef[] = [{ kind: 'entity', id: data.entityId }];
  const citations: Citation[] = [];
  let answer: string;

  switch (intent.type) {
    case 'organic_vs_ai':
      answer = comparisonAnswer(data);
      citations.push(organicCitation(data), aiCitation(data));
      break;
    case 'top_findings':
      answer = findingsAnswer(data);
      for (const f of data.topFindings) {
        citations.push(findingCitation(f));
        drilldown.push({ kind: 'finding', id: f.id });
      }
      break;
    case 'keyword_rank':
      answer = keywordRankAnswer(data);
      citations.push(organicCitation(data));
      break;
    case 'entity_visibility':
    default:
      answer = visibilityAnswer(data);
      citations.push(organicCitation(data), aiCitation(data));
      for (const f of data.topFindings) {
        citations.push(findingCitation(f));
        drilldown.push({ kind: 'finding', id: f.id });
      }
      break;
  }

  // A fix suggestion rides along whenever findings are in play — the
  // Finding -> Action bridge into the M2.3 propose route.
  const action =
    intent.type === 'top_findings' || intent.type === 'entity_visibility'
      ? suggestedAction(projectId, data.topFindings)
      : undefined;

  return {
    intent: intent.type,
    entityId: data.entityId,
    answer,
    citations,
    drilldown,
    ...(action ? { suggestedAction: action } : {}),
  };
}

/**
 * The honest fallback when no entity resolved. Carries no fabricated numbers,
 * names what the Copilot *can* answer, and leaves citations empty (nothing was
 * retrieved) so the UI shows a help prompt, not a confident non-answer.
 */
export function unknownAnswer(raw: string): CopilotAnswer {
  return {
    intent: 'unknown',
    answer:
      `I couldn't tell which tracked entity you mean, so I can't answer “${raw}” yet. ` +
      `Try naming an entity and asking about its visibility, its top findings, a keyword ranking, or organic-vs-AI.`,
    citations: [],
    drilldown: [],
  };
}
