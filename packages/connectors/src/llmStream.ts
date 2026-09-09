/**
 * Streaming answers from an LLM engine (shared across engines).
 *
 * The batch `poll` path exists so a scheduled run can store an n=3 citation
 * measurement. This is the other half: a person typed something and is
 * watching an empty box, so the answer has to arrive as it is produced.
 *
 * The chunk type distinguishes thinking from answer text, which is not a
 * cosmetic distinction on this deployment. `sarvam-105b` is a reasoning model:
 * it emits `reasoning_content` first and `content` only once it has finished
 * thinking, out of one 16,000-token budget. A stream that forwarded only
 * `content` would show nothing at all for the entire reasoning phase and then
 * deliver the answer in a burst — slower to first paint than a plain request
 * and no more informative than a spinner. Surfacing the thinking phase as its
 * own state is the reason to stream at all here.
 */

/** One piece of a streamed answer. */
export type LlmStreamChunk =
  /** The model is still reasoning. `delta` is reasoning text, not the answer. */
  | { type: 'thinking'; delta: string }
  /** Answer text. Concatenating every `text` delta gives the full answer. */
  | { type: 'text'; delta: string };

export interface LlmStreamingConnector {
  engine: string;
  /**
   * Stream one answer to `prompt`. Yields chunks in arrival order and returns
   * normally at the end of the stream; throws on transport or vendor failure.
   */
  stream(prompt: string, signal?: AbortSignal): AsyncIterable<LlmStreamChunk>;
}

/**
 * Parse an OpenAI-shaped `text/event-stream` body into JSON payloads.
 *
 * Written as its own generator because the buffering is the part that breaks
 * under real conditions: a `data:` line is not guaranteed to arrive whole in
 * one network chunk, so splitting each chunk on newlines and parsing what it
 * happens to contain drops the tail of every event that straddles a boundary.
 * The partial line is carried forward instead.
 */
export async function* parseSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        // The vendor's end-of-stream marker is a sentinel, not JSON.
        if (payload === '[DONE]') return;
        try {
          yield JSON.parse(payload);
        } catch {
          // A single malformed event is skipped rather than aborting a stream
          // whose remaining events are fine.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
