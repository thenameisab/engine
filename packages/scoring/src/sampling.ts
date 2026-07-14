/**
 * n-sampling -> confidence band (A2.6). This is the trust signature of the whole
 * product (roadmap hard-sequencing rule #3): every AI-visibility citation rate is
 * produced from n=3-5 samples as a `{low, point, high}` band and *stored* as such
 * (A2 §9: "bands stored, not computed client-side"). A point estimate is never
 * surfaced for AI visibility.
 *
 * We use the **Wilson score interval** for the proportion "how often was the brand
 * cited across n runs." Wilson is the right choice for small n: unlike the naive
 * Wald interval it stays inside [0,1] and gives sensible, asymmetric bounds even
 * at n=3 with 0 or n successes -- exactly the regime A2 operates in.
 */
import type { CitationMeasurement, CitationMethod, ConfidenceBand } from '@engine/core';

/** One run of a prompt against one engine (A2.2-A2.4). */
export interface CitationSample {
  /** Was the brand/entity cited in this answer? */
  cited: boolean;
  /** Sentiment of the brand mention in [-1, 1], if scored (A2.3). */
  sentiment?: number;
  /** Accuracy of the brand claim in [0, 1], if scored (A2.4). */
  accuracy?: number;
}

/** z for a 95% interval (default). Configurable for other confidence levels. */
export const Z_95 = 1.959963984540054;

/**
 * Wilson score interval for `successes` out of `n` Bernoulli trials.
 * Returns a band in [0,1] where `point` is the *observed* proportion (the honest
 * best estimate) and low/high are the Wilson bounds. n=0 yields a fully
 * uninformative {0,0,1} band rather than a divide-by-zero.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): ConfidenceBand {
  if (n <= 0) return { low: 0, point: 0, high: 1 };
  const clampedSuccesses = Math.min(Math.max(0, successes), n);
  const pHat = clampedSuccesses / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (pHat + z2 / (2 * n)) / denom;
  const margin =
    (z / denom) * Math.sqrt((pHat * (1 - pHat)) / n + z2 / (4 * n * n));
  return {
    low: Math.max(0, center - margin),
    point: pHat,
    high: Math.min(1, center + margin),
  };
}

/**
 * Citation-rate band from a batch of samples (A2.6). `point` is the observed
 * citation frequency; the band widens as n shrinks, which is the whole point --
 * n=3 must visibly carry more uncertainty than n=5.
 */
export function citationBandFromSamples(
  samples: readonly CitationSample[],
  z: number = Z_95,
): ConfidenceBand {
  const n = samples.length;
  const cited = samples.reduce((acc, s) => acc + (s.cited ? 1 : 0), 0);
  return wilsonInterval(cited, n, z);
}

/**
 * Assemble a stored `CitationMeasurement` (the core honesty type) from a run's
 * samples, tagging the capture `method` (api/consumer/reconciled) per A2 §9's
 * method-transparency requirement.
 */
export function buildCitationMeasurement(params: {
  engine: string;
  prompt: string;
  samples: readonly CitationSample[];
  method: CitationMethod;
  measuredAt: string;
  z?: number;
}): CitationMeasurement {
  return {
    engine: params.engine,
    prompt: params.prompt,
    nSamples: params.samples.length,
    citationRate: citationBandFromSamples(params.samples, params.z ?? Z_95),
    method: params.method,
    measuredAt: params.measuredAt,
  };
}

/**
 * Statistically reconcile an API-mode band with a consumer-mode band (A2.7),
 * producing a single `reconciled` band. Both bands are combined by
 * inverse-width weighting -- a tighter (more sampled) band dominates -- and the
 * reconciled band's width is the wider of the two inputs so reconciliation never
 * *understates* uncertainty.
 */
export function reconcileBands(api: ConfidenceBand, consumer: ConfidenceBand): ConfidenceBand {
  const wApi = 1 / Math.max(api.high - api.low, 1e-6);
  const wConsumer = 1 / Math.max(consumer.high - consumer.low, 1e-6);
  const wSum = wApi + wConsumer;
  const point = (api.point * wApi + consumer.point * wConsumer) / wSum;
  const halfWidth = Math.max(api.high - api.low, consumer.high - consumer.low) / 2;
  return {
    low: Math.max(0, point - halfWidth),
    point,
    high: Math.min(1, point + halfWidth),
  };
}
