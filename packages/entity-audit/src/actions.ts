/**
 * B3 §7 Finding -> Action mapping. Every entity-graph gap maps to an existing
 * executable ActionType — mostly `schema` (JSON-LD / sameAs injection via C2,
 * the highest-value deterministic fix) and `content` for corroboration (a C3
 * digital-PR-style rewrite). No new ActionType is introduced, so these
 * findings propose through the same generator the rest of the Fix Queue uses.
 */
import type { ActionTemplate } from '@engine/core';
import type { EntityIssueType } from './types.js';

const ACTION_TEMPLATES: Record<EntityIssueType, ActionTemplate[]> = {
  'missing-wikidata-mapping': [
    { type: 'schema', label: 'Add sameAs → Wikidata', description: 'Inject a sameAs link to the resolved Wikidata entity so search + AI map the entity (C2).' },
  ],
  'missing-entity-schema': [
    { type: 'schema', label: 'Inject entity JSON-LD', description: 'Add schema.org markup identifying the entity (Organization/LocalBusiness/Person) on the site (C2).' },
  ],
  'inconsistent-sameas': [
    { type: 'schema', label: 'Correct sameAs profiles', description: "Reconcile the on-site sameAs to include the entity's known official profiles (C2)." },
  ],
  'weak-corroboration': [
    { type: 'content', label: 'Corroborate the entity', description: 'Add content and digital-PR that corroborate the entity across independent sources (C3/C6).' },
  ],
};

export function actionTemplatesFor(type: EntityIssueType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}
