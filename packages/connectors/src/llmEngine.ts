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
}

export interface CitationEvent {
  cited: boolean;
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
  engine: 'openai' | 'gemini' | 'perplexity' | 'anthropic' | 'google-ai-overview';
  query: PromptQuery;
  method: CitationMethod;
  samples: LlmAnswerSample[]; // n=3-5 per cycle, aggregated into a CitationMeasurement upstream
}

export interface LlmEngineConnector {
  engine: LlmAnswerResult['engine'];
  poll(query: PromptQuery, nSamples: number): Promise<LlmAnswerResult>;
}
