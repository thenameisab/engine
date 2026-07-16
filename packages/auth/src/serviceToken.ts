/**
 * Service-to-service authentication — the non-human half of the API gate.
 *
 * The edge worker (apps/workers) calls the API's rollback endpoint on its own
 * behalf when a deployed fix fails its health check (C1.7 auto-rollback).
 * There is no user session behind that call, so it cannot present a Neon Auth
 * JWT. It presents a shared service token instead, bound to both Workers as a
 * secret.
 *
 * Kept deliberately separate from the JWT path so the two trust sources never
 * blur: a service token is a machine principal with a narrow job, not a user.
 */

/**
 * Constant-time string comparison. A naive `===` returns as soon as it finds a
 * differing byte, which leaks how much of a guessed token was correct and
 * makes the secret discoverable one character at a time. Length is compared
 * first and non-constant-time — token length is not the secret.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * True when `presented` matches the configured service token. An unset or
 * empty `expected` always returns false: an unconfigured service token must
 * never authenticate anyone, least of all a caller who also sends nothing.
 */
export function verifyServiceToken(presented: string | null | undefined, expected: string | undefined): boolean {
  if (!expected || !presented) return false;
  return timingSafeEqual(presented, expected);
}
