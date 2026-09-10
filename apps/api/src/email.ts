/**
 * Outbound transactional email: sign-in codes, invitations, password resets.
 *
 * One HTTPS call to Resend per message. Cloudflare Email Service was the
 * plan's first choice (§3 of the 2026-09-10 action plan) and is closed to
 * this deployment: outbound sending is "Not available" on Workers Free, and
 * the account stays on Free. Resend's free plan covers the volume (3,000 a
 * month, 100 a day) and needs no Worker binding, so the transport is a
 * function of two env values and nothing else.
 *
 * The interface is the point. Every route that sends mail takes an
 * `EmailSender`, so a test hands in one that records instead of sending, and
 * a future move back to Cloudflare Email Service replaces one factory.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<{ id: string }>;
}

export interface EmailEnv {
  RESEND_API_KEY?: string;
  /** `Name <address>`; the address must be on a domain Resend has verified. */
  EMAIL_FROM?: string;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** Whether both values the transport needs are present. */
export function isEmailConfigured(env: EmailEnv): boolean {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/**
 * The sender for this deployment, or null when unconfigured.
 *
 * Null rather than a sender that throws on first use: the route that needs
 * mail should answer 503 "not configured" before it stores a code nobody will
 * receive, and a null at construction is what lets it decide that up front.
 */
export function createEmailSender(env: EmailEnv, fetchImpl: typeof fetch = fetch): EmailSender | null {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  return {
    async send(message) {
      const res = await fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });
      if (!res.ok) {
        // Resend answers 4xx with `{ statusCode, name, message }`. The message
        // names the cause ("domain is not verified", "invalid `from`") and is
        // the one line an operator needs; the recipient address is not
        // repeated into the log.
        const body = (await res.json().catch(() => null)) as { message?: string; name?: string } | null;
        throw new Error(`email send failed: ${res.status} ${body?.name ?? ''} ${body?.message ?? ''}`.trim());
      }
      const data = (await res.json()) as { id?: string };
      return { id: data.id ?? '' };
    },
  };
}
