import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The word "client", counted rather than assumed.
 *
 * `accounts.kind` has been stored since 0035 and read by one panel, so a
 * company with one site was still told to pick a client, search clients, and
 * go to a Clients grid it cannot reach. Sixteen strings said it whatever kind
 * of account the reader had.
 *
 * The strings that remain are listed here one by one, each under the reason it
 * survives: it is an OAuth client, which is a different thing with the same
 * name; or it sits behind `AccountVocabulary.agency`, where the word is
 * correct. A new hardcoded "client" fails this test, which is the point — the
 * gate is easy to add and easy to forget.
 *
 * Prose only: a literal with no space in it is a route id, a CSS class, a
 * storage key or a URL path, none of which a customer reads.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Comments explain the gate; they are not what the customer reads. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

function proseLiterals(text: string): string[] {
  const out: string[] = [];
  for (const match of stripComments(text).match(LITERAL) ?? []) {
    // `${…}` is an expression, not words: without this, `view.client.updatedAt`
    // inside a template literal reads as the noun.
    const inner = match.slice(1, -1).replace(/\$\{[^{}]*\}/g, '…');
    if (inner.includes(' ')) out.push(inner);
  }
  return out;
}

/** An OAuth client is a registration in a vendor console, not an account. */
const OAUTH_CLIENT = [
  'An admin also sees this screen, Engine’s OAuth client, and the platform readiness report.',
  'Client ID',
  'Client secret',
  'Engine’s own OAuth clients, this deployment’s vendor keys, the user list and the setup checklist.',
  'Google OAuth client',
  'Google’s OAuth client below',
  'Make … a platform admin? They will be able to replace Engine’s OAuth client and create further admins.',
  'Paste this into Authorised redirect URIs on the OAuth client in Google Cloud Console.',
  'Register the client under ….',
];

/**
 * Behind `AccountVocabulary.agency`, or on the Clients grid, which the shell
 * redirects away from when no account is an agency.
 */
const AGENCY_ONLY = [
  '+ New client',
  'Add a client',
  'An agency’s client',
  'Client name',
  'Could not load your clients: …',
  'Enter the client’s name.',
  'Every client you manage, with its real projects and branded reporting.',
  'Go to Clients',
  'New client…',
  'No clients yet. Add one to get started.',
  'No clients yet. Create one to get started.',
  'No projects yet for this client.',
  'Pick a client from the Clients grid first.',
  'Search clients and sites',
  'Switch client or site',
];

/**
 * Settings' account-type control, which is the one place a non-agency is meant
 * to read the word.
 *
 * The rule these lists enforce is that a company is never handed "client" as
 * *its own* vocabulary. Choosing what kind of account you are is the exception:
 * the option has to say what an agency is, to someone who is not one yet, or
 * the choice cannot be made. Defining the term, not adopting it.
 */
const ACCOUNT_TYPE_CHOICE = [
  'An agency — we manage clients',
  'An agency has clients, each with its own sites and its own connections. A company or one person has sites directly.',
];

/** A class attribute that happens to contain a space. */
const CLASS_NAMES = ['panel client-card'];

const ALLOWED = new Set([...OAUTH_CLIENT, ...AGENCY_ONLY, ...ACCOUNT_TYPE_CHOICE, ...CLASS_NAMES]);

describe('the word "client"', () => {
  it('appears only where an agency reads it, or where it means an OAuth client', () => {
    const unexplained: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const literal of proseLiterals(readFileSync(file, 'utf8'))) {
        if (!/\bclients?\b/i.test(literal)) continue;
        if (ALLOWED.has(literal)) continue;
        unexplained.push(`${file.slice(SRC.length)}: ${literal}`);
      }
    }
    expect(unexplained).toEqual([]);
  });

  it('has no allowlist entry left over from a string that is gone', () => {
    const present = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const literal of proseLiterals(readFileSync(file, 'utf8'))) present.add(literal);
    }
    expect([...ALLOWED].filter((a) => !present.has(a))).toEqual([]);
  });
});
