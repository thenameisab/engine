/**
 * @engine/integrations — the customer-owned integration layer.
 *
 * Customer-owned is the distinction that shapes this package. A platform
 * integration (Postgres, Stripe, OpenAI, Serper) is one credential this
 * deployment holds, set once with `wrangler secret put`, identical for every
 * customer; those live in `@engine/config` and are wired by an operator. What
 * is here belongs to the customer: it arrives at runtime, is sealed per
 * account, and must be revocable by them alone.
 *
 * The package is pure — no database, no HTTP framework. I/O arrives as an
 * injected `fetch` and as interfaces the application implements, so every rule
 * in here is testable without a network or a live vendor account.
 */
export * from './types.js';
export * from './registry.js';
export * from './oauth2.js';
export * from './pkce.js';
export * from './credentials.js';
export * from './errors.js';
export * from './redact.js';
export * from './http.js';
export * from './resources.js';
export * from './audit.js';
export * from './githubApp.js';
