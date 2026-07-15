import { describe, expect, it } from 'vitest';
import type { Action, Diff } from '@engine/core';
import { applyHtmlDiff, applyHtmlActions, applySchemaDiff, applyMetaDiff } from './html.js';
import { applyRobotsActions } from './robots.js';
import { verifyHtmlDeploy, verifyRobotsDeploy } from './verify.js';

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

  it('leaves non schema/meta action types untouched', () => {
    const out = applyHtmlDiff(BASE_HTML, { type: 'robots', diff: { before: '', after: 'irrelevant', format: 'text' } });
    expect(out).toBe(BASE_HTML);
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
});

describe('verifyRobotsDeploy', () => {
  it('matches modulo surrounding whitespace', () => {
    const action = robotsAction('User-agent: GPTBot\nAllow: /\n');
    expect(verifyRobotsDeploy('User-agent: GPTBot\nAllow: /\n\n', action)).toBe(true);
    expect(verifyRobotsDeploy('User-agent: GPTBot\nDisallow: /\n', action)).toBe(false);
  });
});
