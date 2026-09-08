import { describe, it, expect } from 'vitest';
import { redact, redactError, safeUrl, REDACTED } from './redact.js';

describe('redact', () => {
  it('removes a client secret echoed back in a form-encoded error body', () => {
    const body = 'error=invalid_client&client_secret=GOCSPX-realsecretvalue123&client_id=abc.apps.googleusercontent.com';
    const out = redact(body);
    expect(out).not.toContain('GOCSPX-realsecretvalue123');
    // The client id is not a secret, and an operator needs it to tell which
    // client was used.
    expect(out).toContain('client_id=abc.apps.googleusercontent.com');
    expect(out).toContain('error=invalid_client');
  });

  it('removes tokens from a JSON token response', () => {
    const body = JSON.stringify({
      access_token: 'ya29.a0AfH6SMBexample',
      refresh_token: '1//04realrefreshtokenvaluehere',
      expires_in: 3599,
      scope: 'https://www.googleapis.com/auth/webmasters.readonly',
    });
    const out = redact(body);
    expect(out).not.toContain('ya29.a0AfH6SMBexample');
    expect(out).not.toContain('1//04realrefreshtokenvaluehere');
    // Scope and expiry are diagnostic and must survive.
    expect(out).toContain('webmasters.readonly');
    expect(out).toContain('3599');
  });

  it('removes a bearer token from an Authorization header dump', () => {
    expect(redact('Authorization: Bearer abcdef1234567890xyz')).not.toContain('abcdef1234567890xyz');
    expect(redact('authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA==');
  });

  it('catches vendor token shapes even when the field is not named like a secret', () => {
    // The case the key list alone misses: a token pasted into prose.
    expect(redact('failed for value sk-abcdefghijklmnopqrstuvwx')).toBe(`failed for value ${REDACTED}`);
    expect(redact('token was ghp_abcdefghijklmnopqrstuvwxyz1234')).toContain(REDACTED);
    expect(redact('xoxb-1234567890-abcdefghij')).toBe(REDACTED);
  });

  it('leaves ordinary diagnostic text alone', () => {
    const msg = 'property sc-domain:example.com returned HTTP 403 for user@example.com';
    expect(redact(msg)).toBe(msg);
  });

  it('is safe on empty input', () => {
    expect(redact('')).toBe('');
  });
});

describe('redactError', () => {
  it('redacts a secret inside a vendor error', () => {
    const out = redactError(`boom client_secret=GOCSPX-${'x'.repeat(900)}`);
    expect(out).not.toContain('GOCSPX-x');
    expect(out).toContain('client_secret=');
  });

  it('caps a long error that contains no secret to redact', () => {
    // An HTML error page instead of JSON: nothing matches a redaction rule, so
    // the length cap is the only thing standing between a vendor and a
    // kilobyte of markup in a database column.
    const out = redactError(`<html><body>${'a'.repeat(900)}</body></html>`, 100);
    expect(out.length).toBe(101); // 100 characters plus the ellipsis
    expect(out.endsWith('…')).toBe(true);
  });

  it('accepts a non-Error throw', () => {
    expect(redactError({ toString: () => 'token=abc123def456' })).toContain(REDACTED);
  });
});

describe('safeUrl', () => {
  it('strips every query value, including the authorization code', () => {
    const out = safeUrl('https://app.example.com/callback?code=4/0AeanS0abcdef&state=signedstate.sig&scope=email');
    expect(out).not.toContain('4/0AeanS0abcdef');
    expect(out).not.toContain('signedstate.sig');
    // Path and parameter names survive — that is the diagnostic content.
    expect(out).toContain('/callback');
    expect(out).toContain('code=');
    expect(out).toContain('state=');
  });

  it('returns a redaction marker rather than echoing something unparseable', () => {
    expect(safeUrl('not a url at all')).toBe(REDACTED);
  });
});
