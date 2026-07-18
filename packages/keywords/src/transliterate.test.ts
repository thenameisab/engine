import { describe, it, expect } from 'vitest';
import { transliterateToDevanagari } from './transliterate.js';

describe('transliterateToDevanagari', () => {
  it('renders common Hinglish words correctly', () => {
    expect(transliterateToDevanagari('ghar')).toBe('घर');
    expect(transliterateToDevanagari('dost')).toBe('दोस्त');
    expect(transliterateToDevanagari('kaise')).toBe('कैसे');
  });

  it('does not split an English long-o loanword spelling into two vowels', () => {
    expect(transliterateToDevanagari('loan')).toBe('लोन');
  });

  it('transliterates each word of a phrase independently, preserving spacing', () => {
    expect(transliterateToDevanagari('ghar ka loan')).toBe('घर क लोन');
  });

  it('inserts a halant for a mid-word consonant cluster', () => {
    // dost = d-o-s-t: 's' and 't' are adjacent consonants with no vowel
    // between them, so 's' must carry a halant rather than its inherent 'a'.
    expect(transliterateToDevanagari('dost')).toContain('्');
  });

  it('is a best-effort pass-through for characters outside the scheme, not a throw', () => {
    expect(() => transliterateToDevanagari('xerox 123')).not.toThrow();
  });
});
