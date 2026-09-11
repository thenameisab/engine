/**
 * The read-tool catalogue — §4.2 of the Driver scoping document.
 *
 * Each entry is a named, project-scoped query with a documented meaning. The
 * model chooses which one answers the question in front of it; it never writes
 * SQL, never names a table, and never supplies scope.
 *
 * **The description is the interface.** It is the only text the model reads when
 * it decides between nineteen tools, so each one states the question the tool
 * answers, the vocabulary it returns, and — where the distinction has burned
 * this product before — what the tool is *not*. `search_performance` saying it
 * reads property totals rather than a sum over queries is not trivia: migration
 * 0023 exists because those two numbers differ and a customer who compares them
 * stops trusting both.
 *
 * **Periods are day counts, not date ranges.** A model asked for `{from, to}`
 * will produce plausible dates that are off by a month, silently. A `days`
 * integer cannot be wrong in that way, and the handler resolves it against the
 * latest day the sync actually stored rather than against today — a period
 * ending today over a source that last synced on Sunday reports a collapse that
 * did not happen.
 *
 * **Nineteen, not twenty.** §4.2 lists `page_content(url)` as the twentieth.
 * §9a decision 7 ships it at step 9, after the injection controls, gated by the
 * poisoned-crawled-page test — `crawled_pages.body_text` is the product's main
 * untrusted-content surface and the one tool that hands it to the model. It is
 * deliberately absent here rather than present and disabled: a definition the
 * loop can see is a definition someone can switch on.
 */
import { assertNoScopeParameters, type ToolDefinition } from './types.js';
import { assertSchemaIsSupported } from './validate.js';

/** A period expressed as a day count back from the latest stored day. */
function days(description: string, fallback = 28): Record<string, unknown> {
  return {
    type: 'integer',
    minimum: 1,
    maximum: 365,
    default: fallback,
    description,
  };
}

/** How many rows to return. Bounded so one call cannot fill the model's context. */
function limit(fallback: number, max: number): Record<string, unknown> {
  return {
    type: 'integer',
    minimum: 1,
    maximum: max,
    default: fallback,
    description: `How many rows to return. At most ${max}.`,
  };
}

/** A JSON Schema object with no required properties. */
function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

/**
 * The catalogue, in the order §4.2 lists it — grouped by the question a
 * customer asks rather than by the table underneath, because that grouping is
 * what the model is matching against.
 */
const CATALOGUE: readonly ToolDefinition[] = [
  {
    name: 'search_performance',
    description:
      'Google Search Console performance for the whole site: clicks, impressions, click-through ' +
      'rate and average position over a period, optionally compared with the period before it. ' +
      'These are the property-level totals Search Console itself reports, not a sum over ' +
      'individual queries — Google omits anonymised queries from the query dimension, so a sum ' +
      'over top_queries is always lower than this and the two are not meant to match. Use this ' +
      'for "how is search doing"; use top_queries or top_pages to break it down.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
      compare: {
        type: 'boolean',
        default: true,
        description:
          'Include the preceding period of the same length for comparison. The comparison is ' +
          'omitted from the result when the preceding period is not fully covered by synced data.',
      },
    }),
    tier: 0,
    access: 'read',
    tables: ['gsc_site_daily'],
  },
  {
    name: 'top_queries',
    description:
      'The search queries bringing people to the site, ranked by clicks, with impressions, ' +
      'click-through rate and average position for each. Can be filtered to brand queries (ones ' +
      'containing the site\'s own name or domain) or to non-brand queries, which is the split ' +
      'that says whether search is finding new people or serving people who already knew the ' +
      'brand. Does not include anonymised queries, which Google withholds.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
      limit: limit(10, 100),
      brand: {
        type: 'string',
        enum: ['only', 'exclude', 'all'],
        default: 'all',
        description:
          'Restrict to brand queries, exclude them, or return both. Brand is decided by matching ' +
          'the query against the site domain and the tracked entity names.',
      },
    }),
    tier: 0,
    access: 'read',
    tables: ['gsc_query_daily'],
  },
  {
    name: 'top_pages',
    description:
      'The pages earning search traffic, ranked by clicks, with impressions, click-through rate ' +
      'and average position for each. Answers "which pages are working"; pair with findings to ' +
      'ask why a page that should rank does not.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
      limit: limit(10, 100),
    }),
    tier: 0,
    access: 'read',
    tables: ['gsc_page_daily'],
  },
  {
    name: 'queries_within_reach',
    description:
      'Queries the site already ranks for but not highly enough to earn clicks — average ' +
      'position between 4 and 20 with at least 10 impressions in the period. These are the ' +
      'cheapest wins available, because the page already ranks and needs improving rather than ' +
      'creating. Ranked by impressions, since impressions are the traffic on offer.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
      limit: limit(10, 50),
    }),
    tier: 0,
    access: 'read',
    tables: ['gsc_query_daily'],
  },
  {
    name: 'traffic_by_channel',
    description:
      'Google Analytics sessions, engaged sessions, conversions and revenue broken down by ' +
      'GA4 channel group for a period. Use for "where does traffic come from". For the AI ' +
      'assistant share specifically, use ai_referral_traffic, which does not simply read a ' +
      'channel — see that tool\'s description for why.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
    }),
    tier: 0,
    access: 'read',
    tables: ['ga4_channel_daily'],
  },
  {
    name: 'ai_referral_traffic',
    description:
      'Visits arriving from AI assistants — ChatGPT, Perplexity, Claude, Gemini, Copilot and ' +
      'others — with the referring source named for each. GA4 does not report AI assistants as ' +
      'a channel of its own by default: that traffic lands in Referral or Organic Social ' +
      'depending on the referrer, so this figure is derived from the traffic source, not read ' +
      'from a channel Google reports. A property configured with its own "AI Assistant" channel ' +
      'group is read directly and labelled as such. Say which of the two produced the number.',
    parameters: schema({
      days: days('How many days back from the most recent synced day. 28 by default.'),
    }),
    tier: 0,
    access: 'read',
    tables: ['ga4_channel_daily'],
  },
  {
    name: 'keyword_positions',
    description:
      'Where the site ranks in search results for tracked keywords, from the most recent poll of ' +
      'each, with the ranking URL and any search features present. A keyword with no position ' +
      'means it was polled and the site was not found in the results, which is different from a ' +
      'keyword that has never been polled — the result says which. Use tracked_keywords to see ' +
      'what is being tracked and how often.',
    parameters: schema({
      keyword: {
        type: 'string',
        description:
          'One keyword to look up. Omit to return the most recent position for every tracked ' +
          'keyword.',
      },
      days: days('Only consider polls from the last N days. 90 by default.', 90),
      limit: limit(25, 200),
    }),
    tier: 0,
    access: 'read',
    tables: ['serp_positions', 'keyword_configs', 'entities'],
  },
  {
    name: 'tracked_keywords',
    description:
      'Which keywords the project polls, with the country, device, language, search engine and ' +
      'polling cadence for each, and when each was last polled. This is the configuration, not ' +
      'the results — use keyword_positions for where the site ranks. Answers "what are we even ' +
      'watching", which is usually the right first question when a customer expects a keyword to ' +
      'appear and it does not.',
    parameters: schema({
      limit: limit(50, 200),
    }),
    tier: 0,
    access: 'read',
    tables: ['keyword_configs', 'entities', 'serp_positions'],
  },
  {
    name: 'ai_citations',
    description:
      'Whether AI assistants name this brand when asked the prompts the project tracks. Returns ' +
      'a citation rate as a confidence band (low, point, high) over the number of samples taken, ' +
      'never as a single percentage — the figure rests on a handful of samples per engine and a ' +
      'point estimate would claim precision the sampling does not support. Quote the band, and ' +
      'quote the sample count with it. Also returns the per-engine breakdown and, where answers ' +
      'were stored, which other brands were named alongside.',
    parameters: schema({
      entity: {
        type: 'string',
        description:
          'The name of the tracked entity to report on. Omit for the project\'s primary entity.',
      },
      days: days('How many days back to include samples from. 90 by default.', 90),
    }),
    tier: 0,
    access: 'read',
    tables: ['citation_events', 'answer_mentions', 'entities'],
  },
  {
    name: 'cited_domains',
    description:
      'Which domains AI assistants cite as sources when answering the project\'s tracked ' +
      'prompts, ranked by how often they appear. These are the places an assistant goes to ' +
      'decide what to say about this market, so a domain appearing often and not mentioning the ' +
      'brand is a specific, actionable gap. Counts sources across sampled answers, so the ' +
      'numbers are sample counts, not traffic.',
    parameters: schema({
      days: days('How many days back to include samples from. 90 by default.', 90),
      limit: limit(20, 100),
    }),
    tier: 0,
    access: 'read',
    tables: ['citation_events', 'entities'],
  },
  {
    name: 'findings',
    description:
      'Open problems found on the site, each with a severity, a predicted impact, the issue type ' +
      'and the evidence that produced it. Findings come from four sources: technical (the crawl), ' +
      'content, entity (the knowledge-graph audit) and local (the listing audit). Resolved ' +
      'findings are excluded by default. This is the queue of what is wrong; fix_queue is what is ' +
      'being done about it.',
    parameters: schema({
      source: {
        type: 'string',
        enum: ['technical', 'content', 'entity', 'local'],
        description: 'Restrict to findings from one audit source.',
      },
      issueType: {
        type: 'string',
        description:
          'Restrict to one issue type, for example missing_schema or thin_content. Use without ' +
          'this filter first to see which types exist for this project.',
      },
      minSeverity: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: 'Only findings at or above this severity.',
      },
      includeResolved: {
        type: 'boolean',
        default: false,
        description: 'Include findings already marked resolved.',
      },
      limit: limit(25, 100),
    }),
    tier: 0,
    access: 'read',
    tables: ['findings', 'entities'],
  },
  {
    name: 'crawl_coverage',
    description:
      'What the last crawl actually reached: pages audited, whether a robots.txt was found, how ' +
      'many URLs the sitemap offered, how many links were discovered, how many were blocked by ' +
      'robots, and whether the crawl stopped because it hit its page limit. A crawl that stopped ' +
      'at its limit has not seen the whole site, so every count derived from it is a floor rather ' +
      'than a total, and any answer using those counts should say so.',
    parameters: schema({}),
    tier: 0,
    access: 'read',
    tables: ['audit_runs', 'crawled_pages'],
  },
  {
    name: 'fix_queue',
    description:
      'Fixes in flight, with their state in the execution contract: proposed, approved, deployed, ' +
      'verified or rolled back. Each carries the finding it answers and the change it makes. ' +
      'Proposed means drafted and waiting for a person; deployed means written to the live site; ' +
      'verified means the deployed page was fetched again and carried the change.',
    parameters: schema({
      status: {
        type: 'string',
        enum: ['proposed', 'approved', 'deployed', 'verified', 'rolled_back'],
        description: 'Restrict to one state. Omit for every fix in the queue.',
      },
      limit: limit(25, 100),
    }),
    tier: 0,
    access: 'read',
    tables: ['actions', 'findings', 'entities'],
  },
  {
    name: 'fix_verification',
    description:
      'Whether a specific deployed fix was confirmed on the live page, and when it was checked. ' +
      'Three outcomes, and they are different answers: verified true means the page was fetched ' +
      'and carried the change, verified false means it was fetched and did not, and no completed ' +
      'check means nobody has looked yet. Never report the third as the second.',
    parameters: schema(
      {
        actionId: {
          type: 'string',
          description: 'The id of the fix, as returned by fix_queue.',
        },
      },
      ['actionId'],
    ),
    tier: 0,
    access: 'read',
    tables: ['actions', 'audit_requests', 'findings', 'entities'],
  },
  {
    name: 'entity_strength',
    description:
      'How well established the brand is as an entity that machines can recognise, scored out of ' +
      '100 with the four components that make it up: Wikidata presence, schema markup, sameAs ' +
      'links, and corroboration across independent domains. This is the measure of whether an AI ' +
      'assistant can tell who this company is, which is upstream of whether it will name them.',
    parameters: schema({
      entity: {
        type: 'string',
        description: 'The tracked entity to report on. Omit for every entity in the project.',
      },
    }),
    tier: 0,
    access: 'read',
    tables: ['entity_graph_audits', 'entities'],
  },
  {
    name: 'competitor_gaps',
    description:
      'Things competitors have that this brand does not, each with the kind of gap, how many ' +
      'competitors hold it, which ones, and a predicted impact. Answers "what are they doing that ' +
      'we are not" against the competitor set configured for the project — so an empty result may ' +
      'mean no gaps or may mean no competitors are configured, and the result says which.',
    parameters: schema({
      competitor: {
        type: 'string',
        description: 'Only gaps held by this competitor, by name. Omit for all gaps.',
      },
      gapType: {
        type: 'string',
        description: 'Restrict to one kind of gap. Call without it first to see which kinds exist.',
      },
      limit: limit(25, 100),
    }),
    tier: 0,
    access: 'read',
    tables: ['competitor_gaps', 'competitor_sets', 'entities'],
  },
  {
    name: 'local_visibility',
    description:
      'How the business looks in local search: an overall score out of 100 with its Google ' +
      'Business Profile, name-address-phone consistency and review components, plus the stored ' +
      'profile. The review component can be absent when there are no reviews to score, which is ' +
      'different from a review score of zero.',
    parameters: schema({
      entity: {
        type: 'string',
        description: 'The tracked entity to report on. Omit for every entity with a local audit.',
      },
    }),
    tier: 0,
    access: 'read',
    tables: ['local_audits', 'local_profiles', 'entities'],
  },
  {
    name: 'integration_status',
    description:
      'Which data sources are connected for this account and what each is attached to: Search ' +
      'Console, Analytics and Business Profile, with the property assigned to this project, when ' +
      'it last synced, how many rows it returned, and any sync error. Call this before telling a ' +
      'customer there is no data — an empty search or traffic answer nearly always means not ' +
      'connected or never synced rather than a site with no traffic, and those need different ' +
      'things said about them.',
    parameters: schema({}),
    tier: 0,
    access: 'read',
    tables: ['integration_connections', 'integration_assignments'],
  },
  {
    name: 'site_health',
    description:
      'The overall health score from the most recent audit, with how many pages it covered, how ' +
      'many findings are open, and how those findings break down by severity and by source. The ' +
      'one-call summary of "how is the site doing" on the technical side; use findings to see the ' +
      'individual problems and crawl_coverage to see whether the crawl saw the whole site.',
    parameters: schema({}),
    tier: 0,
    access: 'read',
    tables: ['audit_runs', 'findings', 'entities'],
  },
];

/**
 * Both invariants run at module load, in production, not only under test.
 *
 * A tool that lets the model choose its scope, or that declares a constraint
 * nothing enforces, should fail the deployment that introduced it rather than
 * wait for someone to notice.
 */
for (const tool of CATALOGUE) {
  assertNoScopeParameters(tool);
  assertSchemaIsSupported(tool);
}

/** Every read tool, in catalogue order. */
export const READ_TOOLS: readonly ToolDefinition[] = CATALOGUE;

/** Lookup by name, for the loop's dispatch and for argument validation. */
export const READ_TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(
  CATALOGUE.map((tool) => [tool.name, tool]),
);

/**
 * The tool named in §4.2 that this catalogue deliberately does not carry.
 *
 * Exported so the step 9 build has one place to look rather than a comment to
 * find, and so a test can assert it is still absent.
 */
export const DEFERRED_TOOLS: readonly string[] = ['page_content'];
