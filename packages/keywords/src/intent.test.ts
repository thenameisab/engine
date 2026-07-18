import { describe, it, expect } from 'vitest';
import { classifyIntent } from './intent.js';

describe('classifyIntent', () => {
  it('reads transactional signals before commercial ones', () => {
    expect(classifyIntent('buy running shoes online')).toBe('transactional');
    expect(classifyIntent('running shoes price')).toBe('transactional');
  });

  it('reads comparison/review language as commercial', () => {
    expect(classifyIntent('best running shoes 2026')).toBe('commercial');
    expect(classifyIntent('nike vs adidas')).toBe('commercial');
  });

  it('reads brand/login language as navigational', () => {
    expect(classifyIntent('gmail login')).toBe('navigational');
  });

  it('reads question language as informational', () => {
    expect(classifyIntent('how does compound interest work')).toBe('informational');
  });

  it('defaults an unmatched keyword to informational', () => {
    expect(classifyIntent('running shoes')).toBe('informational');
  });
});
