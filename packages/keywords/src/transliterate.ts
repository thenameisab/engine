/**
 * A4.7 vernacular/transliteration (English + Hindi at MVP, per spec §3/§10).
 *
 * A deterministic ITRANS-style romanization → Devanagari transliterator, not
 * an ML model: the spec's own risk register names transliteration accuracy
 * as an open problem to invest IndicBERT/MuRIL in later, so this is scoped
 * honestly as a rule-based normalizer for common Hinglish spellings, not a
 * claim of dictionary-perfect Hindi. Convention (fixed, so output is
 * predictable): a single `a` is the short/inherent vowel a consonant already
 * carries; `aa`/`A` is the long आ. Consonant clusters with no vowel between
 * them get a halant (्); a word-final consonant does not, matching how
 * Hinglish spelling typically drops the trailing schwa in writing (`dost` →
 * दोस्त, not दोस्त्).
 */

interface Consonant {
  latin: string;
  deva: string;
}

// Longest match first: digraphs before the single letters they contain.
const CONSONANTS: readonly Consonant[] = [
  { latin: 'chh', deva: 'छ' },
  { latin: 'kh', deva: 'ख' },
  { latin: 'gh', deva: 'घ' },
  { latin: 'ch', deva: 'च' },
  { latin: 'jh', deva: 'झ' },
  { latin: 'th', deva: 'थ' },
  { latin: 'dh', deva: 'ध' },
  { latin: 'ph', deva: 'फ' },
  { latin: 'bh', deva: 'भ' },
  { latin: 'sh', deva: 'श' },
  { latin: 'ng', deva: 'ङ' },
  { latin: 'ny', deva: 'ञ' },
  { latin: 'k', deva: 'क' },
  { latin: 'g', deva: 'ग' },
  { latin: 'j', deva: 'ज' },
  { latin: 't', deva: 'त' },
  { latin: 'd', deva: 'द' },
  { latin: 'n', deva: 'न' },
  { latin: 'p', deva: 'प' },
  { latin: 'b', deva: 'ब' },
  { latin: 'm', deva: 'म' },
  { latin: 'y', deva: 'य' },
  { latin: 'r', deva: 'र' },
  { latin: 'l', deva: 'ल' },
  { latin: 'v', deva: 'व' },
  { latin: 'w', deva: 'व' },
  { latin: 's', deva: 'स' },
  { latin: 'h', deva: 'ह' },
  { latin: 'f', deva: 'फ' },
];

interface Vowel {
  latin: string;
  /** Matra attached to a preceding consonant; empty string for the inherent `a`. */
  matra: string;
  /** Independent form, used word-initially or after another vowel. */
  independent: string;
}

// Longest match first: 'aa'/'ai'/'au' before the 'a' they'd otherwise match as.
const VOWELS: readonly Vowel[] = [
  { latin: 'aa', matra: 'ा', independent: 'आ' },
  { latin: 'ai', matra: 'ै', independent: 'ऐ' },
  { latin: 'au', matra: 'ौ', independent: 'औ' },
  { latin: 'ee', matra: 'ी', independent: 'ई' },
  { latin: 'oo', matra: 'ू', independent: 'ऊ' },
  // English loanwords ('loan', 'coach') spell the long-o sound 'oa'/'ow';
  // without this they'd decompose into two Hindi vowels (o + a) and produce
  // an extra syllable no Hinglish speaker intended.
  { latin: 'oa', matra: 'ो', independent: 'ओ' },
  { latin: 'ow', matra: 'ो', independent: 'ओ' },
  { latin: 'A', matra: 'ा', independent: 'आ' },
  { latin: 'I', matra: 'ी', independent: 'ई' },
  { latin: 'U', matra: 'ू', independent: 'ऊ' },
  { latin: 'a', matra: '', independent: 'अ' },
  { latin: 'i', matra: 'ि', independent: 'इ' },
  { latin: 'u', matra: 'ु', independent: 'उ' },
  { latin: 'e', matra: 'े', independent: 'ए' },
  { latin: 'o', matra: 'ो', independent: 'ओ' },
];

const HALANT = '्';

type Token = { kind: 'consonant'; deva: string } | { kind: 'vowel'; matra: string; independent: string };

function tokenizeWord(word: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  outer: while (i < word.length) {
    for (const c of CONSONANTS) {
      if (word.startsWith(c.latin, i)) {
        tokens.push({ kind: 'consonant', deva: c.deva });
        i += c.latin.length;
        continue outer;
      }
    }
    for (const v of VOWELS) {
      if (word.startsWith(v.latin, i)) {
        tokens.push({ kind: 'vowel', matra: v.matra, independent: v.independent });
        i += v.latin.length;
        continue outer;
      }
    }
    // Unmapped character (digit, punctuation survived the caller's filter,
    // or a Latin letter outside this scheme, e.g. 'x'/'q'/'z'): skip it
    // rather than throw. A best-effort transliteration of the rest of the
    // word beats discarding the whole seed term.
    i += 1;
  }
  return tokens;
}

/**
 * A vowel token is only ever rendered here when it wasn't already consumed
 * as a preceding consonant's matra — i.e. it's word-initial or follows
 * another vowel — so it always takes its independent form.
 */
function renderWord(tokens: readonly Token[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'consonant') {
      out += t.deva;
      const next = tokens[i + 1];
      if (next?.kind === 'vowel') {
        out += next.matra;
        i += 1; // vowel consumed as this consonant's matra
      } else if (next?.kind === 'consonant') {
        out += HALANT; // mid-word cluster: suppress the inherent vowel
      }
      // else: word-final consonant carries its inherent vowel silently
    } else {
      out += t.independent;
    }
  }
  return out;
}

/**
 * Transliterate a romanized Hindi/Hinglish word into Devanagari. Non-letter
 * characters (numbers, punctuation) pass through unchanged; each
 * whitespace-separated word is transliterated independently so a phrase like
 * "ghar ka loan" renders as three recognizable words, not one run-on guess.
 */
export function transliterateToDevanagari(input: string): string {
  return input
    .split(/(\s+)/)
    .map((chunk) => (/\s/.test(chunk) ? chunk : renderWord(tokenizeWord(chunk.toLowerCase()))))
    .join('');
}
