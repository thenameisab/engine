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

export type IntegrationCategory = 'identity' | 'billing' | 'serp' | 'llm' | 'data' | 'deploy';

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
  /**
   * The brand's primary domain, used only to fetch a logo (logo.dev keys its
   * image API by domain). Lives here rather than in a lookup table in the
   * dashboard so that adding an integration brings its own mark with it —
   * the same reason the env catalogue and the docs read from this registry.
   *
   * Empty for an integration with no third-party vendor; the UI renders a
   * monogram instead of requesting a logo that cannot exist.
   */
  logoDomain: string;
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
    logoDomain: 'neon.tech',
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
    logoDomain: 'neon.tech',
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
          "Set to 'disabled' to run the API unauthenticated. Honoured only for requests to a loopback host, so setting it on a deployed Worker refuses requests rather than opening them.",
        secret: false,
        required: false,
        example: 'disabled',
      },
      {
        name: 'ALLOWED_EMAILS',
        description:
          'Comma-separated invite list. Unset means any Google account that clears the consent screen may sign in and create its own account — set this to enforce the "invite-only, pre-alpha" the sign-in screen claims.',
        secret: false,
        required: false,
        example: 'first@example.com,second@example.com',
      },
    ],
    notes:
      'JWT verification is fully unit-tested against real generated Ed25519 keys (crypto only, no live account needed). Deployed dashboard origins must be added to Neon Auth trusted origins for the OAuth callback to be accepted.',
  },
  {
    id: 'local-auth',
    name: 'Credential sign-in (fixed pre-alpha roster)',
    category: 'identity',
    purpose:
      'Signs the three pre-alpha users in with an email and password, minting a session token the API verifies itself. Exists because Neon Auth cannot complete a Google sign-in from the deployed dashboard origin.',
    account: 'None — no third party. Both values are chosen by whoever operates the deployment.',
    // No third party, so no vendor mark — the UI falls back to a monogram.
    logoDomain: '',
    requiredForMvp: false,
    env: [
      {
        name: 'LOCAL_AUTH_USERS',
        description:
          'The roster: `email:password[:Display Name]`, comma-separated. A password cannot contain a comma or a colon. This is a secret — it holds live passwords.',
        secret: true,
        required: true,
        example: 'first@example.com:a-long-password:First Person,second@example.com:another-password',
      },
      {
        name: 'LOCAL_AUTH_SECRET',
        description:
          'HMAC key for the session tokens `POST /auth/login` mints. Rotating it signs everyone out. Use a different value from OAUTH_STATE_SECRET.',
        secret: true,
        required: true,
        example: 'a-long-random-string',
      },
    ],
    notes:
      'A deliberate stopgap, not the identity story: no signup, no password reset, no recovery. Delete both values to turn credential sign-in off — the API then answers 503 on /auth/login and falls back to Neon Auth JWTs alone.',
  },
  {
    id: 'email',
    name: 'Resend (transactional email)',
    category: 'identity',
    purpose:
      'Delivers the sign-in codes, invitations and password-reset mail the accounts-and-access work sends. One HTTPS call per message from the Worker; no binding.',
    account:
      'A Resend account with the sending domain verified (SPF and DKIM records on the zone). The free plan is 3,000 emails a month, 100 a day. Chosen over Cloudflare Email Service because that needs Workers Paid and this deployment stays on Free.',
    logoDomain: 'resend.com',
    requiredForMvp: true,
    env: [
      {
        name: 'RESEND_API_KEY',
        description: 'Resend API key (re_...). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 're_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'EMAIL_FROM',
        description:
          'The From header on every message, `Name <address>`. The address must be on a domain verified in Resend, or every send is refused.',
        secret: false,
        required: true,
        example: 'Engine <login@example.com>',
      },
    ],
    notes:
      'Transactional only: codes, invitations, resets. Nothing here sends marketing mail. Unset both to turn email sign-in off — the API then answers 503 on /auth/code/request and password sign-in still works.',
  },
  {
    id: 'google-integrations',
    name: 'Google integrations (Search Console, GA4, Business Profile)',
    category: 'identity',
    purpose:
      'Customers connect their own Google accounts in the product: GSC search performance, GA4 traffic, and GBP location reads plus C5 write-back.',
    account:
      'One Google Cloud project with an OAuth 2.0 Web client. Enable: Search Console API; Analytics Data API AND Analytics Admin API; My Business Account Management, Business Information and Google My Business (v4) APIs.',
    logoDomain: 'google.com',
    requiredForMvp: true,
    env: [
      {
        name: 'GOOGLE_CLIENT_ID',
        description: 'OAuth 2.0 client ID. One client serves all three providers — they differ only by scope.',
        secret: false,
        required: true,
        example: '1234567890-abcdefg.apps.googleusercontent.com',
      },
      {
        name: 'GOOGLE_CLIENT_SECRET',
        description: 'OAuth 2.0 client secret. Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'GOCSPX-xxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'GOOGLE_REDIRECT_URI',
        description:
          'The registered redirect URI. Google matches it byte-for-byte, so it must equal the deployed origin plus `/oauth/google/callback` exactly.',
        secret: false,
        required: true,
        example: 'https://engine-api.workers.dev/oauth/google/callback',
      },
      {
        name: 'ENCRYPTION_KEY',
        description:
          'base64 of 32 random bytes (`openssl rand -base64 32`). Seals customer refresh tokens at rest (AES-256-GCM). Rotating it invalidates every stored connection — every customer must reconnect.',
        secret: true,
        required: true,
        example: 'ZmFrZS1rZXktZm9yLXRoZS1leGFtcGxlLW9ubHktMzJiIQ==',
      },
      {
        name: 'OAUTH_STATE_SECRET',
        description:
          'Signs the OAuth `state` parameter. An override only: since #82 the secret is generated and stored sealed in `platform_credentials` on first use (`ensureStateSecret`), so a deployment that never sets this still signs state. Set it to pin the value explicitly, and it wins.',
        secret: true,
        required: false,
        example: 'a-long-random-string',
      },
      {
        name: 'DASHBOARD_URL',
        description: 'Dashboard origin, for the post-consent return link. Optional — the callback page still renders without it.',
        secret: false,
        required: false,
        example: 'https://engine-7vv.pages.dev/app',
      },
    ],
    notes:
      'Blocked on creating the Cloud project + OAuth client. GBP additionally needs an approved Business Profile API access request — new Cloud projects get zero quota, and approval takes weeks. All three scopes are sensitive, so until Google verifies the app it is capped at ~100 manually-added test users behind a warning screen.',
  },
  {
    id: 'stripe',
    name: 'Stripe (billing)',
    category: 'billing',
    purpose: 'G3 billing: subscription lifecycle synced from Stripe webhooks into our read-model; plan/usage/over-limit enforcement.',
    account: 'Stripe account (test mode is enough for pre-alpha) with products/prices for the plan tiers and a webhook endpoint.',
    logoDomain: 'stripe.com',
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
        description: 'Stripe secret API key. Required for `POST /accounts/:id/billing/checkout` (M1.7); webhook verification does not use it.',
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
    logoDomain: 'serper.dev',
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
        description:
          "Serper.dev API key (X-API-KEY header). Bound as a Worker secret. Since 2026-09-09 Serper is also connectable per client, and a client's own key wins over this one; this is the fallback for clients that have connected none.",
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
    logoDomain: 'openai.com',
    // Sarvam is the engine this deployment has credit on, so OpenAI is no
    // longer what makes the AI-visibility surface work. Built and tested; a
    // funded key switches it on alongside Sarvam.
    requiredForMvp: false,
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
    logoDomain: 'gemini.google.com',
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
  {
    id: 'llm-sarvam',
    name: 'Sarvam (LLM engine)',
    category: 'llm',
    purpose:
      'A2 AI visibility: poll Sarvam for answers to tracked prompts and extract citations. The engine this deployment runs on.',
    account: 'Sarvam AI account with API credits.',
    logoDomain: 'sarvam.ai',
    requiredForMvp: true,
    env: [
      {
        name: 'SARVAM_API_KEY',
        description: 'Sarvam API subscription key (api-subscription-key header). Bound as a Worker secret.',
        secret: true,
        required: true,
        example: 'sk_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxx',
      },
      {
        name: 'SARVAM_MODEL',
        description:
          "Sarvam model id to poll. Defaults to 'sarvam-105b'. The key's own model list is the authority on what is accepted.",
        secret: false,
        required: false,
        example: 'sarvam-105b',
      },
    ],
    notes:
      'sarvam-105b is a reasoning model: it spends the token budget thinking before it answers, so the connector asks for 4,000 tokens and refuses a reply that was truncated before any answer text. It does not browse, so cited sources are only the URLs the answer itself contains.',
  },
  {
    id: 'github-pr',
    name: 'GitHub (PR export)',
    category: 'deploy',
    purpose: "C4.5 GitHub PR export: for headless sites with no edge worker or CMS plugin, deploy a fix as a reviewable PR against the customer's repo (@engine/deploy's 'github-pr' DeployTarget).",
    account: 'A GitHub App or fine-grained PAT with contents:write + pull-requests:write on the customer repo(s).',
    logoDomain: 'github.com',
    requiredForMvp: false,
    env: [
      {
        name: 'GITHUB_TOKEN',
        description:
          "Token used to call GitHub's REST API on the customer's behalf. Bound as a Worker secret. Per-account tokens are a later scope; this is a single shared token for pre-alpha.",
        secret: true,
        required: true,
        example: 'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      },
    ],
    notes:
      'Request shapes (branch create, file write, PR open) are fully unit-tested against GitHub\'s documented REST API with a mocked fetch — no live token needed for that. Going live needs a real GitHub App/PAT scoped to a customer repo.',
  },
];

/** Look up an integration by id. */
export function getIntegration(id: string): IntegrationDef | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
