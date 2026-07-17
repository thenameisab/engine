/**
 * Representative sample data for the surfaces whose live source isn't wired
 * yet — Pulse's trend/wins/risks context needs the ClickHouse rollups (M1.2),
 * and readiness renders these before the first live call returns.
 *
 * The DB-backed views deliberately do **not** fall back here. The Fix Queue and
 * the Audit view read real Postgres and report an empty result or a failed call
 * as what it is: sample data that appears when the API is unreachable is a
 * fiction the user only discovers on reload.
 */
import type { PulseData, ReadinessReport } from './types.js';

export const MOCK_PULSE: PulseData = {
  score: { point: 64, low: 57, high: 72 },
  deltaVsPrior: 4.2,
  trend: [52, 53, 51, 55, 54, 58, 57, 60, 62, 61, 64],
  contributions: [
    { key: 'organic', label: 'Organic SoV', value: 61, sub: 'rank presence · 2,480 kw' },
    { key: 'ai', label: 'AI Share of Model', value: 48, low: 44, high: 52, sub: '5 engines · n=5 sampled' },
    { key: 'local', label: 'Local SoV', value: 78, sub: 'map pack · 12 locations' },
  ],
  wins: [
    { title: 'Cited by Perplexity for “best UPI payment gateway”', meta: 'new · 3 competitors displaced', move: 8 },
    { title: 'FAQ schema deployed on 214 product pages', meta: 'via Cloudflare Worker · verified', move: 5 },
    { title: 'Featured snippet recovered in Mumbai', meta: '“small business loan eligibility”', move: 3 },
  ],
  risks: [
    { title: 'GPTBot blocked in robots.txt', meta: 'ChatGPT can’t read 1,900 pages', move: -6 },
    { title: 'AI citations dropped in Germany', meta: 'Gemini · −31% over 14 days', move: -4 },
    { title: 'Content decay on 3 pillar pages', meta: 'traffic −18% since April', move: -2 },
  ],
};

/** Everything unconfigured — matches what /health/integrations returns with an empty env. */
export const MOCK_READINESS: ReadinessReport = {
  mvpReady: false,
  summary: { configured: 0, partial: 0, missing: 6, total: 6 },
  integrations: [
    { id: 'database', name: 'Postgres (Neon)', category: 'data', requiredForMvp: true, status: 'missing', missing: [{ name: 'DATABASE_URL', description: 'Neon Postgres connection string' }], optionalPresent: [] },
    { id: 'gsc-oauth', name: 'Google Search Console (OAuth)', category: 'identity', requiredForMvp: true, status: 'missing', missing: [{ name: 'GSC_CLIENT_ID', description: 'OAuth 2.0 client ID' }], optionalPresent: [] },
    { id: 'stripe', name: 'Stripe (billing)', category: 'billing', requiredForMvp: true, status: 'missing', missing: [{ name: 'STRIPE_WEBHOOK_SECRET', description: 'Webhook signing secret' }], optionalPresent: [] },
    { id: 'serp', name: 'Serper.dev (SERP data)', category: 'serp', requiredForMvp: true, status: 'missing', missing: [{ name: 'SERPER_API_KEY', description: 'Serper.dev API key' }], optionalPresent: [] },
    { id: 'llm-openai', name: 'OpenAI (LLM engine)', category: 'llm', requiredForMvp: true, status: 'missing', missing: [{ name: 'OPENAI_API_KEY', description: 'OpenAI API key' }], optionalPresent: [] },
    { id: 'llm-gemini', name: 'Google Gemini (LLM engine)', category: 'llm', requiredForMvp: false, status: 'missing', missing: [{ name: 'GEMINI_API_KEY', description: 'Gemini API key' }], optionalPresent: [] },
  ],
};
