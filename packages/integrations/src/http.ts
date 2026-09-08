/**
 * The only way this library talks to a vendor.
 *
 * A bare `fetch` to a third party from inside a request handler has four ways
 * to hurt the product, and all four have to be closed in one place or they get
 * closed nowhere:
 *
 *   - **No timeout.** A vendor that accepts a connection and never answers
 *     holds a Worker isolate until the platform kills it. One slow vendor
 *     becomes our outage.
 *   - **Unbounded body.** An error page instead of JSON, read with `.text()`,
 *     is however many megabytes the vendor felt like sending.
 *   - **Redirects.** `fetch` follows them by default and re-sends the
 *     Authorization header to wherever it lands. A vendor with a misconfigured
 *     redirect hands our bearer token to a third host.
 *   - **Retrying the wrong things.** Retrying a 401 is pointless; retrying a
 *     429 without honouring `Retry-After` is how an account gets suspended.
 *
 * Everything here is injectable so the rules are testable without a network.
 */
import { IntegrationError } from './errors.js';
import { redact } from './redact.js';

export interface HttpOptions {
  fetchImpl?: typeof fetch;
  /** Per-attempt timeout. Not a budget across retries. */
  timeoutMs?: number;
  /** Attempts after the first. 0 disables retrying. */
  maxRetries?: number;
  /** Cap on the response body we will read, in bytes. */
  maxBodyBytes?: number;
  /** Injectable delay, so backoff is testable without waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Provider id, carried into any error raised. */
  providerId?: string;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  maxRetries: 2,
  maxBodyBytes: 256 * 1024,
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface VendorResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  /**
   * Body text, truncated at `maxBodyBytes`, **not redacted**.
   *
   * It cannot be: a successful token response *is* the credential, and
   * redacting it here would hand the caller `access_token: "[redacted]"` and
   * break every OAuth flow in the library. Redaction happens where a string
   * escapes into a log, a database column or an API response — which in
   * practice means `IntegrationError`, whose constructor redacts every message
   * it is given. Do not log this field directly; put it in an IntegrationError
   * and log that.
   */
  text: string;
}

/**
 * Parse `Retry-After`, which is either seconds or an HTTP date.
 *
 * Clamped to an hour: a vendor asking us to sleep for a day inside a request
 * handler is not a thing to comply with literally.
 */
export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 3600);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, Math.ceil((date - nowMs) / 1000)), 3600);
}

/** 429 and 5xx are worth another attempt; nothing else is. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Exponential backoff with full jitter, so a fleet does not retry in lockstep. */
function backoffMs(attempt: number, random: () => number): number {
  return Math.round(random() * Math.min(8000, 250 * 2 ** attempt));
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.slice(0, Math.max(0, value.byteLength - (total - maxBytes))));
        // Stop pulling rather than draining a stream we have decided to ignore.
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } catch {
    // A truncated body is still worth reporting on; the status carries the
    // outcome and the partial text is diagnostic.
  }
  const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * One vendor request, with the four rules above applied.
 *
 * Returns the response for any status the caller might act on — a 401 is a
 * result, not an exception, because only the caller knows whether it means
 * "bad paste" or "revoked grant". Throws only when there is no response at all
 * (timeout, DNS, TLS) or when retries are exhausted on a retryable status.
 */
export async function vendorFetch(
  url: string,
  init: RequestInit,
  options: HttpOptions = {},
): Promise<VendorResponse> {
  const {
    fetchImpl = fetch,
    timeoutMs = DEFAULTS.timeoutMs,
    maxRetries = DEFAULTS.maxRetries,
    maxBodyBytes = DEFAULTS.maxBodyBytes,
    sleep = defaultSleep,
    providerId,
  } = options;

  let lastStatus: number | undefined;
  let lastRetryAfter: number | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        // Never follow a redirect on a request that carries a credential.
        redirect: 'manual',
      });
    } catch (cause) {
      clearTimeout(timer);
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt, Math.random));
        continue;
      }
      throw new IntegrationError(
        'vendor_error',
        aborted ? `request timed out after ${timeoutMs}ms` : `request failed: ${redact(String(cause))}`,
        { providerId, cause },
      );
    }
    clearTimeout(timer);

    // 'manual' surfaces a redirect as an opaque response rather than following
    // it. Treated as a vendor fault: a token endpoint must not redirect.
    if (res.status >= 300 && res.status < 400) {
      throw new IntegrationError('vendor_error', `vendor redirected (HTTP ${res.status}); refusing to resend credentials`, {
        providerId,
        status: res.status,
      });
    }

    // Raw, deliberately — see VendorResponse.text. Every path that turns this
    // into a message goes through IntegrationError, which redacts.
    const text = await readCapped(res, maxBodyBytes);

    if (isRetryableStatus(res.status) && attempt < maxRetries) {
      lastStatus = res.status;
      lastRetryAfter = parseRetryAfter(res.headers.get('retry-after'));
      // Honour Retry-After when the vendor sent one; it is a documented
      // instruction, and ignoring it is how quota bans happen.
      const waitMs = lastRetryAfter !== undefined ? lastRetryAfter * 1000 : backoffMs(attempt, Math.random);
      await sleep(waitMs);
      continue;
    }

    if (isRetryableStatus(res.status)) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      throw new IntegrationError(
        res.status === 429 ? 'rate_limited' : 'vendor_error',
        `vendor returned HTTP ${res.status} after ${maxRetries + 1} attempts: ${text.slice(0, 200)}`,
        { providerId, status: res.status, retryAfterSeconds: retryAfter ?? lastRetryAfter },
      );
    }

    return { status: res.status, ok: res.ok, headers: res.headers, text };
  }

  /* c8 ignore next 4 -- the loop always returns or throws; this satisfies the
     compiler's control-flow analysis without pretending to be reachable. */
  throw new IntegrationError('vendor_error', `request failed after ${maxRetries + 1} attempts`, {
    providerId,
    status: lastStatus,
  });
}

/** Parse a vendor body as JSON, or fail with the status and a bounded excerpt. */
export function parseJson<T>(res: VendorResponse, context: string, providerId?: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new IntegrationError(
      'invalid_response',
      `${context}: expected JSON, got HTTP ${res.status} ${res.text.slice(0, 200)}`,
      { providerId, status: res.status },
    );
  }
}
