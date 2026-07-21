/**
 * A6 §7 Finding -> Action mapping. Off-site fixes route through existing
 * executable ActionTypes (the frozen contract) — digital-PR outreach and
 * profile completeness are `content` drafts (C6 has no distinct ActionType),
 * a negative-mention cluster is a `content` review task. No new ActionType or
 * source is introduced.
 */
import type { ActionTemplate, FindingSource } from '@engine/core';
import type { OffsiteIssueType } from './types.js';

const ACTION_TEMPLATES: Record<OffsiteIssueType, ActionTemplate[]> = {
  'absent-from-citation-domain': [
    { type: 'content', label: 'Draft digital-PR outreach', description: 'Draft outreach + target to earn a citation on a domain AI cites in your category but not you (C6).' },
  ],
  'incomplete-third-party-profile': [
    { type: 'content', label: 'Complete third-party profile', description: 'Create/complete the profile on a directory/review site (G2/Capterra/JustDial) the entity is missing from (C6).' },
  ],
  'negative-mention-cluster': [
    { type: 'content', label: 'Review negative mentions', description: 'Flag the negative-sentiment mention cluster for review/response.' },
  ],
};

/** Off-site findings file under the content vocabulary (they resolve to content/PR work). */
const SOURCE: FindingSource = 'content';

export function actionTemplatesFor(type: OffsiteIssueType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}

export function findingSourceFor(_type: OffsiteIssueType): FindingSource {
  return SOURCE;
}
