/**
 * Representative sample data for surfaces whose live source isn't wired yet.
 *
 * The DB-backed views deliberately do **not** fall back here. The Fix Queue,
 * Audit, and Pulse views all read real Postgres and report an empty result or
 * a failed call as what it is: sample data that appears when the API is
 * unreachable is a fiction the user only discovers on reload.
 */
import type { ReadinessReport } from './types.js';

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
