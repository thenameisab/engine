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

  it('defines every token the stylesheet spends', () => {
    // Tokens are declared several to a line, so this cannot anchor to the
    // line start. A use is `var(--x)` and carries no colon, so matching on
    // the colon separates declarations from uses without a second pass.
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !declared.has(t))).toEqual([]);
  });
});
