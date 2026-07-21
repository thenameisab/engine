/**
 * A5 §7 Finding -> Action mapping. Each gap maps to an existing executable
 * ActionType so competitor findings propose through the same generator the
 * rest of the Fix Queue uses — no new ActionType is introduced (the frozen
 * contract, Architecture §3.1). The gap's provenance lives in its issueType +
 * evidence (which competitor holds it), not in a new `source`.
 */
import type { ActionTemplate, FindingSource } from '@engine/core';
import type { GapType } from './types.js';

const ACTION_TEMPLATES: Record<GapType, ActionTemplate[]> = {
  'keyword-gap': [
    { type: 'content', label: 'Draft covering content', description: 'Create content targeting the keyword a competitor ranks for and you do not (C3).' },
  ],
  'citation-gap': [
    { type: 'content', label: 'Extractability rewrite', description: 'Rewrite for extractability so AI answers cite you on the prompt a competitor owns (C3/C6).' },
  ],
  'content-gap': [
    { type: 'content', label: 'Draft covering content', description: 'Cover the topic competitors cover and you do not (C3).' },
  ],
  'entity-gap': [
    { type: 'schema', label: 'Strengthen entity graph', description: 'Close the entity-strength gap via knowledge-graph/schema fixes (B3/C2).' },
  ],
  'backlink-gap': [
    { type: 'content', label: 'Digital-PR outreach', description: 'Earn the referring domain a competitor has and you do not via digital PR (C6).' },
  ],
};

/**
 * The Finding source each gap writes under (the frozen union — no new member).
 * Gaps that resolve to on-site content/link work file as `content`; the entity
 * gap files as `entity` alongside B3, since it is closed with the same
 * knowledge-graph fixes.
 */
const GAP_SOURCE: Record<GapType, FindingSource> = {
  'keyword-gap': 'content',
  'citation-gap': 'content',
  'content-gap': 'content',
  'entity-gap': 'entity',
  'backlink-gap': 'content',
};

export function actionTemplatesFor(type: GapType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}

export function findingSourceFor(type: GapType): FindingSource {
  return GAP_SOURCE[type];
}
