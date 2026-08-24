/**
 * Google Business Profile reads — accounts, locations and reviews.
 *
 * `packages/deploy/src/gbp.ts` already writes to Business Profile (C5: update a
 * field, reply to a review, create a post). Nothing could read from it. That
 * left B5's local audit scoring GBP completeness and review health off a
 * `local_profiles` document a human had to `PUT` by hand — the migration that
 * created it says so explicitly, "until the GBP API connector lands".
 *
 * This is that connector. It also supplies the location picker the connect flow
 * needs, and the fetch-back that `verifyGbpDeploy` was written to check against
 * but had no caller to supply.
 *
 * Three hosts, because Google split this product across API generations: account
 * management, business information, and the legacy v4 that is still the only
 * place reviews and local posts exist.
 */
import { googleGet, paginate } from './api.js';

const ACCOUNT_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const ENGAGE_API = 'https://mybusiness.googleapis.com/v4';

/** A Business Profile account (personal or a business group/organization). */
export interface GbpAccount {
  /** Resource name, `accounts/123456789`. */
  name: string;
  accountName: string;
  /** 'PERSONAL' | 'LOCATION_GROUP' | 'USER_GROUP' | 'ORGANIZATION'. */
  type?: string;
  /** 'VERIFIED' | 'UNVERIFIED' | 'VERIFICATION_REQUESTED'. */
  verificationState?: string;
}

interface AccountsListResponse {
  accounts?: { name?: string; accountName?: string; type?: string; verificationState?: string }[];
  nextPageToken?: string;
}

/** List the Business Profile accounts this token can see. */
export async function listGbpAccounts(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accounts: GbpAccount[]; truncated: boolean }> {
  const { items, truncated } = await paginate<GbpAccount>(async (pageToken) => {
    const url = new URL(`${ACCOUNT_API}/accounts`);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await googleGet<AccountsListResponse>(url.toString(), accessToken, 'accounts.list', fetchImpl);
    return {
      items: (json.accounts ?? [])
        .filter((a): a is { name: string } & typeof a => typeof a.name === 'string')
        .map((a) => ({
          name: a.name,
          accountName: a.accountName ?? a.name,
          type: a.type,
          verificationState: a.verificationState,
        })),
      nextPageToken: json.nextPageToken,
    };
  });
  return { accounts: items, truncated };
}

/** The profile facts B5's local audit scores, as the API reports them. */
export interface GbpLocation {
  /** Resource name, `locations/123...`. The assignment's resource id and the deploy target's location. */
  name: string;
  title: string;
  /** Primary category display name, e.g. 'Coffee shop'. */
  primaryCategory?: string;
  additionalCategories: string[];
  description?: string;
  phone?: string;
  websiteUri?: string;
  /** Formatted address lines, joined for the NAP consistency check. */
  addressLines: string[];
  locality?: string;
  administrativeArea?: string;
  postalCode?: string;
  regionCode?: string;
  /** True when the location publishes regular opening hours at all. */
  hasRegularHours: boolean;
  /** Google's own store code, when the business sets one. */
  storeCode?: string;
}

interface LocationsListResponse {
  locations?: {
    name?: string;
    title?: string;
    storeCode?: string;
    categories?: { primaryCategory?: { displayName?: string }; additionalCategories?: { displayName?: string }[] };
    profile?: { description?: string };
    phoneNumbers?: { primaryPhone?: string };
    websiteUri?: string;
    storefrontAddress?: {
      addressLines?: string[];
      locality?: string;
      administrativeArea?: string;
      postalCode?: string;
      regionCode?: string;
    };
    regularHours?: { periods?: unknown[] };
  }[];
  nextPageToken?: string;
}

/**
 * The `readMask` for a locations list. The Business Information API **requires**
 * an explicit read mask and rejects the request without one — there is no
 * "return everything" default. Every field B5 audits has to be named here, so
 * this list and `GbpLocation` must stay in step: a field dropped from the mask
 * silently becomes undefined, which the audit would score as "missing" and
 * report as a real finding against the customer.
 */
const LOCATION_READ_MASK = [
  'name',
  'title',
  'storeCode',
  'categories',
  'profile',
  'phoneNumbers',
  'websiteUri',
  'storefrontAddress',
  'regularHours',
].join(',');

function mapLocation(l: NonNullable<LocationsListResponse['locations']>[number]): GbpLocation {
  return {
    name: l.name ?? '',
    title: l.title ?? '',
    primaryCategory: l.categories?.primaryCategory?.displayName,
    additionalCategories: (l.categories?.additionalCategories ?? [])
      .map((c) => c.displayName)
      .filter((d): d is string => typeof d === 'string'),
    description: l.profile?.description,
    phone: l.phoneNumbers?.primaryPhone,
    websiteUri: l.websiteUri,
    addressLines: l.storefrontAddress?.addressLines ?? [],
    locality: l.storefrontAddress?.locality,
    administrativeArea: l.storefrontAddress?.administrativeArea,
    postalCode: l.storefrontAddress?.postalCode,
    regionCode: l.storefrontAddress?.regionCode,
    hasRegularHours: (l.regularHours?.periods ?? []).length > 0,
    storeCode: l.storeCode,
  };
}

/** List the locations under one Business Profile account, for the picker and for auditing. */
export async function listGbpLocations(
  accessToken: string,
  accountName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ locations: GbpLocation[]; truncated: boolean }> {
  const { items, truncated } = await paginate<GbpLocation>(async (pageToken) => {
    const url = new URL(`${INFO_API}/${accountName}/locations`);
    url.searchParams.set('readMask', LOCATION_READ_MASK);
    url.searchParams.set('pageSize', '100');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await googleGet<LocationsListResponse>(url.toString(), accessToken, 'locations.list', fetchImpl);
    return { items: (json.locations ?? []).map(mapLocation), nextPageToken: json.nextPageToken };
  });
  return { locations: items, truncated };
}

/** Fetch one location — the read half of C5's deploy-then-verify loop. */
export async function getGbpLocation(
  accessToken: string,
  locationName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GbpLocation> {
  const url = new URL(`${INFO_API}/${locationName}`);
  url.searchParams.set('readMask', LOCATION_READ_MASK);
  const json = await googleGet<NonNullable<LocationsListResponse['locations']>[number]>(
    url.toString(),
    accessToken,
    'locations.get',
    fetchImpl,
  );
  return mapLocation(json);
}

/** A review, with enough to compute B5's review-health component. */
export interface GbpReview {
  /** Full resource name, `accounts/*\/locations/*\/reviews/*`. The reply target for a C5 action. */
  name: string;
  reviewerDisplayName?: string;
  /** 1..5. Google sends a word ('FIVE'); this is the parsed number. */
  starRating: number;
  comment?: string;
  createTime?: string;
  updateTime?: string;
  /** True when the business has already replied — the signal B5's "unanswered reviews" check needs. */
  hasReply: boolean;
  replyComment?: string;
  replyUpdateTime?: string;
}

interface ReviewsListResponse {
  reviews?: {
    name?: string;
    reviewer?: { displayName?: string };
    starRating?: string;
    comment?: string;
    createTime?: string;
    updateTime?: string;
    reviewReply?: { comment?: string; updateTime?: string };
  }[];
  nextPageToken?: string;
  averageRating?: number;
  totalReviewCount?: number;
}

/**
 * Google sends star ratings as words, not numbers. An unrecognised value maps
 * to 0 rather than NaN, so it is visibly excluded from an average instead of
 * poisoning it.
 */
const STAR_WORDS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

export function parseStarRating(value: string | undefined): number {
  if (!value) return 0;
  return STAR_WORDS[value.toUpperCase()] ?? 0;
}

/**
 * List a location's reviews.
 *
 * Reviews live only on the **v4** API, under a path that needs the account name
 * as well as the location — `accounts/{a}/locations/{l}/reviews`. The v1
 * Business Information API has no review surface at all, which is why the C5
 * writer also reaches for v4 to post a reply.
 */
export async function listGbpReviews(
  accessToken: string,
  accountName: string,
  locationName: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ reviews: GbpReview[]; averageRating?: number; totalReviewCount?: number; truncated: boolean }> {
  // `locationName` may arrive either bare ('locations/123') or already
  // qualified ('accounts/1/locations/123'). Normalise to the bare leaf so
  // joining it to the account cannot produce a doubled path.
  const leaf = locationName.includes('/locations/')
    ? `locations/${locationName.split('/locations/')[1]}`
    : locationName;

  let averageRating: number | undefined;
  let totalReviewCount: number | undefined;

  const { items, truncated } = await paginate<GbpReview>(async (pageToken) => {
    const url = new URL(`${ENGAGE_API}/${accountName}/${leaf}/reviews`);
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await googleGet<ReviewsListResponse>(url.toString(), accessToken, 'reviews.list', fetchImpl);
    // Only the first page carries the aggregates; later pages omit them and
    // must not overwrite what the first page reported.
    if (averageRating === undefined) averageRating = json.averageRating;
    if (totalReviewCount === undefined) totalReviewCount = json.totalReviewCount;
    return {
      items: (json.reviews ?? []).map((r) => ({
        name: r.name ?? '',
        reviewerDisplayName: r.reviewer?.displayName,
        starRating: parseStarRating(r.starRating),
        comment: r.comment,
        createTime: r.createTime,
        updateTime: r.updateTime,
        hasReply: Boolean(r.reviewReply?.comment),
        replyComment: r.reviewReply?.comment,
        replyUpdateTime: r.reviewReply?.updateTime,
      })),
      nextPageToken: json.nextPageToken,
    };
  });

  return { reviews: items, averageRating, totalReviewCount, truncated };
}
