/**
 * Turning a stored Finding into queued Actions, for one finding or a whole
 * issue group.
 *
 * Extracted from the single-finding route so "Fix on all N pages" runs exactly
 * the same code path as fixing one. A crawl reports one finding per page per
 * issue, so a 7-page site with 6 issues is 42 findings that differ only in URL
 * — and the Audit screen offered a button per row, which meant the way to fix
 * a missing <title> across a site was to click 42 times and read 42 toasts.
 */
import { generateActions, generateContentAction, defaultEnv } from '@engine/actions';
import type { ActionContext } from '@engine/actions';
import type { Action, DeployTarget, Finding } from '@engine/core';
import { getCrawledPage, listInternalLinkTargets } from './crawledPages.js';
import { getEntityInProject } from './entities.js';
import { createAction } from './actions.js';
import { entityJsonLdProperties, entitySchemaType } from './entityJsonLd.js';
import type { Db } from '../db.js';

export interface ProposeSkip {
  type: string;
  reason: string;
  /** Which finding could not be fixed — the batch caller needs to say which page. */
  findingId?: string;
  url?: string;
}

export interface ProposeResult {
  actions: Action[];
  skipped: ProposeSkip[];
}

export interface ProposeEnv {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}

export interface ProposeOptions {
  target: DeployTarget;
  internalLinkSuggestions?: { anchor: string; href: string }[];
  /**
   * Whether a costed LLM rewrite may run. False for a batch: a content rewrite
   * is a paid call per page, and "Fix on all 40 pages" must not turn one click
   * into forty invoices without the customer having chosen that.
   */
  allowContent: boolean;
}

/**
 * Rebuild a finding's context from what `/audit` persisted and generate its
 * fixes. Throws only for a content-rewrite vendor failure, which the caller
 * reports as a 502; every other "nothing came out" is a `skipped` entry with a
 * sentence the customer can act on.
 */
export async function proposeForFinding(
  db: Db,
  env: ProposeEnv,
  projectId: string,
  finding: Finding,
  opts: ProposeOptions,
): Promise<ProposeResult> {
  const url = (finding.evidence as { url?: string }).url ?? '';
  const page = url ? await getCrawledPage(db, projectId, url) : null;
  const entity = await getEntityInProject(db, projectId, finding.entityId);

  const internalLinkSuggestions =
    opts.internalLinkSuggestions ?? (url ? await listInternalLinkTargets(db, projectId, url) : []);

  const ctx: ActionContext = {
    url,
    target: opts.target,
    currentTitle: page?.title ?? undefined,
    currentMetaDescription: page?.metaDescription ?? undefined,
    currentBodyText: page?.bodyText ?? undefined,
    currentBodyHtml: page?.bodyHtml ?? undefined,
    headings: page?.headings ?? undefined,
    internalLinkSuggestions,
    entity: entity
      ? {
          schemaType: entitySchemaType(entity),
          name: entity.canonicalName,
          properties: entityJsonLdProperties(entity, url),
        }
      : undefined,
  };

  const generated = generateActions(finding, ctx);
  const skipped: ProposeSkip[] = generated.skipped.map((s) => ({ ...s, findingId: finding.id, url }));

  const wantsContent = finding.actionTemplates.some((t) => t.type === 'content');
  if (wantsContent) {
    if (!opts.allowContent) {
      skipped.push({
        type: 'content',
        reason: 'Rewriting page copy is a paid call per page, so it is proposed one page at a time.',
        findingId: finding.id,
        url,
      });
    } else if (!env.OPENAI_API_KEY) {
      skipped.push({
        type: 'content',
        reason: 'Rewriting page copy is not switched on for this deployment.',
        findingId: finding.id,
        url,
      });
    } else {
      const contentAction = await generateContentAction(
        finding,
        ctx,
        { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL },
        defaultEnv(),
      );
      if (contentAction) generated.actions.push(contentAction);
      else {
        skipped.push({
          type: 'content',
          reason: 'The last crawl captured no text on this page to rewrite.',
          findingId: finding.id,
          url,
        });
      }
    }
  }

  const actions = await Promise.all(generated.actions.map((action) => createAction(db, action)));
  return { actions, skipped };
}

/**
 * A ceiling on findings proposed in one batch.
 *
 * Each finding is several database round trips and an insert, all inside one
 * request. A site with a thousand pages missing a <title> would otherwise turn
 * one click into a request that runs past the Worker's limit and is killed
 * mid-way, leaving some fixes queued and no way to tell which. Stopping on
 * purpose leaves a number the screen can report.
 */
export const PROPOSE_BATCH_CAP = 50;
