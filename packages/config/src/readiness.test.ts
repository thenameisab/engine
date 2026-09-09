import { describe, it, expect } from 'vitest';
import { evaluateReadiness, evaluateIntegration } from './readiness.js';
import { getIntegration, INTEGRATIONS } from './integrations.js';

/** A fully-configured env for every required var across all integrations. */
function fullEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const integration of INTEGRATIONS) {
    for (const v of integration.env) {
      if (v.required) env[v.name] = v.example ?? 'set';
    }
  }
  return env;
}

describe('evaluateIntegration', () => {
  it('reports configured when all required vars are present', () => {
    const serper = getIntegration('serp')!;
    const r = evaluateIntegration(serper, { SERPER_API_KEY: 'serper_abc' });
    expect(r.status).toBe('configured');
    expect(r.missing).toEqual([]);
  });

  it('reports missing when no required vars are present', () => {
    const serper = getIntegration('serp')!;
    const r = evaluateIntegration(serper, {});
    expect(r.status).toBe('missing');
    expect(r.missing.map((m) => m.name)).toEqual(['SERPER_API_KEY']);
  });

  it('reports partial when some but not all required vars are present', () => {
    const google = getIntegration('google-integrations')!;
    const r = evaluateIntegration(google, { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' });
    expect(r.status).toBe('partial');
    expect(r.missing.map((m) => m.name).sort()).toEqual([
      'ENCRYPTION_KEY',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REDIRECT_URI',
      'OAUTH_STATE_SECRET',
    ]);
  });

  it('needs the credential-sealing secrets, not just the OAuth client', () => {
    // A deployment with a valid OAuth client but no ENCRYPTION_KEY can walk a
    // user through Google's consent screen and then fail to store the result.
    // Readiness has to call that 'partial', not 'configured'.
    const google = getIntegration('google-integrations')!;
    const r = evaluateIntegration(google, {
      GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-x',
      GOOGLE_REDIRECT_URI: 'https://api.example/oauth/google/callback',
    });
    expect(r.status).toBe('partial');
    expect(r.missing.map((m) => m.name).sort()).toEqual(['ENCRYPTION_KEY', 'OAUTH_STATE_SECRET']);
  });

  it('treats blank/whitespace values as absent', () => {
    const serper = getIntegration('serp')!;
    expect(evaluateIntegration(serper, { SERPER_API_KEY: '   ' }).status).toBe('missing');
  });

  it('surfaces present optional vars without affecting status', () => {
    const openai = getIntegration('llm-openai')!;
    const r = evaluateIntegration(openai, { OPENAI_API_KEY: 'sk-proj-x', OPENAI_MODEL: 'gpt-4o-mini' });
    expect(r.status).toBe('configured');
    expect(r.optionalPresent).toContain('OPENAI_MODEL');
  });
});

describe('evaluateReadiness', () => {
  it('is not mvpReady on an empty env and counts everything missing', () => {
    const report = evaluateReadiness({});
    expect(report.mvpReady).toBe(false);
    expect(report.summary.missing).toBe(report.summary.total);
    expect(report.summary.configured).toBe(0);
  });

  it('is mvpReady once every required-for-MVP integration is configured', () => {
    const report = evaluateReadiness(fullEnv());
    expect(report.mvpReady).toBe(true);
    // Every required-for-MVP integration must be fully configured.
    for (const i of report.integrations.filter((x) => x.requiredForMvp)) {
      expect(i.status).toBe('configured');
    }
  });

  it('stays mvpReady even if only an optional (non-MVP) integration is missing', () => {
    const env = fullEnv();
    // Gemini is requiredForMvp:false — drop its key.
    delete env.GEMINI_API_KEY;
    const report = evaluateReadiness(env);
    expect(report.mvpReady).toBe(true);
    expect(report.integrations.find((i) => i.id === 'llm-gemini')!.status).toBe('missing');
  });

  /**
   * Which LLM engine this deployment actually polls. Sarvam is the one with
   * credit on it, so a deployment with no Sarvam key is not ready, and one
   * with no OpenAI key still is.
   */
  it('requires Sarvam for MVP and no longer requires OpenAI', () => {
    const env = fullEnv();
    delete env.OPENAI_API_KEY;
    expect(evaluateReadiness(env).mvpReady).toBe(true);

    const withoutSarvam = fullEnv();
    delete withoutSarvam.SARVAM_API_KEY;
    const report = evaluateReadiness(withoutSarvam);
    expect(report.mvpReady).toBe(false);
    expect(report.integrations.find((i) => i.id === 'llm-sarvam')!.status).toBe('missing');
  });
});
