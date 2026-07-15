import { describe, expect, it } from 'vitest';
import { checkHtmlDeployHealth, checkJsonLdValidity, checkRobotsDeployHealth } from './health.js';

const BEFORE = '<html><head><title>Acme</title></head><body>'.padEnd(200, 'x') + '</body></html>';

describe('checkHtmlDeployHealth', () => {
  it('flags an origin 5xx before even looking at the transform', () => {
    expect(checkHtmlDeployHealth(503, BEFORE, BEFORE).ok).toBe(false);
    expect(checkHtmlDeployHealth(503, BEFORE, BEFORE).reason).toBe('origin-error-503');
  });

  it('passes a healthy transform that only grows the page', () => {
    const after = BEFORE.replace('</body>', '<p>extra</p></body>');
    expect(checkHtmlDeployHealth(200, BEFORE, after)).toEqual({ ok: true });
  });

  it('flags a transform that drastically shrinks the page', () => {
    const after = '<html></html>';
    const result = checkHtmlDeployHealth(200, BEFORE, after);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('transform-shrunk-page');
  });

  it('flags mangled JSON-LD even when size looks fine', () => {
    const after = BEFORE.replace('</head>', '<script type="application/ld+json">{not valid json</script></head>');
    const result = checkHtmlDeployHealth(200, BEFORE, after);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-json-ld');
  });
});

describe('checkJsonLdValidity', () => {
  it('accepts valid JSON-LD and multiple blocks', () => {
    const html = '<script type="application/ld+json">{"a":1}</script><script type="application/ld+json">{"b":2}</script>';
    expect(checkJsonLdValidity(html)).toEqual({ ok: true });
  });

  it('accepts HTML with no JSON-LD at all', () => {
    expect(checkJsonLdValidity('<html></html>')).toEqual({ ok: true });
  });
});

describe('checkRobotsDeployHealth', () => {
  it('flags an empty robots.txt', () => {
    expect(checkRobotsDeployHealth(200, '   ').ok).toBe(false);
  });

  it('flags text with no User-agent line', () => {
    expect(checkRobotsDeployHealth(200, 'Sitemap: https://acme.com/sitemap.xml').reason).toBe('robots-malformed');
  });

  it('passes a well-formed robots.txt', () => {
    expect(checkRobotsDeployHealth(200, 'User-agent: GPTBot\nAllow: /\n')).toEqual({ ok: true });
  });
});
