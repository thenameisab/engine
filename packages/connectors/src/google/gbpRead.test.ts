import { describe, it, expect } from 'vitest';
import { listGbpAccounts, listGbpLocations, getGbpLocation, listGbpReviews, parseStarRating } from './gbpRead.js';

function stubFetch(bodies: unknown[]) {
  const calls: { url: string }[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('listGbpAccounts', () => {
  it('maps accounts and hits the account-management host', async () => {
    const { impl, calls } = stubFetch([
      {
        accounts: [
          { name: 'accounts/1', accountName: 'Acme Group', type: 'LOCATION_GROUP', verificationState: 'VERIFIED' },
          { name: 'accounts/2', accountName: 'Personal' },
        ],
      },
    ]);
    const { accounts } = await listGbpAccounts('token', impl);
    expect(accounts).toEqual([
      { name: 'accounts/1', accountName: 'Acme Group', type: 'LOCATION_GROUP', verificationState: 'VERIFIED' },
      { name: 'accounts/2', accountName: 'Personal', type: undefined, verificationState: undefined },
    ]);
    expect(calls[0].url).toContain('mybusinessaccountmanagement.googleapis.com/v1/accounts');
  });

  it('returns an empty list when the token sees no Business Profile accounts', async () => {
    expect((await listGbpAccounts('t', stubFetch([{}]).impl)).accounts).toEqual([]);
  });
});

describe('listGbpLocations', () => {
  it('sends the readMask the Business Information API requires', async () => {
    const { impl, calls } = stubFetch([{ locations: [] }]);
    await listGbpLocations('token', 'accounts/1', impl);
    const url = new URL(calls[0].url);
    const mask = url.searchParams.get('readMask')!;
    // Every field the local audit scores must be named, or it reads as missing.
    for (const field of ['title', 'categories', 'profile', 'phoneNumbers', 'websiteUri', 'storefrontAddress', 'regularHours']) {
      expect(mask).toContain(field);
    }
    expect(url.pathname).toContain('/accounts/1/locations');
  });

  it('maps the nested API shape onto the flat audit facts', async () => {
    const { impl } = stubFetch([
      {
        locations: [
          {
            name: 'locations/123',
            title: 'Acme Coffee',
            storeCode: 'AC-01',
            categories: {
              primaryCategory: { displayName: 'Coffee shop' },
              additionalCategories: [{ displayName: 'Bakery' }, { displayName: 'Cafe' }],
            },
            profile: { description: 'Speciality coffee.' },
            phoneNumbers: { primaryPhone: '+65 6123 4567' },
            websiteUri: 'https://acme.example',
            storefrontAddress: {
              addressLines: ['1 Orchard Rd'],
              locality: 'Singapore',
              postalCode: '238888',
              regionCode: 'SG',
            },
            regularHours: { periods: [{}, {}] },
          },
        ],
      },
    ]);
    const { locations } = await listGbpLocations('token', 'accounts/1', impl);
    expect(locations[0]).toEqual({
      name: 'locations/123',
      title: 'Acme Coffee',
      primaryCategory: 'Coffee shop',
      additionalCategories: ['Bakery', 'Cafe'],
      description: 'Speciality coffee.',
      phone: '+65 6123 4567',
      websiteUri: 'https://acme.example',
      addressLines: ['1 Orchard Rd'],
      locality: 'Singapore',
      administrativeArea: undefined,
      postalCode: '238888',
      regionCode: 'SG',
      hasRegularHours: true,
      storeCode: 'AC-01',
    });
  });

  it('reports a thin profile as absent fields, not as errors', async () => {
    const { impl } = stubFetch([{ locations: [{ name: 'locations/9', title: 'Bare' }] }]);
    const loc = (await listGbpLocations('token', 'accounts/1', impl)).locations[0];
    expect(loc.description).toBeUndefined();
    expect(loc.primaryCategory).toBeUndefined();
    expect(loc.additionalCategories).toEqual([]);
    expect(loc.addressLines).toEqual([]);
    expect(loc.hasRegularHours).toBe(false);
  });

  it('treats an empty regularHours periods array as no published hours', async () => {
    const { impl } = stubFetch([{ locations: [{ name: 'locations/9', regularHours: { periods: [] } }] }]);
    expect((await listGbpLocations('t', 'accounts/1', impl)).locations[0].hasRegularHours).toBe(false);
  });

  it('follows pagination across location pages', async () => {
    const { impl } = stubFetch([
      { locations: [{ name: 'locations/1' }], nextPageToken: 'p2' },
      { locations: [{ name: 'locations/2' }] },
    ]);
    const { locations, truncated } = await listGbpLocations('token', 'accounts/1', impl);
    expect(locations.map((l) => l.name)).toEqual(['locations/1', 'locations/2']);
    expect(truncated).toBe(false);
  });
});

describe('getGbpLocation', () => {
  it('fetches one location with the same mask, for the deploy verify step', async () => {
    const { impl, calls } = stubFetch([{ name: 'locations/123', title: 'Acme' }]);
    const loc = await getGbpLocation('token', 'locations/123', impl);
    expect(loc.title).toBe('Acme');
    expect(new URL(calls[0].url).searchParams.get('readMask')).toContain('title');
  });
});

describe('parseStarRating', () => {
  it('maps Googles star words to numbers', () => {
    expect(parseStarRating('FIVE')).toBe(5);
    expect(parseStarRating('ONE')).toBe(1);
    expect(parseStarRating('three')).toBe(3);
  });

  it('maps unknown and absent ratings to 0 rather than NaN', () => {
    expect(parseStarRating('STAR_RATING_UNSPECIFIED')).toBe(0);
    expect(parseStarRating(undefined)).toBe(0);
    expect(Number.isNaN(parseStarRating('nonsense'))).toBe(false);
  });
});

describe('listGbpReviews', () => {
  it('uses the v4 host, since reviews exist nowhere else', async () => {
    const { impl, calls } = stubFetch([{ reviews: [] }]);
    await listGbpReviews('token', 'accounts/1', 'locations/123', impl);
    expect(calls[0].url).toContain('mybusiness.googleapis.com/v4/accounts/1/locations/123/reviews');
  });

  it('does not double the path when the location arrives already qualified', async () => {
    const { impl, calls } = stubFetch([{ reviews: [] }]);
    await listGbpReviews('token', 'accounts/1', 'accounts/1/locations/123', impl);
    expect(calls[0].url).toContain('/v4/accounts/1/locations/123/reviews');
    expect(calls[0].url).not.toContain('accounts/1/accounts/1');
  });

  it('maps a replied and an unanswered review, which is the signal the audit needs', async () => {
    const { impl } = stubFetch([
      {
        reviews: [
          {
            name: 'accounts/1/locations/123/reviews/r1',
            reviewer: { displayName: 'A. Customer' },
            starRating: 'FIVE',
            comment: 'Great.',
            createTime: '2026-08-01T00:00:00Z',
            reviewReply: { comment: 'Thanks!', updateTime: '2026-08-02T00:00:00Z' },
          },
          { name: 'accounts/1/locations/123/reviews/r2', starRating: 'TWO', comment: 'Slow service.' },
        ],
        averageRating: 3.5,
        totalReviewCount: 2,
      },
    ]);
    const { reviews, averageRating, totalReviewCount } = await listGbpReviews('t', 'accounts/1', 'locations/123', impl);
    expect(reviews[0].hasReply).toBe(true);
    expect(reviews[0].replyComment).toBe('Thanks!');
    expect(reviews[0].starRating).toBe(5);
    expect(reviews[1].hasReply).toBe(false);
    expect(reviews[1].starRating).toBe(2);
    expect(averageRating).toBe(3.5);
    expect(totalReviewCount).toBe(2);
  });

  it('treats an empty reply comment as unanswered', async () => {
    const { impl } = stubFetch([{ reviews: [{ name: 'r', starRating: 'FIVE', reviewReply: { comment: '' } }] }]);
    expect((await listGbpReviews('t', 'accounts/1', 'locations/1', impl)).reviews[0].hasReply).toBe(false);
  });

  it('keeps the first pages aggregates when later pages omit them', async () => {
    const { impl } = stubFetch([
      { reviews: [{ name: 'r1', starRating: 'FIVE' }], averageRating: 4.2, totalReviewCount: 2, nextPageToken: 'p2' },
      { reviews: [{ name: 'r2', starRating: 'FOUR' }] },
    ]);
    const result = await listGbpReviews('t', 'accounts/1', 'locations/1', impl);
    expect(result.reviews).toHaveLength(2);
    expect(result.averageRating).toBe(4.2);
    expect(result.totalReviewCount).toBe(2);
  });

  it('returns an empty list for a location with no reviews', async () => {
    const result = await listGbpReviews('t', 'accounts/1', 'locations/1', stubFetch([{}]).impl);
    expect(result.reviews).toEqual([]);
    expect(result.averageRating).toBeUndefined();
  });
});
