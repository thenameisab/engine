import { describe, it, expect } from 'vitest';
import { PROVIDERS, getProvider, listProviders, assertConnectable, allProviderIds } from './registry.js';
import { IntegrationError } from './errors.js';

describe('registry invariants', () => {
  it('has unique ids', () => {
    expect(new Set(allProviderIds()).size).toBe(PROVIDERS.length);
  });

  it('uses ids that are safe as a URL path segment and a database value', () => {
    // Provider ids are persisted and appear in routes. A change breaks stored
    // rows, so the shape is constrained now rather than discovered later.
    for (const p of PROVIDERS) expect(p.id).toMatch(/^[a-z][a-z0-9-]{1,40}$/);
  });

  it('gives every provider a purpose, a logo domain and a resource noun', () => {
    for (const p of PROVIDERS) {
      expect(p.purpose.length, `${p.id} purpose`).toBeGreaterThan(10);
      expect(p.logoDomain, `${p.id} logoDomain`).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(p.resourceNoun.length, `${p.id} resourceNoun`).toBeGreaterThan(0);
    }
  });

  it('declares at least one required scope for every OAuth provider', () => {
    // A provider with no scopes would request nothing and connect successfully
    // to an account it cannot read.
    for (const p of PROVIDERS) {
      if (p.auth.kind === 'oauth2') expect(p.auth.scopes.length, `${p.id}`).toBeGreaterThan(0);
    }
  });

  it('declares at least one secret field for every API-key provider', () => {
    for (const p of PROVIDERS) {
      if (p.auth.kind === 'api_key') {
        expect(p.auth.fields.some((f) => f.secret), `${p.id}`).toBe(true);
      }
    }
  });

  it('uses https for every vendor endpoint', () => {
    // A token or an API key must never leave over plaintext.
    for (const p of PROVIDERS) {
      if (p.auth.kind === 'oauth2') {
        expect(p.auth.authorizationUrl.startsWith('https://'), `${p.id} authorizationUrl`).toBe(true);
        expect(p.auth.tokenUrl.startsWith('https://'), `${p.id} tokenUrl`).toBe(true);
        if (p.auth.revocationUrl) expect(p.auth.revocationUrl.startsWith('https://')).toBe(true);
      } else if (p.auth.verifyUrl) {
        expect(p.auth.verifyUrl.startsWith('https://'), `${p.id} verifyUrl`).toBe(true);
      }
    }
  });

  it('compiles every declared field pattern', () => {
    for (const p of PROVIDERS) {
      if (p.auth.kind !== 'api_key') continue;
      for (const f of p.auth.fields) {
        if (f.pattern) expect(() => new RegExp(`^(?:${f.pattern})$`), `${p.id}.${f.name}`).not.toThrow();
      }
    }
  });

  it('marks a write-capable provider honestly', () => {
    // The consent screen and the connect UI both key off this. A provider that
    // holds a write scope while claiming read-only misleads the customer.
    const gbp = getProvider('gbp');
    expect(gbp?.writes).toBe(true);
    expect(getProvider('gsc')?.writes).toBe(false);
  });

  it('attaches a location to an entity and a site-wide property to a project', () => {
    expect(getProvider('gbp')?.resourceScope).toBe('entity');
    expect(getProvider('gsc')?.resourceScope).toBe('project');
    expect(getProvider('ga4')?.resourceScope).toBe('project');
  });
});

describe('listProviders', () => {
  it('hides planned providers by default', () => {
    const live = listProviders();
    expect(live.every((p) => p.availability !== 'planned')).toBe(true);
    expect(live.map((p) => p.id).sort()).toEqual([
      'bing-webmaster',
      'cloudflare',
      'ga4',
      'gbp',
      'github',
      'gsc',
      'serper',
    ]);
  });

  it('includes them when asked, so the UI can show what is coming', () => {
    expect(listProviders({ includePlanned: true }).length).toBe(PROVIDERS.length);
  });
});

describe('assertConnectable', () => {
  it('resolves an available provider', () => {
    expect(assertConnectable('gsc').id).toBe('gsc');
  });

  it('refuses an unknown id', () => {
    try {
      assertConnectable('not-a-provider');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect((e as IntegrationError).reason).toBe('unknown_provider');
    }
  });

  it('refuses a planned provider — a roadmap row is not a connectable one', () => {
    expect(() => assertConnectable('hubspot')).toThrow(/not available to connect yet/);
  });
});
