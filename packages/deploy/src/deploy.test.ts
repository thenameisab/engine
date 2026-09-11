import { describe, expect, it } from 'vitest';
import type { Action, Diff } from '@engine/core';
import { applyHtmlDiff, applyHtmlActions, applySchemaDiff, applyMetaDiff, applyBodyDiff } from './html.js';
import { applyRobotsActions } from './robots.js';
import { verifyHtmlDeploy, verifyRobotsDeploy, verifyRedirectDeploy, deployChangesTheLivePage } from './verify.js';
import { checkRedirectDeployHealth } from './health.js';

const BASE_HTML = '<html><head><title>Old</title></head><body>hi</body></html>';

function schemaAction(after: string, before = ''): Pick<Action, 'type' | 'diff'> {
  return { type: 'schema', diff: { before, after, format: 'json-ld' } };
}

function metaAction(field: Diff['field'], after: string, before = ''): Pick<Action, 'type' | 'diff'> {
  return { type: 'meta', diff: { before, after, format: 'text', field } };
}

function robotsAction(after: string): Pick<Action, 'type' | 'diff'> {
  return { type: 'robots', diff: { before: '', after, format: 'text' } };
}

describe('applySchemaDiff', () => {
  it('inserts a JSON-LD script before </head> when there is nothing to replace', () => {
    const out = applySchemaDiff(BASE_HTML, { before: '', after: '{"@type":"Organization"}', format: 'json-ld' });
    expect(out).toContain('<script type="application/ld+json">');
    expect(out).toContain('{"@type":"Organization"}');
    expect(out.indexOf('</script>')).toBeLessThan(out.indexOf('</head>'));
  });

  it('replaces an existing block when `before` is found verbatim', () => {
    const html = `<html><head><script type="application/ld+json">{"old":true}</script></head></html>`;
    const out = applySchemaDiff(html, { before: '{"old":true}', after: '{"new":true}', format: 'json-ld' });
    expect(out).toContain('{"new":true}');
    expect(out).not.toContain('{"old":true}');
  });
});

describe('applyMetaDiff', () => {
  it('replaces an existing <title>', () => {
    const out = applyMetaDiff(BASE_HTML, { before: 'Old', after: 'New Title', format: 'text', field: 'title' });
    expect(out).toContain('<title>New Title</title>');
    expect(out).not.toContain('<title>Old</title>');
  });

  it('inserts a description meta tag when none exists', () => {
    const out = applyMetaDiff(BASE_HTML, { before: '', after: 'A description.', format: 'text', field: 'description' });
    expect(out).toContain('<meta name="description" content="A description.">');
  });

  it('escapes HTML-sensitive characters', () => {
    const out = applyMetaDiff(BASE_HTML, { before: 'Old', after: 'Fish & Chips <best>', format: 'text', field: 'title' });
    expect(out).toContain('<title>Fish &amp; Chips &lt;best&gt;</title>');
  });

  it('inserts hreflang link tags before </head>, verbatim (already-escaped by the generator)', () => {
    const tags = '<link rel="alternate" hreflang="en" href="https://acme.com/en/widget">';
    const out = applyMetaDiff(BASE_HTML, { before: '', after: tags, format: 'html', field: 'hreflang' });
    expect(out).toContain(tags);
    expect(out.indexOf(tags)).toBeLessThan(out.indexOf('</head>'));
  });
});

describe('applyHtmlActions', () => {
  it('folds multiple actions over one page in order', () => {
    const out = applyHtmlActions(BASE_HTML, [
      metaAction('title', 'New Title', 'Old'),
      metaAction('description', 'A description.'),
      schemaAction('{"@type":"Organization"}'),
    ]);
    expect(out).toContain('<title>New Title</title>');
    expect(out).toContain('A description.');
    expect(out).toContain('{"@type":"Organization"}');
  });

  it('leaves action types with no live-HTML transform untouched', () => {
    const out = applyHtmlDiff(BASE_HTML, { type: 'robots', diff: { before: '', after: 'irrelevant', format: 'text' } });
    expect(out).toBe(BASE_HTML);
  });
});

describe('applyBodyDiff (internal-link / content on live targets)', () => {
  const html = '<html><body><p>Read our widget guide today.</p></body></html>';

  it('swaps a body block when the diff before is present verbatim', () => {
    const before = '<p>Read our widget guide today.</p>';
    const after = '<p>Read our <a href="/guide">widget guide</a> today.</p>';
    const out = applyHtmlDiff(html, { type: 'internal-link', diff: { before, after, format: 'html' } });
    expect(out).toContain(after);
  });

  it('applies a content rewrite diff the same way', () => {
    const before = '<p>Read our widget guide today.</p>';
    const out = applyHtmlDiff(html, { type: 'content', diff: { before, after: '<p>Rewritten.</p>', format: 'text' } });
    expect(out).toContain('<p>Rewritten.</p>');
  });

  it('is a safe no-op when before is absent (page diverged) rather than blindly appending', () => {
    const out = applyBodyDiff(html, { before: '<p>not on this page</p>', after: '<p>x</p>', format: 'html' });
    expect(out).toBe(html);
  });
});

describe('applyRobotsActions', () => {
  it('returns null when there are no robots actions', () => {
    expect(applyRobotsActions([schemaAction('{}')])).toBeNull();
  });

  it('returns the most recently deployed robots action', () => {
    const out = applyRobotsActions([robotsAction('User-agent: *\nAllow: /\n'), robotsAction('User-agent: GPTBot\nAllow: /\n')]);
    expect(out).toBe('User-agent: GPTBot\nAllow: /\n');
  });
});

describe('verifyHtmlDeploy', () => {
  it('confirms a schema action landed', () => {
    const deployed = applySchemaDiff(BASE_HTML, { before: '', after: '{"@type":"Organization"}', format: 'json-ld' });
    expect(verifyHtmlDeploy(deployed, schemaAction('{"@type":"Organization"}'))).toBe(true);
    expect(verifyHtmlDeploy(BASE_HTML, schemaAction('{"@type":"Organization"}'))).toBe(false);
  });

  it('confirms a title action landed', () => {
    const action = metaAction('title', 'New Title', 'Old');
    const deployed = applyHtmlDiff(BASE_HTML, action);
    expect(verifyHtmlDeploy(deployed, action)).toBe(true);
    expect(verifyHtmlDeploy(BASE_HTML, action)).toBe(false);
  });

  it('confirms a hreflang action landed', () => {
    const action = metaAction('hreflang', '<link rel="alternate" hreflang="en" href="https://acme.com/en/widget">');
    const deployed = applyHtmlDiff(BASE_HTML, action);
    expect(verifyHtmlDeploy(deployed, action)).toBe(true);
    expect(verifyHtmlDeploy(BASE_HTML, action)).toBe(false);
  });
});

describe('verifyRobotsDeploy', () => {
  it('matches modulo surrounding whitespace', () => {
    const action = robotsAction('User-agent: GPTBot\nAllow: /\n');
    expect(verifyRobotsDeploy('User-agent: GPTBot\nAllow: /\n\n', action)).toBe(true);
    expect(verifyRobotsDeploy('User-agent: GPTBot\nDisallow: /\n', action)).toBe(false);
  });
});

function redirectAction(before: string, after: string): Pick<Action, 'type' | 'diff'> {
  return { type: 'redirect', diff: { before, after, format: 'text' } };
}

describe('verifyRedirectDeploy', () => {
  const action = redirectAction('https://acme.com/old', 'https://acme.com/new');

  it('confirms a matching 301 to the expected destination', () => {
    expect(verifyRedirectDeploy({ status: 301, location: 'https://acme.com/new' }, action)).toBe(true);
  });

  it('rejects a redirect to the wrong destination or a non-301 status', () => {
    expect(verifyRedirectDeploy({ status: 301, location: 'https://acme.com/elsewhere' }, action)).toBe(false);
    expect(verifyRedirectDeploy({ status: 302, location: 'https://acme.com/new' }, action)).toBe(false);
  });

  it('rejects a non-redirect action type', () => {
    expect(verifyRedirectDeploy({ status: 301, location: 'https://acme.com/new' }, schemaAction('{}'))).toBe(false);
  });
});

describe('checkRedirectDeployHealth', () => {
  it('is healthy for a real destination different from the source', () => {
    expect(checkRedirectDeployHealth('https://acme.com/old', 'https://acme.com/new')).toEqual({ ok: true });
  });

  it('rejects a self-loop', () => {
    expect(checkRedirectDeployHealth('https://acme.com/x', 'https://acme.com/x')).toEqual({
      ok: false,
      reason: 'redirect-self-loop',
    });
  });

  it('rejects an empty destination', () => {
    expect(checkRedirectDeployHealth('https://acme.com/x', '')).toEqual({
      ok: false,
      reason: 'redirect-empty-destination',
    });
  });
});

/**
 * Which target kinds a deploy can be verified against by fetching a page.
 *
 * The verify enqueue used to fire for every kind. For a `github-pr` fix that
 * meant checking the page the moment the pull request opened — before anyone
 * had merged it — so the card said "not found on the page yet" about a fix
 * nobody had rejected. This is the rule that stopped it.
 */
describe('deployChangesTheLivePage', () => {
  it('is true for the two targets that apply the diff during the deploy', () => {
    expect(deployChangesTheLivePage('edge-worker')).toBe(true);
    expect(deployChangesTheLivePage('cms-plugin')).toBe(true);
  });

  it('is false for a PR, which only opens a pull request', () => {
    expect(deployChangesTheLivePage('github-pr')).toBe(false);
  });

  it('is false for a Business Profile write, which is not a page at all', () => {
    expect(deployChangesTheLivePage('gbp-api')).toBe(false);
  });
});
