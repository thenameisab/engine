import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Claims about the product's shape that are true today and easy to make false.
 *
 * Each of these is something the Driver build decided on purpose, where the way
 * back is a single edit nobody would question at review. A grep is a poor
 * substitute for a rendered check, and it is the substitute that exists: the
 * screens have no DOM test harness, and #105's deleted base rules are the
 * standing evidence that "the build was clean" is not the same as "the product
 * is right".
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

function read(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

describe('one rendering of one object', () => {
  /**
   * Two files build a `.fgroup` that is not a finding, each for a stated
   * reason. Listed rather than pattern-matched, so a third one has to be
   * argued for here before it can exist.
   */
  const NOT_A_FINDING = [
    // Brand strength is a standing measure, not an issue. It borrows the
    // group's shape to sit in the same list and carries its score where an
    // issue carries a severity chip — and it takes no word from the severity
    // vocabulary, which is why it cannot be a `FindingGroup`.
    'views/audit.ts',
    // The loading placeholder, which is a lookalike by definition.
    'skeleton.ts',
  ];

  it('builds a finding group in exactly one place', () => {
    // §4.5: "a finding shown in Driver should be the same row a customer clicks
    // in Findings, with the same actions on it. Two different renderings of the
    // same object is how a product starts to feel like two products." A second
    // hand-built `.fgroup` would look identical on the day it was written and
    // drift on the next change to either screen.
    const builders = sourceFiles(SRC)
      .filter((f) => /class: 'fgroup'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length))
      .filter((f) => !NOT_A_FINDING.includes(f));
    expect(builders).toEqual(['findingGroup.ts']);
  });

  it('has no exception left over from a file that stopped building one', () => {
    const present = sourceFiles(SRC)
      .filter((f) => /class: 'fgroup'/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length));
    expect(NOT_A_FINDING.filter((f) => !present.includes(f))).toEqual([]);
  });

  it('has both screens go through that one builder', () => {
    expect(read('views/audit.ts')).toContain('findingGroupBlock(');
    expect(read('driverParts.ts')).toContain('findingGroupBlock(');
  });

  it('builds a fix card only where the Fix Queue’s own classes are used', () => {
    // Driver's fix block uses `.card` deliberately, and cannot use the Fix
    // Queue's `card()`: that card's middle is the diff, and the `fix_queue`
    // tool returns no diff. The rule this keeps is narrower than the findings
    // one — Driver must not grow a diff renderer of its own, because a diff
    // rendered from data the tool did not return would be invented.
    expect(read('driverParts.ts')).not.toContain('card-diff');
    expect(read('driverParts.ts')).not.toContain('difflines');
  });
});

describe('the rail', () => {
  it('puts Ask first, above the six questions', () => {
    const shell = read('shell.ts');
    const routes = shell.slice(shell.indexOf('const ROUTES: Route[] = ['), shell.indexOf('];', shell.indexOf('const ROUTES')));
    const ids = [...routes.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1]);
    expect(ids).toEqual(['driver', 'home', 'findings', 'fixes', 'visibility', 'integrations', 'settings']);
  });

  it('reads the selected project on Ask, like the other data screens', () => {
    // Without this, Driver renders its composer against no project and every
    // question 400s on a missing id. The shell sends the customer to Set up
    // instead, which is what the other four do.
    expect(read('shell.ts')).toContain("PROJECT_ROUTES = new Set(['driver'");
  });
});

describe('one place to ask', () => {
  it('leaves no second ask bar posting to the deterministic route', () => {
    // The palette used to hold its own ask bar on `/ai/stream` in 'ask' mode,
    // so the product had two places to type a question that answered
    // differently and no way to tell which had answered. The engine underneath
    // is unchanged — §4.8 keeps `packages/copilot` as Driver's fallback — but
    // it is reached through Driver now, not beside it.
    // `api.ts` still declares the mode, because `POST /ai/stream` still serves
    // it and `streamAi` is shared with "Try a prompt". What must not come back
    // is a screen that calls it: the declaration is a route the product can
    // reach, a caller is a second front door.
    const askers = sourceFiles(SRC)
      .filter((f) => !f.endsWith('/api.ts'))
      .filter((f) => /mode: 'ask'/.test(readFileSync(f, 'utf8')));
    expect(askers.map((f) => f.slice(SRC.length))).toEqual([]);
  });

  it('sends the floating bar and the palette to the same place', () => {
    expect(read('askBar.ts')).toContain('askInDriver(');
    expect(read('palette.ts')).toContain('askInDriver(');
  });

  it('keeps a typed question out of the browser’s history', () => {
    // `askInDriver` carries the question in memory. Putting it in the hash
    // would write a customer's question about their own revenue into browser
    // history, and into anything that reads it.
    const driver = read('views/driver.ts');
    expect(driver).toMatch(/let pendingQuestion: string \| null = null;/);
    expect(driver).not.toMatch(/location\.hash = .*\$\{question/);
  });
});

describe('the Driver call', () => {
  it('does not go through the 8-second request helper', () => {
    // `request` aborts at 8,000 ms and the loop's budget is 45,000. A client
    // that gave up first would abandon most four-round turns, report them as
    // failures, and leave the server paying for rounds nobody is waiting for.
    const api = read('api.ts');
    const ask = api.slice(
      api.indexOf('export async function askDriver'),
      api.indexOf('export function fetchDriverThreads'),
    );
    expect(ask).toContain('DRIVER_CLIENT_TIMEOUT_MS');
    expect(ask).not.toMatch(/request</);
  });

  it('waits longer than the server’s own deadline, not shorter', () => {
    const api = read('api.ts');
    const wall = Number(api.match(/const DRIVER_WALL_CLOCK_MS = ([\d_]+);/)![1].replace(/_/g, ''));
    const client = api.match(/const DRIVER_CLIENT_TIMEOUT_MS = DRIVER_WALL_CLOCK_MS \+ ([\d_]+);/);
    expect(wall).toBe(45000);
    expect(Number(client![1].replace(/_/g, ''))).toBeGreaterThan(0);
  });

  it('takes the session token from the one function that knows both sources', () => {
    // Two identical bugs have come from a hand-rolled fetch re-deriving the
    // token and reaching only for the Google path, which answers "missing
    // bearer token" to every password user. It happened to the branded report
    // and then again to Sync now.
    const api = read('api.ts');
    const ask = api.slice(api.indexOf('export async function askDriver'), api.indexOf('export function fetchDriverThreads'));
    expect(ask).toContain('await authToken()');
  });
});
