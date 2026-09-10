import { describe, it, expect } from 'vitest';
import {
  normalizeNap,
  normalizePhone,
  gbpCompleteness,
  napConsistency,
  reviewHealth,
  blendedScore,
  listingMatches,
  MIN_PHOTOS,
  REVIEW_VELOCITY_TARGET,
} from './score.js';
import { runLocalAudit } from './audit.js';
import type { LocalProfileFacts, Review } from './types.js';

function facts(over: Partial<LocalProfileFacts> = {}): LocalProfileFacts {
  return {
    entityId: 'loc1',
    canonicalName: 'Acme Delhi',
    name: 'Acme Store',
    address: '12 MG Road, New Delhi',
    phone: '+91 98765 43210',
    categories: ['Grocery store'],
    hoursSet: true,
    attributes: ['wheelchair accessible'],
    photoCount: 5,
    description: 'A neighbourhood grocery store serving MG Road for twenty years and counting.',
    directoryListings: [],
    reviews: [],
    // The fixture stands for a GBP-sourced location: reviews were looked for.
    // A hand-typed profile is the `reviewsSourced: false` case and is covered
    // by its own test below.
    reviewsSourced: true,
    ...over,
  };
}

const FIXED = () => Date.parse('2026-07-21T00:00:00Z');
function daysAgo(n: number): string {
  return new Date(FIXED() - n * 86400000).toISOString();
}
function review(over: Partial<Review> = {}): Review {
  return { rating: 5, respondedTo: true, sentiment: 'positive', at: daysAgo(1), ...over };
}

describe('NAP normalization', () => {
  it('collapses case and punctuation', () => {
    expect(normalizeNap('12 MG Road, New Delhi')).toBe(normalizeNap('12 mg road new delhi'));
  });
  it('phone compares on the last 10 digits (country-code tolerant)', () => {
    expect(normalizePhone('+91 98765 43210')).toBe(normalizePhone('098765-43210'));
    expect(normalizePhone('98765 43210')).not.toBe(normalizePhone('98765 43211'));
  });
});

describe('gbpCompleteness', () => {
  it('is 1.0 when every field is filled', () => {
    expect(gbpCompleteness(facts())).toBe(1);
  });
  it('drops proportionally as fields go missing', () => {
    expect(gbpCompleteness(facts({ categories: [], hoursSet: false }))).toBeCloseTo(3 / 5);
  });
  it('requires at least MIN_PHOTOS and a substantial description', () => {
    expect(gbpCompleteness(facts({ photoCount: MIN_PHOTOS - 1, description: 'too short' }))).toBeCloseTo(3 / 5);
  });
});

describe('napConsistency', () => {
  it('is 1.0 with no directory listings', () => {
    expect(napConsistency(facts()).consistency).toBe(1);
  });
  it('flags a listing whose phone differs', () => {
    const f = facts({ directoryListings: [{ source: 'justdial.com', name: 'Acme Store', address: '12 MG Road, New Delhi', phone: '99999 00000' }] });
    const res = napConsistency(f);
    expect(res.consistency).toBe(0);
    expect(res.inconsistent[0].source).toBe('justdial.com');
  });
  it('treats formatting-only differences as consistent', () => {
    const f = facts({ directoryListings: [{ source: 'g2.com', name: 'ACME STORE', address: '12, M.G. Road, New Delhi', phone: '+91-98765-43210' }] });
    expect(listingMatches(f, f.directoryListings[0])).toBe(true);
  });
});

describe('reviewHealth', () => {
  it('is 0 with no reviews', () => {
    expect(reviewHealth([], FIXED).health).toBe(0);
  });
  it('rewards velocity, response rate, and positive sentiment', () => {
    const reviews = Array.from({ length: REVIEW_VELOCITY_TARGET }, () => review());
    expect(reviewHealth(reviews, FIXED).health).toBeCloseTo(1);
  });
  it('counts unanswered and old reviews against health', () => {
    const reviews = [review({ respondedTo: false, sentiment: 'negative', at: daysAgo(200) })];
    const r = reviewHealth(reviews, FIXED);
    expect(r.unanswered).toBe(1);
    expect(r.recentCount).toBe(0);
    expect(r.health).toBeLessThan(0.5);
  });
});

describe('blendedScore', () => {
  it('weights GBP + NAP over reviews and stays within 0–1', () => {
    expect(blendedScore(1, 1, 1)).toBeCloseTo(1);
    expect(blendedScore(0, 0, 0)).toBe(0);
    expect(blendedScore(1, 0, 0)).toBeCloseTo(0.4);
  });
});

describe('runLocalAudit', () => {
  it('emits one finding per missing GBP field + NAP + review issues, source local, reproducibly', () => {
    const f = facts({
      categories: [],
      photoCount: 0,
      directoryListings: [{ source: 'justdial.com', name: 'Acme', address: 'wrong', phone: '1' }],
      reviews: [review({ respondedTo: false, at: daysAgo(300) })],
    });
    const now = () => '2026-07-21T00:00:00.000Z';
    const a = runLocalAudit(f, { now, clock: FIXED });
    const b = runLocalAudit(f, { now, clock: FIXED });
    expect(a.findings.map((x) => x.id)).toEqual(b.findings.map((x) => x.id));

    const types = a.findings.map((x) => x.issueType);
    expect(types).toContain('incomplete-gbp-field');
    expect(types).toContain('nap-inconsistency');
    expect(types).toContain('unanswered-reviews');
    expect(types).toContain('low-review-velocity');
    for (const fnd of a.findings) {
      expect(fnd.source).toBe('local');
      expect(fnd.actionTemplates.length).toBeGreaterThan(0);
    }
    // GBP + review actions are gbp; NAP is content.
    const nap = a.findings.find((x) => x.issueType === 'nap-inconsistency')!;
    const gbpField = a.findings.find((x) => x.issueType === 'incomplete-gbp-field')!;
    expect(nap.actionTemplates[0].type).toBe('content');
    expect(gbpField.actionTemplates[0].type).toBe('gbp');
  });

  it('a fully healthy location scores ~1 with no findings', () => {
    const f = facts({ reviews: Array.from({ length: REVIEW_VELOCITY_TARGET }, () => review()) });
    const res = runLocalAudit(f, { clock: FIXED });
    expect(res.findings).toHaveLength(0);
    expect(res.visibility.score).toBeCloseTo(1);
  });
});

describe('a profile nobody could source reviews for', () => {
  it('leaves review health unmeasured rather than scoring it zero', () => {
    // The trap this exists for: a person can type their name, address, phone
    // and categories, but not their review history. Scoring the empty list as
    // 0 would tell an owner with a perfect listing that their local presence
    // is weak, on the strength of data nobody ever collected.
    const complete = {
      categories: ['Dentist'],
      hoursSet: true,
      attributes: ['wheelchair-accessible'],
      photoCount: 20,
      description: 'A dental practice.',
    };
    const sourced = runLocalAudit(facts({ ...complete, reviews: [], reviewsSourced: true }));
    const typed = runLocalAudit(facts({ ...complete, reviews: [], reviewsSourced: false }));

    expect(sourced.visibility.components.reviewHealth).toBe(0);
    expect(typed.visibility.components.reviewHealth).toBeNull();
    expect(typed.visibility.score).toBeGreaterThan(sourced.visibility.score);
  });

  it('does not claim unanswered reviews or low velocity it never looked for', () => {
    const typed = runLocalAudit(facts({ reviews: [], reviewsSourced: false }));
    const types = typed.findings.map((f) => f.issueType);
    expect(types).not.toContain('unanswered-reviews');
    expect(types).not.toContain('low-review-velocity');
  });
});

