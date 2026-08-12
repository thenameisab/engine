/**
 * Demo API for portfolio screenshots.
 *
 * The dashboard's DB-backed views deliberately refuse to invent data: with no
 * API reachable they render honest empty states, which is correct product
 * behaviour and useless as a portfolio screenshot. This server speaks the same
 * JSON shapes as `apps/api` over a fixed, obviously-fictional dataset
 * (Northwind Coffee Roasters), so the captures show the real UI doing real
 * work without pointing anything at a customer database.
 *
 * It is a capture harness only — never deployed, never imported by the app.
 *
 *   node tools/screenshots/demo-api.mjs [port]
 */
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8788);

/* ——— Fixture data ———————————————————————————————————————————— */

const ENTITIES = [
  { id: 'ent_northwind', canonicalName: 'Northwind Coffee Roasters' },
  { id: 'ent_northwind_subs', canonicalName: 'Northwind Subscription Box' },
  { id: 'ent_beanline', canonicalName: 'Beanline Coffee' },
  { id: 'ent_harborroast', canonicalName: 'Harbor Roast Co.' },
  { id: 'ent_dailygrind', canonicalName: 'The Daily Grind' },
];

const PULSE = {
  score: {
    band: { low: 58, point: 67, high: 74 },
    decomposition: {
      // Local stays 0/0: B5 isn't wired into the unified score yet, and the
      // view says so in its own copy — a fixture that invented a local score
      // would contradict the UI standing next to it.
      organic: { score: 71, weight: 0.65 },
      ai: { score: 54, weight: 0.35 },
      local: { score: 0, weight: 0 },
    },
  },
  aiBand: { low: 41, point: 54, high: 66 },
  keywordsTracked: 248,
  citationSamples: 1120,
};

/**
 * Severity is the 0–1 intrinsic weight the diagnosis layer assigns per issue
 * type (>= .8 high, >= .55 medium), and issue types are the ones the audit
 * actually emits — anything else renders as a raw slug with no label.
 */
const FINDINGS = [
  ['fnd_01', 'ai-crawler-blocked', 0.95, 0.82, '/robots.txt', 'robots.patch', 'Allow GPTBot and PerplexityBot'],
  ['fnd_02', 'schema-missing', 0.88, 0.74, '/shop/single-origin-ethiopia', 'schema.emit', 'Emit Product + Offer schema'],
  ['fnd_03', 'noindex-unexpected', 0.84, 0.61, '/shop/decaf-colombia', 'meta.write', 'Remove the stray noindex'],
  ['fnd_04', 'schema-invalid', 0.81, 0.58, '/about', 'schema.emit', 'Fix Organization sameAs links'],
  ['fnd_05', 'canonical-conflict', 0.72, 0.49, '/guides/how-to-store-coffee-beans', 'meta.write', 'Point the canonical at the indexable URL'],
  ['fnd_06', 'redirect-chain', 0.68, 0.44, '/blog/pour-over-guide', 'redirect.flatten', 'Flatten a 3-hop redirect chain'],
  ['fnd_07', 'meta-description-missing', 0.62, 0.39, '/shop/gift-sets', 'meta.write', 'Write a meta description'],
  ['fnd_08', 'meta-title-missing', 0.58, 0.31, '/shop/page/2', 'meta.write', 'Add a unique title'],
  ['fnd_09', 'cwv-poor', 0.52, 0.28, '/', null, null],
  ['fnd_10', 'hreflang-missing', 0.47, 0.24, '/shop', 'hreflang.add', 'Add en-GB / en-US alternates'],
  ['fnd_11', 'not-in-sitemap', 0.4, 0.17, '/guides/espresso-ratios', 'internal-link.add', 'Add internal links from 4 hub pages'],
  ['fnd_12', 'not-in-sitemap', 0.35, 0.11, '/faq', 'schema.emit', 'Emit FAQPage schema and list it'],
].map(([id, issueType, severity, predictedImpact, url, actionType, label]) => ({
  id,
  entityId: 'ent_northwind',
  source: 'crawler',
  issueType,
  severity,
  predictedImpact,
  evidence: actionType
    ? { url }
    : { url, nonExecutableReason: 'Needs an origin change outside the connected deploy target' },
  actionTemplates: actionType ? [{ type: actionType, label, description: label }] : [],
  createdAt: '2026-08-11T09:14:00.000Z',
}));

const ACTIONS = [
  ['act_01', 'fnd_01', 'schema.emit', 'verified', 0.82, 'Product + Offer schema on Ethiopia Yirgacheffe'],
  ['act_02', 'fnd_07', 'robots.patch', 'verified', 0.36, 'Allow GPTBot + PerplexityBot in robots.txt'],
  ['act_03', 'fnd_02', 'content.rewrite', 'deployed', 0.74, 'Direct-answer block on the bean storage guide'],
  ['act_04', 'fnd_05', 'redirect.flatten', 'deployed', 0.44, 'Flatten /blog/pour-over-guide redirect chain'],
  ['act_05', 'fnd_04', 'schema.emit', 'approved', 0.58, 'Organization sameAs on /about'],
  ['act_06', 'fnd_06', 'internal-link.add', 'approved', 0.39, 'Internal links into /guides/espresso-ratios'],
  ['act_07', 'fnd_03', 'meta.write', 'proposed', 0.61, 'Meta description for Decaf Colombia'],
  ['act_08', 'fnd_08', 'hreflang.add', 'proposed', 0.28, 'en-GB / en-US alternates across /shop'],
  ['act_09', 'fnd_09', 'meta.write', 'proposed', 0.24, 'Unique titles for paginated shop pages'],
  ['act_10', 'fnd_11', 'schema.emit', 'proposed', 0.17, 'FAQPage schema on /faq'],
].map(([id, findingId, type, status, predictedImpact, after]) => ({
  id,
  findingId,
  type,
  target: { kind: 'github-pr', repo: 'northwind/storefront' },
  diff: { before: '', after, format: 'text', field: 'body' },
  status,
  predictedImpact,
}));

const STRENGTHS = [
  ['ent_dailygrind', 0.31, [0.0, 0.25, 0.4, 0.4], 3],
  ['ent_northwind_subs', 0.48, [0.0, 0.7, 0.55, 0.66], 7],
  ['ent_harborroast', 0.62, [1.0, 0.5, 0.5, 0.48], 11],
  ['ent_beanline', 0.74, [1.0, 0.8, 0.6, 0.56], 14],
  ['ent_northwind', 0.81, [1.0, 0.9, 0.75, 0.6], 19],
].map(([entityId, score, [wikidata, schema, sameAsConsistency, corroboration], corroboratingDomains]) => ({
  entityId,
  canonicalName: ENTITIES.find((e) => e.id === entityId).canonicalName,
  score,
  components: { wikidata, schema, sameAsConsistency, corroboration },
  corroboratingDomains,
  updatedAt: '2026-08-11T09:20:00.000Z',
}));

const GAPS = [
  ['citation-gap', 'best coffee subscription for espresso', 3, ['Beanline Coffee', 'Harbor Roast Co.', 'The Daily Grind'], 0.91],
  ['keyword-gap', 'single origin ethiopian coffee', 2, ['Beanline Coffee', 'Harbor Roast Co.'], 0.78],
  ['citation-gap', 'how to choose a coffee roaster', 2, ['Beanline Coffee', 'The Daily Grind'], 0.72],
  ['backlink-gap', 'seriouseats.com', 2, ['Beanline Coffee', 'Harbor Roast Co.'], 0.68],
  ['content-gap', 'Roast level comparison guide', 2, ['Beanline Coffee', 'The Daily Grind'], 0.61],
  ['keyword-gap', 'decaf coffee subscription', 1, ['Harbor Roast Co.'], 0.54],
  ['entity-gap', 'Beanline Coffee', 1, ['Beanline Coffee'], 0.44],
  ['backlink-gap', 'sprudge.com', 1, ['Beanline Coffee'], 0.37],
  ['content-gap', 'Green bean sourcing transparency', 1, ['Harbor Roast Co.'], 0.29],
  ['keyword-gap', 'coffee gift set uk', 1, ['The Daily Grind'], 0.22],
].map(([type, item, heldByCount, heldBy, impact]) => ({
  type,
  item,
  heldByCount,
  heldBy,
  impact,
  evidence: { observedIn: 'ai-citation-archive' },
  updatedAt: '2026-08-11T09:22:00.000Z',
}));

const OPPORTUNITIES = [
  ['seriouseats.com', 0.94, 412, 18, 0.88],
  ['sprudge.com', 0.81, 268, 14, 0.74],
  ['reddit.com/r/coffee', 0.77, 631, 26, 0.71],
  ['perfectdailygrind.com', 0.73, 197, 12, 0.63],
  ['nytimes.com/wirecutter', 0.96, 88, 9, 0.58],
  ['coffeegeek.com', 0.58, 143, 11, 0.41],
  ['epicurious.com', 0.69, 74, 7, 0.34],
].map(([domain, authority, citationCount, distinctEntities, impact]) => ({
  domain,
  authority,
  citationCount,
  distinctEntities,
  impact,
  updatedAt: '2026-08-11T09:24:00.000Z',
}));

const LOCAL = [
  ['ent_northwind_subs', 0.41, [0.35, 0.4, 0.5], 24],
  ['ent_northwind', 0.78, [0.85, 0.7, 0.8], 186],
].map(([entityId, score, [gbpCompleteness, napConsistency, reviewHealth], reviewsConsidered]) => ({
  entityId,
  canonicalName: ENTITIES.find((e) => e.id === entityId).canonicalName,
  score,
  components: { gbpCompleteness, napConsistency, reviewHealth },
  reviewsConsidered,
  updatedAt: '2026-08-11T09:26:00.000Z',
}));

const ACCOUNTS = [
  {
    id: 'acc_northwind',
    name: 'Northwind Coffee Roasters',
    branding: { companyName: 'Northwind Coffee Roasters', primaryColor: '#7c5cff' },
    createdAt: '2026-02-03T10:00:00.000Z',
    projects: [
      { id: 'demo', accountId: 'acc_northwind', name: 'northwindroasters.com', domain: 'northwindroasters.com', createdAt: '2026-02-03T10:02:00.000Z' },
      { id: 'proj_nw_uk', accountId: 'acc_northwind', name: 'northwindroasters.co.uk', domain: 'northwindroasters.co.uk', createdAt: '2026-04-18T10:02:00.000Z' },
    ],
  },
  {
    id: 'acc_tidepool',
    name: 'Tidepool Outfitters',
    branding: { companyName: 'Tidepool Outfitters', primaryColor: '#1fb6a6' },
    createdAt: '2026-03-21T10:00:00.000Z',
    projects: [
      { id: 'proj_tidepool', accountId: 'acc_tidepool', name: 'tidepooloutfitters.com', domain: 'tidepooloutfitters.com', createdAt: '2026-03-21T10:04:00.000Z' },
    ],
  },
  {
    id: 'acc_lumen',
    name: 'Lumen Dental Group',
    branding: { companyName: 'Lumen Dental Group', primaryColor: '#3b82f6' },
    createdAt: '2026-05-09T10:00:00.000Z',
    projects: [
      { id: 'proj_lumen', accountId: 'acc_lumen', name: 'lumendental.com', domain: 'lumendental.com', createdAt: '2026-05-09T10:06:00.000Z' },
      { id: 'proj_lumen_b', accountId: 'acc_lumen', name: 'lumendental.com/blog', domain: 'lumendental.com', createdAt: '2026-06-01T10:06:00.000Z' },
    ],
  },
];

const READINESS = (() => {
  const rows = [
    ['database', 'Postgres (Neon)', 'data', true, 'configured'],
    ['gsc-oauth', 'Google Search Console (OAuth)', 'identity', true, 'configured'],
    ['stripe', 'Stripe (billing)', 'billing', true, 'configured'],
    ['serp', 'Serper.dev (SERP data)', 'serp', true, 'configured'],
    ['llm-openai', 'OpenAI (LLM engine)', 'llm', true, 'configured'],
    ['llm-gemini', 'Google Gemini (LLM engine)', 'llm', false, 'partial'],
  ].map(([id, name, category, requiredForMvp, status]) => ({
    id,
    name,
    category,
    requiredForMvp,
    status,
    missing: status === 'partial' ? [{ name: 'GEMINI_PROJECT_ID', description: 'Vertex project id (optional)' }] : [],
    optionalPresent: [],
  }));
  return {
    integrations: rows,
    mvpReady: true,
    summary: { configured: 5, partial: 1, missing: 0, total: 6 },
  };
})();

const SERP = {
  vendor: 'serper',
  results: [
    {
      query: { keyword: 'best single origin coffee subscription', geo: { country: 'us' } },
      features: ['ai_overview', 'shopping', 'people_also_ask', 'reviews'],
      polledAt: '2026-08-12T08:41:00.000Z',
      organic: [
        { position: 1, url: 'https://beanlinecoffee.com/subscriptions', title: 'Single Origin Coffee Subscription — Beanline Coffee' },
        { position: 2, url: 'https://www.seriouseats.com/best-coffee-subscriptions', title: 'The 8 Best Coffee Subscriptions of 2026' },
        { position: 3, url: 'https://harborroast.co/shop/subscribe', title: 'Subscribe & Save — Harbor Roast Co.' },
        { position: 4, url: 'https://northwindroasters.com/subscribe', title: 'Single Origin Subscription — Northwind Coffee Roasters' },
        { position: 5, url: 'https://www.nytimes.com/wirecutter/reviews/best-coffee-subscription/', title: 'The Best Coffee Subscription | Wirecutter' },
        { position: 6, url: 'https://thedailygrind.com/plans', title: 'Coffee Plans — The Daily Grind' },
        { position: 7, url: 'https://perfectdailygrind.com/subscription-guide', title: 'How to pick a coffee subscription' },
        { position: 8, url: 'https://www.reddit.com/r/coffee/comments/best_subs', title: 'Best single origin subscription? : r/coffee' },
      ],
    },
  ],
};

const COPILOT_SUMMARY = {
  entityId: 'ent_northwind',
  canonicalName: 'Northwind Coffee Roasters',
  organic: { sov: 0.21, keywordsTracked: 248 },
  ai: { band: { low: 41, point: 54, high: 66 }, samplesObserved: 1120 },
  topFindings: FINDINGS.slice(0, 3).map((f) => ({
    id: f.id,
    issueType: f.issueType,
    predictedImpact: f.predictedImpact,
    evidence: { url: f.evidence.url },
  })),
};

const COPILOT_ANSWER = {
  intent: 'organic_vs_ai',
  entityId: 'ent_northwind',
  answer:
    'Northwind Coffee Roasters holds 21% organic share of voice across 248 tracked keywords, but only 41–66% AI Share of Model across 1,120 sampled prompts — the AI surface is the weaker channel and carries the wider band. The largest single driver is that /shop/single-origin-ethiopia emits no Product schema, so answer engines cite Beanline instead on three of the five highest-volume purchase prompts.',
  citations: [
    { source: 'serp_positions', label: '248 keywords, 30-day window', ref: 'A1' },
    { source: 'citation_events', label: '1,120 prompt samples across 4 engines', ref: 'A2' },
    { source: 'findings', label: 'missing-product-schema on /shop/single-origin-ethiopia', ref: 'fnd_01' },
  ],
  drilldown: [
    { kind: 'entity', id: 'ent_northwind' },
    { kind: 'finding', id: 'fnd_01' },
  ],
  suggestedAction: {
    findingId: 'fnd_01',
    issueType: 'missing-product-schema',
    actionType: 'schema.emit',
    proposeHref: '/projects/demo/findings/fnd_01/propose',
    label: 'Emit Product + Offer schema',
  },
};

/* ——— Routing ————————————————————————————————————————————————— */

const routes = [
  [/^\/health\/integrations$/, () => READINESS],
  [/^\/projects\/[^/]+\/pulse$/, () => PULSE],
  [/^\/projects\/[^/]+\/actions$/, () => ({ actions: ACTIONS })],
  [/^\/projects\/[^/]+\/actions\/[^/]+\/\w+$/, () => ({ ok: true })],
  [
    /^\/projects\/[^/]+\/audit$/,
    () => ({ findings: FINDINGS, healthScore: 74, lastRunAt: '2026-08-11T09:14:00.000Z', pagesAudited: 1284 }),
  ],
  [/^\/projects\/[^/]+\/rank\/poll$/, () => SERP],
  [/^\/projects\/[^/]+\/entities$/, () => ({ entities: ENTITIES })],
  [/^\/projects\/[^/]+\/entities\/[^/]+\/copilot\/summary$/, () => ({ summary: COPILOT_SUMMARY })],
  [/^\/projects\/[^/]+\/copilot\/ask$/, () => ({ answer: COPILOT_ANSWER, latencyMs: 412 })],
  [
    /^\/projects\/[^/]+\/entity-audit$/,
    () => ({ strengths: STRENGTHS, entitiesAudited: STRENGTHS.length, findingsCount: 9 }),
  ],
  [
    /^\/projects\/[^/]+\/entities\/[^/]+\/competitors$/,
    () => ({
      competitors: [
        { competitorSetId: 'cs_1', entityId: 'ent_beanline', canonicalName: 'Beanline Coffee' },
        { competitorSetId: 'cs_2', entityId: 'ent_harborroast', canonicalName: 'Harbor Roast Co.' },
        { competitorSetId: 'cs_3', entityId: 'ent_dailygrind', canonicalName: 'The Daily Grind' },
      ],
    }),
  ],
  [
    /^\/projects\/[^/]+\/entities\/[^/]+\/competitor-audit$/,
    () => {
      const byType = {};
      for (const g of GAPS) (byType[g.type] ??= []).push(g);
      return { selfEntityId: 'ent_northwind', competitorsAudited: 3, findingsCount: 10, gaps: GAPS, byType };
    },
  ],
  [
    /^\/projects\/[^/]+\/entities\/[^/]+\/offsite-audit$/,
    () => ({
      selfEntityId: 'ent_northwind',
      observationsAnalyzed: 1120,
      categorySize: 26,
      findingsCount: 7,
      opportunities: OPPORTUNITIES,
    }),
  ],
  [/^\/projects\/[^/]+\/local-audit$/, () => ({ visibility: LOCAL })],
  [/^\/projects\/[^/]+\/entities\/[^/]+\/local-audit$/, () => ({ entityId: 'ent_northwind', findingsCount: 4, visibility: LOCAL[1] })],
  [
    /^\/projects\/[^/]+\/entities\/[^/]+\/local-profile$/,
    () => ({
      profile: {
        name: 'Northwind Coffee Roasters',
        address: '412 Harborview Ave, Seattle, WA 98101',
        phone: '+1 206 555 0148',
        categories: ['Coffee roaster', 'Coffee shop'],
        hours: 'Mon–Fri 7:00–18:00, Sat–Sun 8:00–16:00',
      },
    }),
  ],
  [
    /^\/projects\/[^/]+\/deploy-target$/,
    () => ({ target: { kind: 'github-pr', repo: 'northwind/storefront', branch: 'main', path: 'src/pages' } }),
  ],
  [/^\/projects\/[^/]+\/findings\/[^/]+\/propose$/, () => ({ actions: [ACTIONS[6]] })],
  [/^\/accounts$/, () => ({ accounts: ACCOUNTS })],
  [/^\/accounts\/[^/]+\/projects$/, () => ({ project: ACCOUNTS[0].projects[0] })],
  [/^\/accounts\/[^/]+\/branding$/, () => ({ account: ACCOUNTS[0] })],
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
};

createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();

  const hit = routes.find(([re]) => re.test(path));
  if (!hit) {
    res.writeHead(404, { ...CORS, 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: `no demo fixture for ${path}` }));
  }
  res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
  res.end(JSON.stringify(hit[1]()));
}).listen(PORT, () => console.log(`demo-api listening on http://127.0.0.1:${PORT}`));
