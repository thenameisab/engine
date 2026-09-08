/**
 * One error type with a machine-readable reason, because every caller has to
 * branch on *why* a connection failed and none of them can branch on prose.
 *
 * The three consequential distinctions:
 *
 *   `grant_revoked`   the customer must reconnect — show it, stop retrying
 *   `rate_limited`    back off and retry — say nothing to the customer
 *   `vendor_error`    transient, retry later
 *
 * Collapsing those is how a product ends up retrying a dead grant forever in
 * silence, or telling a customer to reconnect because a vendor had a bad
 * minute.
 */
import { redactError } from './redact.js';

export type IntegrationErrorReason =
  /** The stored grant is gone for good: revoked, expired, password changed. */
  | 'grant_revoked'
  /** Credentials were rejected. A paste error on connect, not a dead grant. */
  | 'invalid_credentials'
  /** Connected, but the vendor did not grant a scope this integration needs. */
  | 'insufficient_scope'
  /** Vendor returned 429 or a documented quota error. */
  | 'rate_limited'
  /** Vendor returned 5xx, or the request timed out. */
  | 'vendor_error'
  /** The vendor's response did not match its own documented contract. */
  | 'invalid_response'
  /** This deployment has no client credentials for the provider. */
  | 'not_configured'
  /** The provider id is unknown, or is not connectable yet. */
  | 'unknown_provider'
  /** The caller passed something invalid; not the vendor's fault. */
  | 'invalid_request';

export class IntegrationError extends Error {
  readonly reason: IntegrationErrorReason;
  readonly providerId: string | undefined;
  /** HTTP status from the vendor, when the failure came from a response. */
  readonly status: number | undefined;
  /** Seconds to wait, from `Retry-After`. Only ever set for `rate_limited`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    reason: IntegrationErrorReason,
    message: string,
    opts: { providerId?: string; status?: number; retryAfterSeconds?: number; cause?: unknown } = {},
  ) {
    // Redacted at construction, not at logging time. A message is copied into
    // logs, database columns and API responses by code that has no reason to
    // remember it might contain a token; the only reliable place to clean it
    // is the one place it is created.
    super(redactError(message), { cause: opts.cause });
    this.name = 'IntegrationError';
    this.reason = reason;
    this.providerId = opts.providerId;
    this.status = opts.status;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }

  /** True when retrying could plausibly succeed without the customer doing anything. */
  get retryable(): boolean {
    return this.reason === 'rate_limited' || this.reason === 'vendor_error';
  }

  /** True when only the customer can fix it, by reconnecting. */
  get needsReauth(): boolean {
    return this.reason === 'grant_revoked' || this.reason === 'insufficient_scope';
  }
}

export function isIntegrationError(e: unknown): e is IntegrationError {
  return e instanceof IntegrationError;
}
