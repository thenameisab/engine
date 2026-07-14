/**
 * The AI-visibility honesty type (Architecture §3.2).
 * Point estimates are never surfaced for AI visibility -- every
 * citation-rate figure is a confidence band derived from n=3-5 samples.
 */
export type CitationMethod = 'api' | 'consumer' | 'reconciled';

export interface ConfidenceBand {
  low: number;
  point: number;
  high: number;
}

export interface CitationMeasurement {
  engine: string;
  prompt: string;
  nSamples: number;
  citationRate: ConfidenceBand;
  method: CitationMethod;
  measuredAt: string;
}
