/**
 * B2 §7 Finding -> Action mapping, mirroring `@engine/diagnosis`'s actions.ts
 * for the technical pillar. Every content issue type maps to a 'content'
 * `ActionTemplate` — the C3 rewrite executor `@engine/actions`'s own
 * `generate.ts` documents as "not generated in the MVP" (needs an LLM,
 * declined this session). The finding still ships: diagnosis and execution
 * are separate concerns, and a Fix Queue with a real diff to show is C3's
 * problem to build, not B2's to block on.
 */
import type { ActionTemplate } from '@engine/core';

export type ContentIssueType = 'not-answer-first' | 'poor-self-containment' | 'weak-eeat' | 'weak-entity-coverage';

const ACTION_TEMPLATES: Record<ContentIssueType, ActionTemplate[]> = {
  'not-answer-first': [
    { type: 'content', label: 'Rewrite lead paragraph', description: 'Restructure the opening to answer-first (C3.1).' },
  ],
  'poor-self-containment': [
    { type: 'content', label: 'Restructure into quotable passages', description: 'Break dependent paragraphs into self-contained passages / FAQ blocks (C3.1).' },
  ],
  'weak-eeat': [
    { type: 'content', label: 'Add authorship/freshness signals', description: 'Add byline, publish/update date, and citation signals (C3.1).' },
  ],
  'weak-entity-coverage': [
    { type: 'content', label: 'Add covering sections', description: "Add sections grounded in the entity's known attributes/keywords (C3.1)." },
  ],
};

export function actionTemplatesFor(type: ContentIssueType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}
