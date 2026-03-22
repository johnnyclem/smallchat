/**
 * Streaming Support — SSE and chunked encoding via Async Generators.
 *
 * Provides utilities for parsing Server-Sent Events (SSE) streams
 * and chunked transfer-encoded responses into TransportOutput chunks.
 */

import type { TransportOutput } from './types.js';

// ---------------------------------------------------------------------------
// SSE Stream Parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into TransportOutput chunks.
 *
 * Handles the SSE wire format:
 *   data: {"key": "value"}
 *   data: [DONE]
 *
 * Each `data:` line is parsed as JSON and yielded as a TransportOutput.
 * Multi-line data events are concatenated before parsing.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TransportOutput> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataBuffer = '';
  let chunkIndex = 0;

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Empty line signals end of an event
        if (line.trim() === '' && dataBuffer) {
          const data = dataBuffer.trim();
          dataBuffer = '';

          if (data === '[DONE]') return;

          try {
            const parsed = JSON.parse(data);
            yield {
              content: parsed,
              isError: false,
              metadata: { streaming: true, chunkIndex: chunkIndex++ },
            };
          } catch {
            // Yield raw text if not valid JSON
            yield {
              content: data,
              isError: false,
              metadata: { streaming: true, chunkIndex: chunkIndex++ },
            };
          }
          continue;
        }

        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          dataBuffer += (dataBuffer ? '\n' : '') + data;
        }
        // Ignore event:, id:, retry: lines for now
      }
    }

    // Flush any remaining data
    if (dataBuffer.trim()) {
      const data = dataBuffer.trim();
      try {
        const parsed = JSON.parse(data);
        yield {
          content: parsed,
          isError: false,
          metadata: { streaming: true, chunkIndex: chunkIndex++ },
        };
      } catch {
        yield {
          content: data,
          isError: false,
          metadata: { streaming: true, chunkIndex: chunkIndex++ },
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Chunked / NDJSON Stream Parser
// ---------------------------------------------------------------------------

/**
 * Parse a newline-delimited JSON (NDJSON) stream into TransportOutput chunks.
 *
 * Each line is parsed as an independent JSON object.
 */
export async function* parseNDJSONStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TransportOutput> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkIndex = 0;

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          yield {
            content: parsed,
            isError: false,
            metadata: { streaming: true, chunkIndex: chunkIndex++ },
          };
        } catch {
          yield {
            content: trimmed,
            isError: false,
            metadata: { streaming: true, chunkIndex: chunkIndex++ },
          };
        }
      }
    }

    // Flush remaining buffer
    const remaining = buffer.trim();
    if (remaining) {
      try {
        yield {
          content: JSON.parse(remaining),
          isError: false,
          metadata: { streaming: true, chunkIndex: chunkIndex++ },
        };
      } catch {
        yield {
          content: remaining,
          isError: false,
          metadata: { streaming: true, chunkIndex: chunkIndex++ },
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Plain text chunked stream
// ---------------------------------------------------------------------------

/**
 * Stream raw text chunks from a ReadableStream.
 */
export async function* parseTextStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TransportOutput> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let chunkIndex = 0;

  try {
    while (true) {
      if (signal?.aborted) return;

      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) {
        yield {
          content: text,
          isError: false,
          metadata: { streaming: true, chunkIndex: chunkIndex++ },
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Detect the stream format from response headers and return the appropriate parser.
 */
export function getStreamParser(
  contentType: string,
): (body: ReadableStream<Uint8Array>, signal?: AbortSignal) => AsyncGenerator<TransportOutput> {
  if (contentType.includes('text/event-stream')) {
    return parseSSEStream;
  }
  if (contentType.includes('application/x-ndjson') || contentType.includes('application/jsonl')) {
    return parseNDJSONStream;
  }
  return parseTextStream;
}
