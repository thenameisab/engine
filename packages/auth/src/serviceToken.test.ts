import { describe, it, expect } from 'vitest';
import { verifyServiceToken, timingSafeEqual } from './serviceToken.js';

describe('verifyServiceToken', () => {
  it('accepts an exact match', () => {
    expect(verifyServiceToken('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('rejects a wrong, truncated, or extended token', () => {
    expect(verifyServiceToken('wrong', 's3cret-token')).toBe(false);
    expect(verifyServiceToken('s3cret-toke', 's3cret-token')).toBe(false);
    expect(verifyServiceToken('s3cret-token-extra', 's3cret-token')).toBe(false);
  });

  it('never authenticates when the service token is unconfigured', () => {
    // The dangerous case: no secret set and no token sent must not read as a match.
    expect(verifyServiceToken(undefined, undefined)).toBe(false);
    expect(verifyServiceToken('', '')).toBe(false);
    expect(verifyServiceToken('anything', undefined)).toBe(false);
    expect(verifyServiceToken('anything', '')).toBe(false);
    expect(verifyServiceToken(null, 's3cret-token')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('compares equal-length strings correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
