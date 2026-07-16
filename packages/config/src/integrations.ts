/**
 * The single source of truth for every external integration Engine depends on.
 *
 * Each integration needs a real third-party account/credential that can't be
 * provisioned in code (an OAuth client, a Stripe account, a SERP or LLM API
 * key). This registry drives three things off one definition: the runtime
 * readiness check (`GET /health/integrations`), the `.dev.vars.example`
 * template, and the human docs (`docs/40-Integrations.md`) — so they can never
 * drift apart.
 */

/** A single environment variable an integration reads. */
export interface IntegrationEnvVar {
  /** The env-var / Worker-secret name, e.g. 'SERPER_API_KEY'. */
  name: string;
  /** What it holds and where to get it. */
  description: string;
  /** A secret (API key/token/DB URL) → set via `wrangler secret put`, never committed. */
  secret: boolean;
  /** If false, this var is optional even when the integration is otherwise configured. */
  required: boolean;
  /** A safe, non-secret example value for `.dev.vars.example` (never a real credential). */
  example?: string;
}

export type IntegrationCategory = 'identity' | 'billing' | 'serp' | 'llm' | 'data';

/** The activation status of a whole integration, decided by whether its required vars are present. */
export type IntegrationStatus = 'configured' | 'partial' | 'missing';

export interface IntegrationDef {
  id: string;
  name: string;
  category: IntegrationCategory;
  /** One-line statement of what the product uses it for. */
  purpose: string;
  /** The external account a human must create before this can go live. */
  account: string;
  /** Whether the MVP/pre-alpha requires this to function at all (vs. a later-phase nicety). */
  requiredForMvp: boolean;
  env: IntegrationEnvVar[];
  /** Provisioning notes / cost posture, surfaced in docs. */
  notes: string;
}

export const INTEGRATIONS: IntegrationDef[] = [
  {
    id: 'database',
    name: 'Postgres (Neon)',
    category: 'data',
    purpose: 'Primary operational store — accounts, projects, entities, findings, actions, onboarding, subscriptions.',
    account: 'Neon (managed Postgres, AWS ap-southeast-1 / Singapore). Identity via Neon Auth.',
    requiredForMvp: true,
    env: [
      {
        name: 'DATABASE_URL',
        description: 'Neon Postgres connection string (pooled). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'postgres://user:password@ep-xxxx.ap-southeast-1.aws.neon.tech/engine?sslmode=require',
      },
    ],
    notes: 'Already provisioned. Connection is bound as a Worker secret via `wrangler secret put DATABASE_URL`.',
  },
  {
    id: 'neon-auth',
    name: 'Neon Auth (Better Auth)',
    category: 'identity',
    purpose:
      'User identity + the API auth gate: the dashboard signs in here, and apps/api verifies the resulting JWT against the published JWKS.',
    account: 'Neon Auth (managed Better Auth) — already enabled on the Neon project; Google sign-in configured there.',
    requiredForMvp: true,
    env: [
      {
        name: 'AUTH_JWKS_URL',
        description:
          "Neon Auth's public JWKS endpoint. Public, not a secret — it publishes verification keys, not signing keys.",
        secret: false,
        required: true,
        example: 'https://<project>.neonauth.<region>.aws.neon.tech/neondb/auth/.well-known/jwks.json',
      },
      {
        name: 'AUTH_ISSUER',
        description: "Expected `iss` claim. Optional: leave unset to accept any issuer the JWKS key signs for.",
        secret: false,
        required: false,
        example: 'https://<project>.neonauth.<region>.aws.neon.tech/neondb/auth',
      },
      {
        name: 'AUTH_AUDIENCE',
        description: 'Expected `aud` claim. Optional — set once Neon Auth is configured to mint audience-scoped tokens.',
        secret: false,
        required: false,
        example: 'engine-api',
      },
      {
        name: 'INTERNAL_API_TOKEN',
        description:
          'Shared service token for machine callers with no user session (the edge worker\'s C1.7 auto-rollback). Bind the same value on apps/api and apps/workers.',
        secret: true,
        required: false,
        example: 'a-long-random-string',
      },
      {
        name: 'AUTH_MODE',
        description:
          "Set to 'disabled' to run the API unauthenticated for local development only. Never set this on a deployed Worker — it holds live SERP/LLM keys.",
        secret: false,
        required: false,
        example: 'disabled',
      },
    ],
    notes:
      'JWT verification is fully unit-tested against real generated Ed25519 keys (crypto only, no live account needed). Deployed dashboard origins must be added to Neon Auth trusted origins for the OAuth callback to be accepted.',
  },
  {
    id: 'gsc-oauth',
    name: 'Google Search Console (OAuth)',
    category: 'identity',
    purpose: 'E1 onboarding: the user connects their GSC property so we can read verified search performance (field CWV, queries).',
    account: 'Google Cloud project with an OAuth 2.0 Web client + the Search Console API enabled.',
    requiredForMvp: true,
    env: [
      {
        name: 'GSC_CLIENT_ID',
        description: 'OAuth 2.0 client ID from the Google Cloud console.',
        secret: false,
        required: true,
        example: '1234567890-abcdefg.apps.googleusercontent.com',
      },
      {
        name: 'GSC_CLIENT_SECRET',
        description: 'OAuth 2.0 client secret. Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'GOCSPX-xxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'GSC_REDIRECT_URI',
        description: 'The registered OAuth redirect URI — must match `/oauth/gsc/callback` exactly.',
        secret: false,
        required: true,
        example: 'https://api.engine.example/oauth/gsc/callback',
      },
    ],
    notes:
      'Blocked on creating the Cloud project + OAuth client. The connect-URL builder and token-exchange callback are code-complete behind these vars.',
  },
  {
    id: 'stripe',
    name: 'Stripe (billing)',
    category: 'billing',
    purpose: 'G3 billing: subscription lifecycle synced from Stripe webhooks into our read-model; plan/usage/over-limit enforcement.',
    account: 'Stripe account (test mode is enough for pre-alpha) with products/prices for the plan tiers and a webhook endpoint.',
    requiredForMvp: true,
    env: [
      {
        name: 'STRIPE_WEBHOOK_SECRET',
        description: 'Signing secret for the `/billing/webhook` endpoint (whsec_...). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'whsec_xxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'STRIPE_PRICE_TO_TIER',
        description: 'JSON map of Stripe price id → our PlanTier, e.g. {"price_starter":"starter","price_growth":"growth"}.',
        secret: false,
        required: true,
        example: '{"price_starter_monthly":"starter","price_growth_monthly":"growth"}',
      },
      {
        name: 'STRIPE_SECRET_KEY',
        description: 'Stripe secret API key — only needed for outbound calls (creating checkout sessions / portal links). Webhook verification does not use it.',
        secret: true,
        required: false,
        example: 'sk_test_xxxxxxxxxxxxxxxxxxxxxxxx',
      },
    ],
    notes:
      'Webhook signature verification + event mapping are fully unit-tested (crypto only, no live account needed). Going live needs the Stripe account, real price ids, and the webhook endpoint registered.',
  },
  {
    id: 'serp',
    name: 'Serper.dev (SERP data)',
    category: 'serp',
    purpose: 'A1 rank tracking: Google SERP positions + features (AI Overview presence, local pack, PAA) per tracked keyword/geo/device.',
    account: 'Serper.dev account (2,500 free credits on signup; prepaid credits after — cannot bill-shock).',
    requiredForMvp: true,
    env: [
      {
        name: 'SERP_PROVIDER',
        description: "Which SERP adapter to use. 'serper' today; the interface also supports 'dataforseo'/'serpapi' for a later switch.",
        secret: false,
        required: false,
        example: 'serper',
      },
      {
        name: 'SERPER_API_KEY',
        description: 'Serper.dev API key (X-API-KEY header). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'serper_xxxxxxxxxxxxxxxxxxxxxxxx',
      },
    ],
    notes:
      'Chosen for the most generous free tier + prepaid (no surprise bills). The SerpConnector interface abstracts the vendor, so switching to DataForSEO/SerpApi later is a small change.',
  },
  {
    id: 'llm-openai',
    name: 'OpenAI (LLM engine)',
    category: 'llm',
    purpose: 'A2 AI visibility: poll OpenAI for answers to tracked prompts, extract citations/sources (n-sampling → confidence band).',
    account: 'OpenAI API account with a funded key.',
    requiredForMvp: true,
    env: [
      {
        name: 'OPENAI_API_KEY',
        description: 'OpenAI API key. Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'OPENAI_MODEL',
        description: 'Model id to poll (defaults to a current small model if unset).',
        secret: false,
        required: false,
        example: 'gpt-4o-mini',
      },
    ],
    notes: 'Primary LLM engine for A2. Adapter is built and fixture-tested; needs a funded key to poll live.',
  },
  {
    id: 'llm-gemini',
    name: 'Google Gemini (LLM engine)',
    category: 'llm',
    purpose: 'A2 AI visibility: second LLM engine — Gemini readiness alongside OpenAI, with grounding-source citation extraction.',
    account: 'Google AI Studio / Gemini API key (generous free tier).',
    requiredForMvp: false,
    env: [
      {
        name: 'GEMINI_API_KEY',
        description: 'Google Gemini API key (AI Studio). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'AIzaSyxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'GEMINI_MODEL',
        description: 'Gemini model id to poll (defaults to a current flash model if unset).',
        secret: false,
        required: false,
        example: 'gemini-2.0-flash',
      },
    ],
    notes: 'Built and fixture-tested for readiness. Can run in parallel with OpenAI once a key is set.',
  },
];

/** Look up an integration by id. */
export function getIntegration(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
