/**
 * Turning a thrown request error into a sentence.
 *
 * `request` throws `"<status> <raw body>"`, so an unhandled error renders the
 * API's JSON straight into the page — both ugly and a leak of internals. This
 * pulls out the `error` field the API always sends, and names the statuses
 * that mean something specific rather than repeating a number.
 *
 * Shared rather than private to one view: it started in the integrations
 * screen, and the second screen that needed it would otherwise have copied it.
 */
export function readableError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const match = /^(\d{3})\s+([\s\S]*)$/.exec(raw);
  if (!match) return raw;
  const [, status, body] = match;
  let detail = body.trim();
  try {
    const parsed = JSON.parse(detail) as { error?: string };
    if (parsed.error) detail = parsed.error;
  } catch {
    /* not JSON — show the body as-is */
  }
  // 401 has one cause a customer can act on and one they cannot: the session
  // is gone, or the request carried no token. Either way "missing bearer
  // token" is our vocabulary, not theirs, so it is replaced rather than
  // appended to.
  if (status === '401') return 'Your session has expired. Sign in again.';
  // Not "pick the right client from the Clients grid": a company or an
  // individual has no client layer and no grid, so the recovery it named did
  // not exist for them. The switcher is where the open site is changed
  // whatever kind of account this is.
  if (status === '403') return `${detail}. Check which site is open in the switcher at the top of the rail.`;
  if (status === '404') return `${detail}.`;
  if (status === '503') return detail;
  return detail || `Request failed (${status}).`;
}
