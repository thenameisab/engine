/**
 * B5 §7 Finding -> Action mapping. Local findings resolve to GBP automation
 * (C5) via the `gbp` ActionType — already in the frozen contract — except NAP
 * corrections, which are off-GBP directory edits and route as `content`
 * citation tasks (C6.3). No new ActionType or source is introduced.
 */
import type { ActionTemplate } from '@engine/core';
import type { LocalIssueType } from './types.js';

const ACTION_TEMPLATES: Record<LocalIssueType, ActionTemplate[]> = {
  'incomplete-gbp-field': [
    { type: 'gbp', label: 'Update GBP profile field', description: 'Fill the missing Google Business Profile field (category/hours/attributes/photos/description) (C5.3).' },
  ],
  'nap-inconsistency': [
    { type: 'content', label: 'Correct directory NAP', description: 'Correct the Name/Address/Phone on the directory listing that disagrees with the profile (C6.3).' },
  ],
  'unanswered-reviews': [
    { type: 'gbp', label: 'Draft review replies', description: 'Draft owner responses to the unanswered reviews (C5.4).' },
  ],
  'low-review-velocity': [
    { type: 'gbp', label: 'Post to GBP / request reviews', description: 'Publish a GBP post and prompt recent customers for reviews to lift velocity (C5.1).' },
  ],
};

export function actionTemplatesFor(type: LocalIssueType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}
