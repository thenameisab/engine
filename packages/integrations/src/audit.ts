/**
 * What happened to a customer's credential, and who caused it.
 *
 * `integration_connections` records that a connection exists and who created
 * it, which answers "what is wired" but not "what was done to it". Those are
 * different questions, and the second is the one asked after an incident: when
 * did this grant start failing, who disconnected the customer's Business
 * Profile last Tuesday, did anyone use the credential between the revocation
 * and our noticing.
 *
 * A connection row cannot answer any of that, because it is overwritten. An
 * append-only event stream can.
 *
 * These are shapes, not storage. The library emits; the application decides
 * where they land — the same seam that keeps this package free of a database
 * dependency and testable without one.
 */

export type IntegrationEventType =
  /** A consent flow was started. Pairs with connected/failed. */
  | 'connect_started'
  /** A credential was stored for the first time, or replaced by a reconnect. */
  | 'connected'
  /** A connect attempt failed before anything was stored. */
  | 'connect_failed'
  /** An access token was minted from the stored credential. */
  | 'refreshed'
  /** A refresh failed. `reason` says whether the grant is gone. */
  | 'refresh_failed'
  /** The customer's stored credential was deleted. */
  | 'disconnected'
  /** A stored credential was re-sealed under a newer encryption key. */
  | 'key_rotated'
  /** A provider resource was attached to or detached from a project. */
  | 'assignment_changed';

/**
 * Who performed the action.
 *
 * A machine actor is named rather than folded into the user who happened to
 * create the connection — a nightly sync refreshing a token at 03:15 is not
 * the person who connected it in March, and an audit trail that says otherwise
 * is worse than none.
 */
export type IntegrationActor =
  | { kind: 'user'; userId: string }
  | { kind: 'service'; name: string };

export interface IntegrationEvent {
  type: IntegrationEventType;
  accountId: string;
  providerId: string;
  actor: IntegrationActor;
  occurredAt: Date;
  /** Machine-readable failure reason, from IntegrationError. */
  reason?: string;
  /**
   * Free-text context. Must already be redacted — the emitter is responsible,
   * because only it knows whether the string came from a vendor.
   */
  detail?: string;
  /**
   * Non-secret structured context: resource ids, scope names, key versions.
   * Never credentials — this is written verbatim to storage and to logs.
   */
  metadata?: Record<string, string | number | boolean>;
}

/** Where events go. Implemented by the application; a no-op is a valid choice. */
export interface AuditSink {
  record(event: IntegrationEvent): Promise<void>;
}

/**
 * Discards events. The default, so that a caller which has not wired an audit
 * store yet still runs — and so tests do not each need a stub.
 */
export const nullAuditSink: AuditSink = {
  async record() {
    /* intentionally does nothing */
  },
};

/**
 * Record an event without letting the recording break the operation.
 *
 * An audit sink that is down must not turn a working token refresh into a
 * failed one. The trade is deliberate and worth stating: this loses events
 * under failure rather than losing the operation, which is the right side for
 * an operational audit trail and the wrong side for a compliance one. If this
 * ever has to be the latter, the fix is a durable queue here, not a thrown
 * error.
 */
export async function recordSafely(
  sink: AuditSink,
  event: IntegrationEvent,
  onError?: (e: unknown) => void,
): Promise<void> {
  try {
    await sink.record(event);
  } catch (e) {
    onError?.(e);
  }
}
