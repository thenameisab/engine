import { describe, expect, it } from 'vitest';
import type { Account } from '@engine/core';
import { renderAccountReportHtml } from './report.js';

const account: Account = {
  id: 'acc-1',
  name: 'Acme Agency',
  branding: {},
  createdAt: new Date().toISOString(),
};

describe('renderAccountReportHtml', () => {
  it('renders a project row with real scores', () => {
    const html = renderAccountReportHtml(account, [
      { id: 'p1', name: 'Acme Corp', domain: 'acme.example', healthScore: 82, unifiedScore: 71, keywordsTracked: 12, citationSamples: 5 },
    ]);
    expect(html).toContain('Acme Corp');
    expect(html).toContain('acme.example');
    expect(html).toContain('82');
    expect(html).toContain('71');
  });

  it('renders "not measured yet" instead of a misleading 0 for an unaudited project', () => {
    const html = renderAccountReportHtml(account, [
      { id: 'p1', name: 'New Client', domain: 'new.example', healthScore: null, unifiedScore: null, keywordsTracked: 0, citationSamples: 0 },
    ]);
    const naCount = (html.match(/not measured yet/g) ?? []).length;
    expect(naCount).toBe(2); // unified score + technical health, neither defaulted to a misleading 0
  });

  it('escapes caller-supplied branding/name text', () => {
    const html = renderAccountReportHtml(
      { ...account, branding: { companyName: '<script>alert(1)</script>' } },
      [],
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('uses the branding logo when present, else a fallback initial', () => {
    const withLogo = renderAccountReportHtml({ ...account, branding: { logoUrl: 'https://acme.example/logo.png' } }, []);
    expect(withLogo).toContain('<img src="https://acme.example/logo.png"');

    const withoutLogo = renderAccountReportHtml(account, []);
    expect(withoutLogo).toContain('logo-fallback');
  });
});
