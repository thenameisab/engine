/**
 * The B1 §7 Finding -> Action mapping — the MVP-critical contract.
 *
 * Every technical issue type this package can detect maps to >=1 executable
 * `ActionTemplate` (or a documented reason it can't). This table is the single
 * source of truth for that mapping; the rule engine attaches these templates to
 * each `Finding` so the Fix Queue (Pillar C) has something to execute. The spec
 * is explicit: a finding with zero action templates and no documented reason is
 * a product bug, so ./rules.ts asserts every emitted finding is non-empty here.
 */
import type { ActionTemplate } from '@engine/core';

/** The distinct technical-issue types B1 detects (drives severity weights too). */
export type IssueType =
  | 'schema-missing'
  | 'schema-invalid'
  | 'meta-title-missing'
  | 'meta-description-missing'
  | 'ai-crawler-blocked'
  | 'redirect-chain'
  | 'canonical-conflict'
  | 'hreflang-missing'
  | 'cwv-poor'
  | 'noindex-unexpected'
  | 'not-in-sitemap';

/**
 * Action templates per issue type (spec §7 table, extended to the CWV / index
 * signals that ship in the MVP crawl). An empty array is only permitted when
 * paired with a `nonExecutableReason` below.
 */
const ACTION_TEMPLATES: Record<IssueType, ActionTemplate[]> = {
  'schema-missing': [
    { type: 'schema', label: 'Generate JSON-LD', description: 'Inject valid schema.org JSON-LD for this page (C2).' },
  ],
  'schema-invalid': [
    { type: 'schema', label: 'Fix JSON-LD', description: 'Regenerate valid JSON-LD, correcting validator errors (C2).' },
  ],
  'meta-title-missing': [
    { type: 'meta', label: 'Regenerate title', description: 'Generate a title tag from page content (C3.2).' },
  ],
  'meta-description-missing': [
    { type: 'meta', label: 'Regenerate meta description', description: 'Generate a meta description from page content (C3.2).' },
  ],
  'ai-crawler-blocked': [
    { type: 'robots', label: 'Allow AI crawlers', description: 'Update robots.txt AI-crawler policy to unblock (C4.4).' },
  ],
  'redirect-chain': [
    { type: 'redirect', label: 'Collapse redirect chain', description: 'Rewrite to a single-hop redirect (C4.1).' },
  ],
  'canonical-conflict': [
    { type: 'redirect', label: 'Fix canonical', description: 'Resolve the conflicting canonical signal (C4.2).' },
  ],
  'hreflang-missing': [
    { type: 'meta', label: 'Generate hreflang', description: 'Emit hreflang alternates for the i18n cluster (C4.3).' },
  ],
  // CWV is a diagnosis-only signal in the MVP: the fix is human dev work, not an
  // automatable Fix Queue action. Documented per §7 "or ship a documented reason".
  'cwv-poor': [],
  'noindex-unexpected': [],
  'not-in-sitemap': [],
};

/** Documented reasons for the issue types that legitimately carry no action template. */
const NON_EXECUTABLE_REASONS: Partial<Record<IssueType, string>> = {
  'cwv-poor': 'Core Web Vitals remediation is code/infra work; surfaced as a scored finding, no auto-fix in MVP.',
  'noindex-unexpected': 'Unexpected noindex needs human intent review before any automated change.',
  'not-in-sitemap': 'Sitemap coverage is resolved by regenerating the sitemap upstream, not per-page.',
};

export function actionTemplatesFor(type: IssueType): ActionTemplate[] {
  return ACTION_TEMPLATES[type];
}

export function nonExecutableReasonFor(type: IssueType): string | undefined {
  return NON_EXECUTABLE_REASONS[type];
}

/**
 * Contract guard: every issue type must either carry >=1 action template or a
 * documented non-executable reason. Exposed so tests can assert the whole table
 * satisfies §7 ("product bug otherwise").
 */
export function hasValidActionMapping(type: IssueType): boolean {
  return ACTION_TEMPLATES[type].length > 0 || NON_EXECUTABLE_REASONS[type] !== undefined;
}
