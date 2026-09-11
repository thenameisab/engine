import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const SRC = fileURLToPath(new URL('.', import.meta.url));

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

  it('makes el.hidden beat any class that sets display', () => {
    // The UA's own `[hidden] { display: none }` loses to every author rule, so
    // a class with a `display` leaves a hidden element on screen. The
    // stylesheet patched that per class twice and missed `.intg-planned-grid`,
    // which shipped the planned-integrations disclosure permanently open.
    expect(css).toMatch(/^\[hidden\] \{[^}]*display:\s*none\s*!important/m);
  });

  it('has no per-class [hidden] patches left, which is what the global rule replaced', () => {
    // A new one means someone hit the trap again and treated it as local.
    const patches = [...css.matchAll(/^\.[\w-]+\[hidden\]\s*\{/gm)].map((m) => m[0]);
    expect(patches).toEqual([]);
  });

  it('sets visibility with el.hidden rather than style.display', () => {
    // `style.display` is an inline style, which beats the rule above and puts
    // two mechanisms in charge of one element's visibility. Scanned across the
    // whole source tree, not just `views/`: the deploy-target form is a shared
    // module a level above it and was the last place doing this.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (/\.style\.display\s*=/.test(readFileSync(full, 'utf8'))) offenders.push(entry.name);
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });

  it('drops the workspace track on a phone even with the no-clients class', () => {
    // A media query adds no specificity. `.app.no-clients` is two classes and
    // `.app.no-clients.rail-collapsed` is three, so both beat the `.app` rule
    // inside `@media (max-width: 860px)` and would keep a sidebar track on a
    // phone unless the mobile rule names them too.
    const start = css.indexOf('@media (max-width: 860px) {\n  /* `.app.no-clients`');
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}', css.indexOf('.app,', start)));
    expect(rule).toContain('.app.no-clients');
    expect(rule).toContain('.app.no-clients.rail-collapsed');
    expect(rule).toContain('grid-template-columns: 1fr');
  });

  /* ── The one list-row grammar ────────────────────────────────────────── */

  it('gives the five list rows one declaration, not five', () => {
    // The whole point of the merge: `display: grid` and the alignment are
    // stated once. A row class that re-declares `display` has left the
    // grammar, and its numbers are free to drift again.
    expect(css).toMatch(/^\.gm-row, \.kw-row, \.ci-row, \.off-row, \.ci-lead-row \{/m);
    for (const cls of ['gm-row', 'kw-row', 'ci-row', 'off-row', 'ci-lead-row']) {
      const own = css.match(new RegExp(`^\\.${cls} \\{[^}]*\\}`, 'm'))?.[0] ?? '';
      expect(own).not.toMatch(/display:\s*(grid|flex)/);
      expect(own).not.toMatch(/grid-template-columns:/);
    }
  });

  it('sizes every row track through --lrow-cols, never a bare track list', () => {
    // A rule that sets `grid-template-columns` on one of these bypasses the
    // grammar's `var(--lrow-cols)` and cannot be read from the variant list.
    const offenders = [...css.matchAll(/^[^\n{]*\.(gm-row|kw-row|ci-row|off-row|ci-lead-row)[^\n{]*\{([^}]*)\}/gm)]
      .filter((m) => /grid-template-columns:(?!\s*var\(--lrow-cols)/.test(m[2]))
      .map((m) => m[0].split('{')[0].trim());
    expect(offenders).toEqual([]);
  });

  it('has a track list for every row variant the views ask for', () => {
    // A view can add `gm-row gm-x` and get the grammar with no tracks, which
    // renders as one column and looks like a data bug rather than a CSS one.
    const used = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(/class: '(?:gm-row|kw-row) ([a-z0-9-]+)'/g)) used.add(m[1]);
        }
      }
    };
    walk(SRC);
    expect(used.size).toBeGreaterThan(0);
    for (const variant of used) {
      expect(css, `no --lrow-cols for .${variant}`).toMatch(
        new RegExp(`\\.${variant} \\{[^}]*--lrow-cols:`),
      );
    }
  });

  it('keeps the stat cell label box that holds numbers on one line', () => {
    // `.cell .top` reserves 32px so a label wrapping to two lines does not
    // push its own number a line below its neighbours'. The Google panels
    // used to opt out with `min-height: 0`, which is exactly what made
    // "Engaged sessions" sit lower than "Sessions" beside it.
    expect(css).toMatch(/^\.cell \.top \{[^}]*min-height:\s*32px/m);
    expect(css).not.toMatch(/\.gm-stats \.cell \.top \{[^}]*min-height:\s*0/);
  });

  it('has no .row rule left to be confused for the grammar', () => {
    // `.row` was dead — no view built one — and a generic name beside a real
    // row grammar is a trap for the next person.
    expect(css).not.toMatch(/^\.row[\s,{:]/m);
  });

  it('defines every token the stylesheet spends', () => {
    // Tokens are declared several to a line, so this cannot anchor to the
    // line start. A use is `var(--x)` and carries no colon, so matching on
    // the colon separates declarations from uses without a second pass.
    const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect([...used].filter((t) => !declared.has(t))).toEqual([]);
  });

  it('states what a panel shows instead of its content in exactly four classes', () => {
    // Six classes used to say the same thing in six registers, and the one
    // that won was named after the fix queue. `.fq-note` priced a one-line
    // message as a centred full-height panel, so Home's visibility block
    // spent a bordered box the height of a chart to say nothing was measured.
    expect(css).toMatch(/^\.loading, \.emptybox, \.errbox, \.notebox \{/m);
    for (const dead of ['fq-note', 'gm-empty', 'lane-empty', 'serp-empty', 'copilot-empty', 'intg-note']) {
      expect(css).not.toMatch(new RegExp(`\\.${dead}[\\s,{:.]`));
    }
  });

  it('never centres a state, and never reserves height to say one sentence', () => {
    // The whole point of the pass: a sentence costs a sentence. A scoped
    // override may retune padding for a container that already pads itself,
    // but none of them may centre the text or set a height.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...bare.matchAll(/^[^\n@}]*\.(?:emptybox|errbox|notebox)\b[^{]*\{([^}]*)\}/gm)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, body] of rules) {
      expect(body).not.toMatch(/text-align:\s*center/);
      expect(body).not.toMatch(/(?:^|;)\s*(?:min-)?height:/);
    }
  });

  it('builds no retired state class anywhere in the source tree', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          if (/\b(?:fq-note|gm-empty|lane-empty|serp-empty|copilot-empty|intg-note)\b/.test(readFileSync(full, 'utf8'))) {
            offenders.push(entry.name);
          }
        }
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
  it('sizes the layout on exactly three named breakpoints', () => {
    // Seven values meant a rule's breakpoint was whatever the author had in
    // mind that day, and 620/640 in particular were a second phone width
    // sitting 60px from the first. Layout pass 5c moved every rule onto the
    // nearest of three. The set is the assertion; the number of blocks at
    // each value is not, because a rule stays where it sits in the cascade.
    const widths = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(widths.length).toBeGreaterThan(0);
    expect([...new Set(widths)].sort((a, b) => a - b)).toEqual([560, 860, 1080]);
  });

  it('lets exactly one field per flex row absorb the slack', () => {
    // `.serp-form-row .field { flex: 1 }` priced a two-letter country select
    // as wide as the domain input beside it. A field now takes its own width
    // and the one marked `.grow` takes the rest.
    expect(css).toMatch(/\.serp-form-row \.field \{[^}]*flex: none/);
    expect(css).toMatch(/\.serp-form-row \.field\.grow \{[^}]*flex: 1/);
    // Exactly one element in the row may wear it.
    const serp = readFileSync(join(SRC, 'views/serp.ts'), 'utf8');
    expect([...serp.matchAll(/class: 'field grow'/g)]).toHaveLength(1);
  });

  it('declares the flex that .flabel.check overrides', () => {
    // The variant set `flex-direction` and `gap` while `.flabel` set no
    // display at all, so for 28 text-only labels that was correct and for the
    // one that wraps a checkbox it styled nothing.
    const rule = css.match(/^\.flabel\.check \{([^}]*)\}/m);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/display:\s*flex/);
  });

  it('gives the five dimension cards two tracks and spans the fifth', () => {
    // `auto-fit` made four tracks at the 1180px content width and left the
    // fifth card alone at a quarter of it.
    expect(css).not.toMatch(/\.ci-tables \{[^}]*auto-fit/);
    expect(css).toMatch(/\.ci-tables \{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.ci-table:nth-child\(5\) \{[^}]*grid-column: 1 \/ -1/);
    // The span is only correct because the card count is fixed at five.
    const view = readFileSync(join(SRC, 'views/competitors.ts'), 'utf8');
    const order = view.match(/const ORDER: GapType\[\] = \[([^\]]*)\]/);
    expect(order).not.toBeNull();
    expect(order![1].split(',').filter((x) => x.trim()).length).toBe(5);
  });

  it('reserves the blurb two lines so the cards match in height', () => {
    // Clamping alone would still let a one-line blurb shorten its card.
    const rule = css.match(/^\.ci-blurb \{([^}]*)\}/m);
    expect(rule).not.toBeNull();
    expect(rule![1]).toMatch(/-webkit-line-clamp: 2/);
    expect(rule![1]).toMatch(/min-height: 3em/);
  });

  it('labels every control in a row or none of them', () => {
    // Competitors had two labelled controls and two bare buttons on one line.
    const view = readFileSync(join(SRC, 'views/competitors.ts'), 'utf8');
    const row = view.match(/class: 'ci-controls' \}, \[([^\]]*)\]/);
    expect(row).not.toBeNull();
    expect(row![1]).not.toMatch(/ci-lbl/);
    // Dropping the visible label is only honest if the control still names
    // itself to a screen reader.
    expect(view).toMatch(/class: 'ci-select', 'aria-label'/);
  });
});
