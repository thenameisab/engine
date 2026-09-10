/**
 * The LLM-engine adapter interface, "adapter-per-engine behind a common
 * interface" (Architecture §1 Layer 1, A2 FR1). Each of the 5 MVP engines
 * (OpenAI, Gemini, Perplexity Sonar, Anthropic, Google AI Overviews via
 * SERP capture) implements this so the poller and reconciliation logic
 * are engine-agnostic.
 */
import type { CitationMethod } from '@engine/core';

export interface PromptQuery {
  prompt: string;
  entityId: string;
  /**
   * Domains and/or brand names that count as "the entity was cited" (A2). The
   * caller resolves these from the entity's facts. Domain targets (contain a
   * dot) match cited source hosts; name targets match the answer text. Absent
   * → the connector still returns the sources it found but can't decide `cited`.
   */
  citationTargets?: string[];
}

export interface CitationEvent {
  /**
   * Was the entity credited at all — `citedByName || citedByDomain`.
   *
   * Kept as the headline field because the A3 rollup and the visibility score
   * are built on it, but it is a union of two different claims and must not be
   * read as one. See the two below.
   */
  cited: boolean;
  /**
   * The answer text names the brand.
   *
   * This is the only half a non-browsing engine can ever satisfy, so on such
   * an engine `cited` and `citedByName` are the same number — and reporting
   * them as "citations" overstates what happened. The model said your name; it
   * did not point anyone at you.
   */
  citedByName: boolean;
  /**
   * A cited source URL belongs to the entity's own domain.
   *
   * The stronger claim: the engine pointed a reader at the customer's site.
   * Requires the engine to return sources at all, so it is structurally
   * unreachable for an engine that answers from memory.
   */
  citedByDomain: boolean;
  sourcesCited: string[];
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  accuracy: 'accurate' | 'inaccurate' | 'unverifiable' | null;
}

export interface LlmAnswerSample {
  rawAnswerRef: string; // pointer into R2/Parquet raw lake, 24-mo retention
  citation: CitationEvent;
  sampledAt: string;
}

export interface LlmAnswerResult {
  engine: 'openai' | 'gemini' | 'sarvam' | 'perplexity' | 'anthropic' | 'google-ai-overview';
  /**
   * The exact vendor model that produced these samples.
   *
   * Stored per sample, because an engine is not an instrument — a vendor's
   * models disagree with each other. Measured on Sarvam: `sarvam-105b` named
   * a company in one of three category prompts while
   * `sarvam-105b-conversations` named companies in all three. A citation rate
   * is a series over time, so samples from two models pooled into one band
   * report a change of instrument as a change in the brand.
   */
  model: string;
  query: PromptQuery;
  method: CitationMethod;
  samples: LlmAnswerSample[]; // n=3-5 per cycle, aggregated into a CitationMeasurement upstream
}

export interface LlmEngineConnector {
  engine: LlmAnswerResult['engine'];
  poll(query: PromptQuery, nSamples: number): Promise<LlmAnswerResult>;
}
