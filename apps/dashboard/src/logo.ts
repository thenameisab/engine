/**
 * Vendor logos, from logo.dev's image API.
 *
 * One module rather than an `<img>` built at each call site, because three
 * things have to be right every time and are easy to get wrong once: the token
 * must never be pasted into a view, a logo that fails to load must not leave a
 * broken-image glyph in a card header, and a vendorless integration must not
 * request a logo at all.
 *
 * The token is a *publishable* key. logo.dev issues it for exactly this use —
 * it is readable by anyone who opens devtools on any site using the service,
 * and it grants nothing but logo lookups. It is committed for the same reason
 * `AUTH_JWKS_URL` is: a value that must reach the browser is not made safer by
 * being routed through an environment variable, and a default that works means
 * a fresh checkout renders correctly with no configuration. A deployment that
 * wants its own account overrides it with `ENGINE_LOGO_TOKEN` at build time,
 * mirroring how `ENGINE_API_BASE` is supplied.
 */

declare global {
  interface Window {
    /** logo.dev publishable key, written into the page by `scripts/assembleSite.mjs`. */
    ENGINE_LOGO_TOKEN?: string;
  }
}

const DEFAULT_TOKEN = 'pk_FbB1eTBFQSCfscytM00Kbg';

function token(): string {
  const baked = typeof window !== 'undefined' ? window.ENGINE_LOGO_TOKEN : undefined;
  return baked && baked.trim() !== '' ? baked.trim() : DEFAULT_TOKEN;
}

/**
 * The rendered size in CSS pixels. Requested at 2x so the mark stays sharp on
 * a retina display; `retina=true` is logo.dev's own flag for the same thing and
 * both are sent because the parameter has changed name across their docs.
 */
const RENDER_PX = 28;

export function logoUrl(domain: string, px: number = RENDER_PX): string {
  const params = new URLSearchParams({
    token: token(),
    size: String(px * 2),
    format: 'png',
    retina: 'true',
    // A domain logo.dev has never seen returns a generated monogram rather than
    // a 404, so a new integration looks deliberate on the day it is added
    // instead of looking broken until someone notices.
    fallback: 'monogram',
  });
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${params.toString()}`;
}

/**
 * A logo tile for `domain`, or a monogram of `name` when there is no vendor.
 *
 * The tile keeps a light face in both themes. Brand marks are drawn for a light
 * background and many are dark-on-transparent, so painting them onto the dark
 * theme's near-black surface would erase roughly half of them.
 */
export function logoTile(domain: string, name: string): HTMLElement {
  const tile = document.createElement('span');
  tile.className = 'logo-tile';

  if (!domain) {
    tile.classList.add('mono');
    tile.textContent = monogram(name);
    return tile;
  }

  const img = document.createElement('img');
  img.src = logoUrl(domain);
  img.width = RENDER_PX;
  img.height = RENDER_PX;
  img.loading = 'lazy';
  // Decorative: the integration's name is always rendered beside it, so an
  // alt text here would make a screen reader announce the same word twice.
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  // logo.dev is reachable from the browser, not from every network the product
  // runs on. On failure, fall back to the monogram rather than leaving the
  // browser's broken-image icon in a card header.
  img.addEventListener('error', () => {
    tile.classList.add('mono');
    tile.replaceChildren(document.createTextNode(monogram(name)));
  });

  tile.append(img);
  return tile;
}

/** First letters of the first two words — "Credential sign-in" becomes "CS". */
function monogram(name: string): string {
  const letters = name
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '');
  return letters.join('') || '?';
}
