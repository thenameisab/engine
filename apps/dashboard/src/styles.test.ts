import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The stylesheet's base rules, asserted rather than assumed.
 *
 * These went missing in #105: a scripted edit that moved a block to the end
 * of the file sliced from an inserted comment to the `/* layout *\/` marker
 * and took the two rules sitting between them with it. Nothing failed, the
 * build was clean, and the screenshot walk missed it because every link on
 * the screens walked sets its own colour — so the regression reached
 * production, where every other `<a>` rendered in the browser's default blue
 * with an underline.
 *
 * A rendered check would be better and needs a browser. This is the cheap
 * version: the rules a whole product depends on should not be deletable in
 * silence.
 */
const css = readFileSync(fileURLToPath(new URL('../styles.css', import.meta.url)), 'utf8');

describe('styles.css base rules', () => {
  it('gives every link its context colour instead of the browser default', () => {
    expect(css).toMatch(/^a \{[^}]*color:\s*inherit/m);
    expect(css).toMatch(/^a \{[^}]*text-decoration:\s*none/m);
  });

  it('keeps the unscoped .label rule the whole product reads from', () => {
    expect(css).toMatch(/^\.label \{/m);
  });

  it('draws the sign-in screen on the tokens, not on literal colours', () => {
    // The block used to be ninety lines of hex and rgba that ignored
    // `data-theme`, so the first screen of the product had its own palette.
    const start = css.indexOf('/* ===== auth screen');
    expect(start).toBeGreaterThan(-1);
    const end = css.indexOf('/* ===== end auth screen', start);
    expect(end).toBeGreaterThan(start);
    const block = css.slice(start, end);
    expect(block).toMatch(/^\.auth-screen \{/m);
    expect(block.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
    expect(block).not.toMatch(/font-size:\s*[0-9.]+px/);
  });

  it('spends the type scale rather than literal pixel sizes', () => {
    // #105 declared `--t-*` and converted the shell; 149 declarations went on
    // spending literals, in seventeen distinct sizes, several of them
    // half-pixel neighbours of each other. That is not hierarchy a reader can
    // use, and nothing failed while it was true. This is what makes the scale
    // the only way to set a size.
    const literals = [...css.matchAll(/font-size:\s*[0-9.]+px/g)].map((m) => m[0]);
    expect(literals).toEqual([]);
  });

  it('keeps the scale at nine steps', () => {
    // A tenth step should be a decision someone makes on purpose, not a size
    // that appears because one screen wanted something in between.
    const steps = [...css.matchAll(/--t-([a-z0-9]+)\s*:\s*([0-9.]+)px/g)].map((m) => `--t-${m[1]}:${m[2]}px`);
    expect(steps).toEqual([
      '--t-3xs:10px',
      '--t-2xs:11px',
      '--t-xs:12px',
      '--t-sm:13px',
      '--t-md:14px',
      '--t-lg:16px',
      '--t-xl:20px',
      '--t-2xl:26px',
      '--t-3xl:34px',
    ]);
  });

  it('keeps the loading skeleton on tokens, delayed, and off under reduced motion', () => {
    // Every route renders it, so these three are product-wide. The delay is
    // the one a reader would never miss until it is gone: without it a route
    // answering from cache flashes grey for one frame.
    const start = css.indexOf('/* \u2500\u2500 Loading skeletons');
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start);
    expect(block).toMatch(/\.skel-body \{[^}]*animation: skel-in [0-9]+ms var\(--ease-out\) 140ms both/);
    expect(block.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
    const reduced = block.slice(block.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.skel-bar \{[^}]*animation: none/);
  });

  it('defines every token the stylesheet spends', () => {
    // Tokens are declared several to a line, so this cannot anchor to the
    // line start. A use is `var(--x)` and carries no colon, so matching on
    // the colon separates declarations from uses without a second pass.
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !declared.has(t))).toEqual([]);
  });
});
