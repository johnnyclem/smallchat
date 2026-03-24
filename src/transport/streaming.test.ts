/**
 * Feature: Streaming Support (SSE, NDJSON, Text)
 *
 * Provides utilities for parsing Server-Sent Events streams, NDJSON streams,
 * and plain text streams into TransportOutput chunks.
 */

import { describe, it, expect } from 'vitest';
import { parseSSEStream, parseNDJSONStream, parseTextStream, getStreamParser } from './streaming.js';

/** Helper to create a ReadableStream from string chunks */
function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('Feature: SSE Stream Parsing', () => {
  describe('Scenario: Parse valid SSE JSON events', () => {
    it('Given SSE data lines with JSON, When parseSSEStream is called, Then parsed JSON objects are yielded', async () => {
      const stream = createStream([
        'data: {"msg":"hello"}\n\n',
        'data: {"msg":"world"}\n\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ msg: 'hello' }, { msg: 'world' }]);
    });
  });

  describe('Scenario: SSE [DONE] signal stops parsing', () => {
    it('Given an SSE stream with [DONE], When parseSSEStream is called, Then it stops at [DONE]', async () => {
      const stream = createStream([
        'data: {"n":1}\n\n',
        'data: [DONE]\n\n',
        'data: {"n":2}\n\n', // Should not be yielded
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ n: 1 }]);
    });
  });

  describe('Scenario: [DONE] on data line stops parsing', () => {
    it('Given data: [DONE] as a data line, When parseSSEStream is called, Then it returns immediately', async () => {
      const stream = createStream([
        'data: [DONE]\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([]);
    });
  });

  describe('Scenario: Non-JSON SSE data is yielded as text', () => {
    it('Given SSE data that is not valid JSON, When parseSSEStream is called, Then raw text is yielded', async () => {
      const stream = createStream([
        'data: plain text message\n\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual(['plain text message']);
    });
  });

  describe('Scenario: Chunk indices are sequential', () => {
    it('Given multiple SSE events, When parseSSEStream is called, Then chunkIndex increments', async () => {
      const stream = createStream([
        'data: {"a":1}\n\n',
        'data: {"b":2}\n\n',
        'data: {"c":3}\n\n',
      ]);

      const indices: number[] = [];
      for await (const output of parseSSEStream(stream)) {
        indices.push(output.metadata?.chunkIndex as number);
      }

      expect(indices).toEqual([0, 1, 2]);
    });
  });

  describe('Scenario: Multi-line SSE data events', () => {
    it('Given multi-line data in a single event, When parseSSEStream is called, Then lines are concatenated before parsing', async () => {
      const stream = createStream([
        'data: {"multi":\n',
        'data: "line"}\n\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results.length).toBe(1);
    });
  });

  describe('Scenario: Abort signal stops stream', () => {
    it('Given an aborted signal, When parseSSEStream is called, Then it stops yielding', async () => {
      const controller = new AbortController();
      controller.abort();

      const stream = createStream(['data: {"a":1}\n\n']);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream, controller.signal)) {
        results.push(output);
      }

      expect(results).toEqual([]);
    });
  });

  describe('Scenario: Remaining data is flushed at end', () => {
    it('Given data without trailing blank line, When stream ends, Then remaining data is flushed', async () => {
      const stream = createStream([
        'data: {"final":true}\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseSSEStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ final: true }]);
    });
  });
});

describe('Feature: NDJSON Stream Parsing', () => {
  describe('Scenario: Parse newline-delimited JSON', () => {
    it('Given NDJSON lines, When parseNDJSONStream is called, Then each line is parsed as JSON', async () => {
      const stream = createStream([
        '{"id":1}\n{"id":2}\n{"id":3}\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseNDJSONStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });
  });

  describe('Scenario: Empty lines are skipped', () => {
    it('Given NDJSON with blank lines, When parseNDJSONStream is called, Then blank lines are ignored', async () => {
      const stream = createStream([
        '{"a":1}\n\n\n{"b":2}\n',
      ]);

      const results: unknown[] = [];
      for await (const output of parseNDJSONStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    });
  });

  describe('Scenario: Invalid JSON lines are yielded as text', () => {
    it('Given a non-JSON line, When parseNDJSONStream is called, Then the raw text is yielded', async () => {
      const stream = createStream(['not-json\n']);

      const results: unknown[] = [];
      for await (const output of parseNDJSONStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual(['not-json']);
    });
  });

  describe('Scenario: Remaining buffer is flushed', () => {
    it('Given NDJSON without trailing newline, When stream ends, Then remaining data is flushed', async () => {
      const stream = createStream(['{"last":true}']);

      const results: unknown[] = [];
      for await (const output of parseNDJSONStream(stream)) {
        results.push(output.content);
      }

      expect(results).toEqual([{ last: true }]);
    });
  });
});

describe('Feature: Text Stream Parsing', () => {
  describe('Scenario: Raw text chunks are yielded', () => {
    it('Given text chunks, When parseTextStream is called, Then each chunk is yielded as content', async () => {
      const stream = createStream(['Hello ', 'World']);

      const results: string[] = [];
      for await (const output of parseTextStream(stream)) {
        results.push(output.content as string);
      }

      expect(results).toEqual(['Hello ', 'World']);
    });
  });

  describe('Scenario: Streaming metadata is set', () => {
    it('Given text chunks, When parseTextStream is called, Then metadata has streaming=true', async () => {
      const stream = createStream(['chunk']);

      for await (const output of parseTextStream(stream)) {
        expect(output.metadata?.streaming).toBe(true);
        expect(output.isError).toBe(false);
      }
    });
  });
});

describe('Feature: Stream Parser Detection', () => {
  describe('Scenario: SSE content-type detection', () => {
    it('Given text/event-stream, When getStreamParser is called, Then it returns parseSSEStream', () => {
      const parser = getStreamParser('text/event-stream');
      expect(parser).toBe(parseSSEStream);
    });
  });

  describe('Scenario: NDJSON content-type detection', () => {
    it('Given application/x-ndjson, When getStreamParser is called, Then it returns parseNDJSONStream', () => {
      expect(getStreamParser('application/x-ndjson')).toBe(parseNDJSONStream);
    });

    it('Given application/jsonl, When getStreamParser is called, Then it returns parseNDJSONStream', () => {
      expect(getStreamParser('application/jsonl')).toBe(parseNDJSONStream);
    });
  });

  describe('Scenario: Default to text stream parser', () => {
    it('Given an unknown content-type, When getStreamParser is called, Then it returns parseTextStream', () => {
      expect(getStreamParser('application/octet-stream')).toBe(parseTextStream);
    });
  });
});
