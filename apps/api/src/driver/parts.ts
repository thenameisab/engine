/**
 * What each tool's answer looks like on screen — §4.5's "each tool declares its
 * own render shape".
 *
 * One file holding all nineteen shapes, rather than a builder beside each
 * handler. The reason is review: "does Driver render a sensible answer to every
 * question in the catalogue" is a question you can answer by reading this file
 * top to bottom, and cannot answer by reading nineteen files. The catalogue
 * itself is one file for the same reason.
 *
 * The cost is dotted paths, which the compiler cannot check against handler
 * output. `parts.db.test.ts` closes that: it runs every spec against seeded
 * data and fails on any declared path that resolves to `undefined`.
 *
 * `assertRenderCoversCatalogue` runs at module load, the same guard
 * `registry.ts` puts on handlers. A tool the model can call and the screen
 * cannot render is a blank answer to a question that worked.
 */
import {
  READ_TOOLS,
  assembleAnswer,
  buildParts,
  parseToolResultEnvelope,
  type ResponsePart,
  type ToolRender,
} from '@engine/driver';

/**
 * Every read tool's render shape, in catalogue order.
 *
 * Three habits worth keeping when adding to this.
 *
 * **Label for the reader, not the column.** `predictedImpact` is a database
 * field; "Predicted impact" is what it means. The model never sees these
 * strings — they are for the person reading the answer.
 *
 * **A `limit` where a list could be long.** The model asks for what it needs;
 * this is what fits on screen without becoming the screen.
 *
 * **Bands via `bandAt`, never a point.** §4.6 rule 4. `ai_citations` is the
 * only tool that samples, and its rate is the only `bandAt` here.
 */
export const RENDER_SPECS: Record<string, ToolRender> = {
  /* ── Search, from Google Search Console ─────────────────────────────────── */

  search_performance: {
    metrics: [
      { label: 'Clicks', at: 'totals.clicks', unit: 'count' },
      { label: 'Impressions', at: 'totals.impressions', unit: 'count' },
      { label: 'Click-through rate', at: 'totals.ctr', unit: 'percent' },
      { label: 'Average position', at: 'totals.position', unit: 'position' },
    ],
    series: { title: 'Clicks per day', at: 'dailyClicks', xAt: 'date', yAt: 'clicks', unit: 'count' },
  },

  top_queries: {
    table: {
      title: 'Queries bringing people to the site',
      at: 'queries',
      limit: 25,
      columns: [
        { label: 'Query', at: 'query', unit: 'text' },
        { label: 'Clicks', at: 'clicks', unit: 'count' },
        { label: 'Impressions', at: 'impressions', unit: 'count' },
        { label: 'Position', at: 'position', unit: 'position' },
      ],
    },
  },

  top_pages: {
    table: {
      title: 'Pages earning search traffic',
      at: 'pages',
      limit: 25,
      columns: [
        { label: 'Page', at: 'page', unit: 'text' },
        { label: 'Clicks', at: 'clicks', unit: 'count' },
        { label: 'Impressions', at: 'impressions', unit: 'count' },
        { label: 'Position', at: 'position', unit: 'position' },
      ],
    },
  },

  queries_within_reach: {
    table: {
      title: 'Queries close to the first page',
      at: 'queries',
      limit: 25,
      columns: [
        { label: 'Query', at: 'query', unit: 'text' },
        { label: 'Position', at: 'position', unit: 'position' },
        { label: 'Impressions', at: 'impressions', unit: 'count' },
        { label: 'Clicks', at: 'clicks', unit: 'count' },
      ],
    },
  },

  /* ── Traffic, from Google Analytics ─────────────────────────────────────── */

  traffic_by_channel: {
    // `channels`, not the raw GA4 rows: the handler folds AI assistants out of
    // whichever group GA4 filed them under into a channel of their own, and
    // that fold is the tool's answer. Rendering the unfolded rows would put
    // ChatGPT back under Referral on screen.
    table: {
      title: 'Where sessions came from',
      at: 'channels',
      limit: 25,
      columns: [
        { label: 'Channel', at: 'label', unit: 'text' },
        { label: 'Sessions', at: 'sessions', unit: 'count' },
        { label: 'Engaged', at: 'engagedSessions', unit: 'count' },
        { label: 'Key events', at: 'keyEvents', unit: 'count' },
      ],
    },
  },

  ai_referral_traffic: {
    metrics: [
      { label: 'Sessions from AI assistants', at: 'totals.sessions', unit: 'count' },
      { label: 'Share of all sessions', at: 'totals.shareOfAllSessions', unit: 'percent' },
    ],
    table: {
      title: 'AI assistants sending traffic',
      at: 'sources',
      limit: 25,
      columns: [
        { label: 'Source', at: 'source', unit: 'text' },
        { label: 'Sessions', at: 'sessions', unit: 'count' },
        { label: 'Engaged', at: 'engagedSessions', unit: 'count' },
        // "ga4" means the property has its own AI Assistant channel group;
        // "engine" means Engine recognised the referrer. A customer comparing
        // Engine's number to GA4's needs to know which.
        { label: 'Classified by', at: 'classifiedBy', unit: 'text' },
      ],
    },
  },

  /* ── Rank tracking ──────────────────────────────────────────────────────── */

  keyword_positions: {
    table: {
      title: 'Where the site ranks',
      at: 'positions',
      limit: 50,
      columns: [
        { label: 'Keyword', at: 'keyword', unit: 'text' },
        { label: 'Position', at: 'position', unit: 'position' },
        { label: 'Engine', at: 'engine', unit: 'text' },
        { label: 'Country', at: 'country', unit: 'text' },
        { label: 'Device', at: 'device', unit: 'text' },
      ],
    },
  },

  tracked_keywords: {
    metrics: [{ label: 'Keywords tracked', at: 'count', unit: 'count' }],
    table: {
      title: 'Tracked keywords',
      at: 'keywords',
      limit: 50,
      columns: [
        { label: 'Keyword', at: 'keyword', unit: 'text' },
        { label: 'Entity', at: 'entity', unit: 'text' },
        { label: 'Engine', at: 'engine', unit: 'text' },
        { label: 'Cadence', at: 'cadence', unit: 'text' },
        { label: 'Last polled', at: 'lastPolledAt', unit: 'date' },
      ],
    },
  },

  /* ── AI visibility ──────────────────────────────────────────────────────── */

  ai_citations: {
    metrics: [
      // The band, not the point. §4.6 rule 4, and the only sampled figure here.
      { label: 'Named in AI answers', at: 'citationRate.point', unit: 'percent', bandAt: 'citationRate' },
      { label: 'Answers sampled', at: 'samples', unit: 'count' },
    ],
    table: {
      title: 'By assistant',
      at: 'byEngine',
      columns: [
        { label: 'Engine', at: 'engine', unit: 'text' },
        { label: 'Cited', at: 'cited', unit: 'count' },
        { label: 'Sampled', at: 'samples', unit: 'count' },
        { label: 'Rate', at: 'citationRate.point', unit: 'percent' },
      ],
    },
  },

  cited_domains: {
    metrics: [{ label: 'Answers sampled', at: 'answersSampled', unit: 'count' }],
    table: {
      title: 'Domains assistants cite',
      at: 'domains',
      limit: 25,
      columns: [
        { label: 'Domain', at: 'domain', unit: 'text' },
        { label: 'Times cited', at: 'timesCited', unit: 'count' },
        { label: 'In answers', at: 'inAnswers', unit: 'count' },
      ],
    },
  },

  /* ── The site ───────────────────────────────────────────────────────────── */

  // The Findings component rather than a table: §4.5 is explicit that a finding
  // shown in Driver should be the row a customer clicks in Findings, with the
  // same actions on it. Two renderings of one object is how a product starts to
  // feel like two products.
  findings: { component: { kind: 'findings', at: 'findings' } },

  site_health: {
    metrics: [
      { label: 'Health score', at: 'healthScore', unit: 'score' },
      { label: 'Open findings', at: 'openFindings', unit: 'count' },
      { label: 'Pages audited', at: 'pagesAudited', unit: 'count' },
      { label: 'Last audited', at: 'lastAuditedAt', unit: 'date' },
    ],
  },

  crawl_coverage: {
    metrics: [
      { label: 'Pages audited', at: 'lastCrawl.pagesAudited', unit: 'count' },
      { label: 'Pages stored', at: 'pagesStored', unit: 'count' },
      { label: 'Findings found', at: 'lastCrawl.findingsFound', unit: 'count' },
      { label: 'Last crawl', at: 'lastCrawl.ranAt', unit: 'date' },
    ],
  },

  // The Fix Queue card, for the same reason as findings above.
  fix_queue: { component: { kind: 'fixes', at: 'fixes' } },

  fix_verification: {
    metrics: [
      { label: 'Fix status', at: 'fix.status', unit: 'text' },
      // "never-checked" and "not-found-on-page" are different answers and the
      // handler keeps them apart. Surfacing `outcome` rather than deriving it
      // from the rows keeps them apart here too.
      { label: 'Verification', at: 'outcome', unit: 'text' },
    ],
    table: {
      title: 'Verification attempts',
      at: 'checks',
      columns: [
        { label: 'Requested', at: 'requestedAt', unit: 'date' },
        { label: 'State', at: 'status', unit: 'text' },
        { label: 'Finished', at: 'finishedAt', unit: 'date' },
        { label: 'Error', at: 'error', unit: 'text' },
      ],
    },
  },

  /* ── Brand and competitors ──────────────────────────────────────────────── */

  entity_strength: {
    table: {
      title: 'Entity strength',
      at: 'entities',
      columns: [
        { label: 'Entity', at: 'entity', unit: 'text' },
        { label: 'Score', at: 'score', unit: 'score' },
        { label: 'Wikidata', at: 'components.wikidata', unit: 'score' },
        { label: 'Schema', at: 'components.schema', unit: 'score' },
        { label: 'sameAs', at: 'components.sameAs', unit: 'score' },
        { label: 'Corroboration', at: 'components.corroboration', unit: 'score' },
      ],
    },
  },

  competitor_gaps: {
    table: {
      title: 'Where competitors are ahead',
      at: 'gaps',
      limit: 25,
      columns: [
        { label: 'Gap', at: 'gapType', unit: 'text' },
        { label: 'Item', at: 'item', unit: 'text' },
        { label: 'Competitors holding it', at: 'heldByCount', unit: 'count' },
        { label: 'Impact', at: 'impact', unit: 'score' },
      ],
    },
  },

  local_visibility: {
    table: {
      title: 'Local listing strength',
      at: 'audits',
      columns: [
        { label: 'Entity', at: 'entity', unit: 'text' },
        { label: 'Score', at: 'score', unit: 'score' },
        { label: 'Business profile', at: 'components.googleBusinessProfile', unit: 'score' },
        { label: 'Name, address, phone', at: 'components.nameAddressPhone', unit: 'score' },
        { label: 'Reviews', at: 'components.reviews', unit: 'score' },
      ],
    },
  },

  /* ── Setup ──────────────────────────────────────────────────────────────── */

  integration_status: {
    table: {
      title: 'What is connected',
      at: 'providers',
      columns: [
        { label: 'Provider', at: 'name', unit: 'text' },
        { label: 'Account', at: 'connectedAccount', unit: 'text' },
        { label: 'Property', at: 'propertyAssigned', unit: 'text' },
        { label: 'Last synced', at: 'lastSyncedAt', unit: 'date' },
        // The one field that says what to do, so a half-connected provider
        // reads as a step rather than as four blank cells.
        { label: 'Next step', at: 'nextStep', unit: 'text' },
      ],
    },
  },
};

/**
 * Throws when the catalogue and the render specs are not the same set.
 *
 * Both directions, like `assertRegistryMatchesCatalogue`. A tool with no spec
 * renders as prose with no evidence under it — the answer looks thinner than
 * the work behind it, and nothing says why. A spec with no tool is a shape
 * nothing can ever produce.
 */
export function assertRenderCoversCatalogue(): void {
  const declared = new Set(READ_TOOLS.map((t) => t.name));
  const rendered = new Set(Object.keys(RENDER_SPECS));

  const missing = [...declared].filter((name) => !rendered.has(name));
  const orphaned = [...rendered].filter((name) => !declared.has(name));

  if (missing.length > 0 || orphaned.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`tools with no render shape: ${missing.join(', ')}`);
    if (orphaned.length > 0) parts.push(`render shapes with no tool: ${orphaned.join(', ')}`);
    throw new Error(`Driver render specs do not match the catalogue — ${parts.join('; ')}.`);
  }
}

assertRenderCoversCatalogue();

/* ── Reading a stored thread back ─────────────────────────────────────────── */

/** The fields of a stored message this needs. Structural, so the repository type fits. */
interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
}

/**
 * A stored thread, with each answer's parts rebuilt from what it was built on.
 *
 * The screen renders a thread it is opening for the first time the same way it
 * renders one it just produced, and both go through `buildParts`. So a change
 * to a render shape improves every answer ever given, not only the next one —
 * which is the payoff for deriving parts rather than storing them.
 *
 * The walk is a small state machine over `seq` order: tool results accumulate,
 * and the next assistant message that actually said something flushes them as
 * its evidence. That is exactly the turn structure the loop produces — an
 * assistant message requesting calls, the `tool` messages answering them, then
 * the assistant message that reads them out.
 *
 * An envelope that does not parse is skipped rather than failing the read. The
 * `state="error"` shape is the common case and is not a result; a thread from
 * an older encoding would be the other, and neither is a reason to refuse to
 * show a customer their conversation.
 */
export function messagesWithParts<T extends StoredMessage>(
  messages: readonly T[],
): (T & { parts?: ResponsePart[] })[] {
  let gathered: ResponsePart[] = [];

  return messages.map((message) => {
    if (message.role === 'tool' && message.content) {
      const parsed = parseToolResultEnvelope(message.content);
      const render = parsed ? RENDER_SPECS[parsed.name] : undefined;
      if (parsed && render) gathered.push(...buildParts(parsed.name, render, parsed.result));
      return message;
    }

    // An assistant turn that only asked for tools said nothing to attach
    // evidence to. Its results belong to the answer that follows.
    if (message.role !== 'assistant' || !message.content) return message;

    const parts = assembleAnswer(message.content, gathered);
    gathered = [];
    return { ...message, parts };
  });
}
