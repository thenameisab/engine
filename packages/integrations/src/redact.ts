/**
 * Keep credentials out of everything that gets written down.
 *
 * The schema is careful — the sealed secret is in its own table so that
 * `select *` cannot leak it. That care is undone the first time a vendor's
 * error body is stored in `last_error` or passed to `console.error`, because
 * OAuth error responses routinely echo the request back, and a token endpoint
 * called with a bad `redirect_uri` will happily include the `client_secret`
 * it was sent in the message it returns.
 *
 * So nothing vendor-supplied reaches a log or a database column without passing
 * through here first. This is a net, not a guarantee: the primary defence is
 * never putting a secret in a string, and `redact` exists for the cases where
 * the string was assembled by someone else.
 */

/**
 * Parameter and JSON-field names whose values are always secret.
 *
 * Matched case-insensitively against both `name=value` (form bodies, query
 * strings) and `"name": "value"` (JSON bodies).
 */
const SECRET_KEYS = [
  'access_token',
  'refresh_token',
  'id_token',
  'client_secret',
  'code',
  'code_verifier',
  'assertion',
  'password',
  'api_key',
  'apikey',
  'authorization',
  'token',
  'secret',
];

const KEY_ALTERNATION = SECRET_KEYS.join('|');

/**
 * `client_secret=abc`, `token: xyz`, `apikey = 123` — form, query and loose text.
 *
 * The negative lookahead matters more than it looks. Without it,
 * `Authorization: Bearer <token>` matches with `Bearer` as the value, so this
 * rule redacts the word "Bearer" and leaves the actual credential sitting in
 * the rest of the line. The auth-scheme keywords are skipped here and handled
 * by BEARER_RE, which takes the token with them.
 */
const PAIR_RE = new RegExp(
  `\\b(${KEY_ALTERNATION})\\b(\\s*[=:]\\s*)("?)(?!Bearer\\b|Basic\\b)([^\\s&,"'}]+)\\3`,
  'gi',
);

/** `"access_token": "abc"` — JSON, including the quotes around the key. */
const JSON_RE = new RegExp(`("(?:${KEY_ALTERNATION})"\\s*:\\s*)"[^"]*"`, 'gi');

/** `Authorization: Bearer abc` and `Basic abc`, which the pair rule alone misses. */
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/**
 * Values that look like a credential regardless of what they are called.
 *
 * Deliberately narrow, anchored on prefixes vendors actually use. A general
 * "long random-looking string" rule would redact resource ids, URLs and
 * property names, which are the things an operator needs to read in order to
 * diagnose anything.
 */
const KNOWN_TOKEN_SHAPES = [
  /\bya29\.[A-Za-z0-9._-]+/g, // Google OAuth access token
  /\b1\/\/[A-Za-z0-9._-]{20,}/g, // Google refresh token
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google OAuth client secret
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style secret key
  /\bpat-[a-z0-9-]+-[A-Za-z0-9-]{16,}/gi, // HubSpot private-app token
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g, // GitHub token
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack token
];

export const REDACTED = '[redacted]';

/**
 * Replace anything that looks like a credential with `[redacted]`.
 *
 * Structure is preserved — `client_secret=[redacted]` rather than dropping the
 * parameter — because knowing *which* value was wrong is most of the diagnostic
 * value, and the name is not the secret.
 */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  // Order is load-bearing: the scheme rule runs before the key/value rule so
  // that `Authorization: Bearer <token>` loses the token rather than the word.
  out = out.replace(BEARER_RE, `$1 ${REDACTED}`);
  out = out.replace(JSON_RE, `$1"${REDACTED}"`);
  out = out.replace(PAIR_RE, `$1$2$3${REDACTED}$3`);
  for (const shape of KNOWN_TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/**
 * Redact an unknown thrown value and cap its length.
 *
 * Capped because this feeds `last_error`, a display column: a vendor that
 * returns an HTML error page would otherwise put a kilobyte of markup in a
 * database row and then into a UI element.
 */
export function redactError(error: unknown, maxLength = 500): string {
  const raw = error instanceof Error ? error.message : String(error);
  const clean = redact(raw);
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/**
 * A URL safe to log: query values dropped entirely, path kept.
 *
 * Whole-value removal rather than selective redaction, because an
 * authorization URL carries the state token and a callback URL carries the
 * authorization code, and both are single-use credentials in a query string.
 */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    const names: string[] = [];
    u.searchParams.forEach((_value, name) => names.push(name));
    for (const name of names) u.searchParams.set(name, REDACTED);
    return u.toString();
  } catch {
    return REDACTED;
  }
}
