/**
 * Feature: Dispatch Builder
 *
 * Fluent interface for constructing and executing dispatches with
 * typed arguments, timeouts, and metadata propagation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DispatchBuilder } from './dispatch-builder.js';
import type { DispatchContext } from './dispatch.js';

// Mock the dispatch module
vi.mock('./dispatch.js', () => ({
  toolkit_dispatch: vi.fn(),
  smallchat_dispatchStream: vi.fn(),
  DispatchContext: vi.fn(),
}));

import { toolkit_dispatch, smallchat_dispatchStream } from './dispatch.js';

describe('Feature: Dispatch Builder Fluent API', () => {
  let mockContext: DispatchContext;

  beforeEach(() => {
    mockContext = {} as DispatchContext;
    vi.resetAllMocks();
  });

  describe('Scenario: Execute a dispatch with args', () => {
    it('Given an intent and args, When exec is called, Then toolkit_dispatch is invoked', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'result',
        isError: false,
      });

      const builder = new DispatchBuilder(mockContext, 'search docs');
      const result = await builder.withArgs({ query: 'test' }).exec();

      expect(toolkit_dispatch).toHaveBeenCalledWith(mockContext, 'search docs', { query: 'test' });
      expect(result.content).toBe('result');
    });
  });

  describe('Scenario: withArgs returns a new builder with narrowed type', () => {
    it('Given a builder, When withArgs is called, Then a new builder is returned', () => {
      const builder1 = new DispatchBuilder(mockContext, 'intent');
      const builder2 = builder1.withArgs({ key: 'value' });

      expect(builder2).toBeInstanceOf(DispatchBuilder);
      expect(builder2).not.toBe(builder1);
    });
  });

  describe('Scenario: Execute with timeout', () => {
    it('Given a dispatch that resolves within timeout, When exec is called with timeout, Then result is returned', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'fast',
        isError: false,
      });

      const builder = new DispatchBuilder(mockContext, 'fast-op');
      const result = await builder.withTimeout(5000).exec();

      expect(result.content).toBe('fast');
    });

    it('Given a dispatch that exceeds timeout, When exec is called with timeout, Then an error is thrown', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 5000)),
      );

      const builder = new DispatchBuilder(mockContext, 'slow-op');

      await expect(builder.withTimeout(10).exec()).rejects.toThrow('timed out');
    });
  });

  describe('Scenario: Metadata is merged into result', () => {
    it('Given metadata, When exec is called, Then metadata is merged into the result', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'result',
        isError: false,
        metadata: { existing: true },
      });

      const builder = new DispatchBuilder(mockContext, 'intent');
      const result = await builder.withMetadata({ requestId: 'abc' }).exec();

      expect(result.metadata?.existing).toBe(true);
      expect(result.metadata?.requestId).toBe('abc');
    });
  });

  describe('Scenario: execContent returns only the content field', () => {
    it('Given a dispatch result, When execContent is called, Then only content is returned', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: { data: [1, 2, 3] },
        isError: false,
      });

      const builder = new DispatchBuilder(mockContext, 'get-data');
      const content = await builder.execContent<{ data: number[] }>();

      expect(content).toEqual({ data: [1, 2, 3] });
    });
  });

  describe('Scenario: Stream dispatch', () => {
    it('Given a stream intent, When stream is called, Then smallchat_dispatchStream is invoked', () => {
      const mockGen = (async function* () {
        yield { type: 'chunk' as const, content: 'a' };
      })();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'stream-intent');
      const gen = builder.stream();

      expect(smallchat_dispatchStream).toHaveBeenCalledWith(mockContext, 'stream-intent', {});
      expect(gen).toBeDefined();
    });
  });

  describe('Scenario: inferStream yields only token text', () => {
    it('Given inference-delta events, When inferStream is called, Then only text deltas are yielded', async () => {
      const mockGen = (async function* () {
        yield { type: 'resolving' };
        yield { type: 'tool-start', toolName: 'test' };
        yield { type: 'inference-delta', delta: { text: 'Hello' } };
        yield { type: 'inference-delta', delta: { text: ' World' } };
        yield { type: 'done', result: {} };
      })();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'infer');
      const tokens: string[] = [];
      for await (const token of builder.inferStream()) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['Hello', ' World']);
    });
  });

  describe('Scenario: inferStream falls back to chunk content', () => {
    it('Given no inference-delta events, When inferStream is called, Then chunk content is yielded as strings', async () => {
      const mockGen = (async function* () {
        yield { type: 'chunk', content: 'chunk-text' };
        yield { type: 'done', result: {} };
      })();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'fallback');
      const tokens: string[] = [];
      for await (const token of builder.inferStream()) {
        tokens.push(token);
      }

      expect(tokens).toEqual(['chunk-text']);
    });
  });

  describe('Scenario: inferStream throws on error event', () => {
    it('Given an error event, When inferStream is called, Then an error is thrown', async () => {
      const mockGen = (async function* () {
        yield { type: 'error', error: 'something failed' };
      })();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'fail');

      await expect(async () => {
        for await (const _ of builder.inferStream()) {
          // consume
        }
      }).rejects.toThrow('something failed');
    });
  });

  describe('Scenario: collect gathers all chunk content', () => {
    it('Given multiple chunk events, When collect is called, Then all chunk contents are returned', async () => {
      const mockGen = (async function* () {
        yield { type: 'chunk', content: 'a' };
        yield { type: 'chunk', content: 'b' };
        yield { type: 'resolving' }; // Non-chunk, should be skipped
        yield { type: 'chunk', content: 'c' };
        yield { type: 'done', result: {} };
      })();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'collect');
      const chunks = await builder.collect();

      expect(chunks).toEqual(['a', 'b', 'c']);
    });
  });

  describe('Scenario: tokens is an alias for inferStream', () => {
    it('Given a builder, When tokens is called, Then it returns the same generator as inferStream', () => {
      const mockGen = (async function* () {})();
      (smallchat_dispatchStream as ReturnType<typeof vi.fn>).mockReturnValue(mockGen);

      const builder = new DispatchBuilder(mockContext, 'tok');
      const gen = builder.tokens();

      expect(gen).toBeDefined();
    });
  });

  describe('Scenario: Method chaining', () => {
    it('Given a builder, When chaining withTimeout and withMetadata, Then both are applied', async () => {
      (toolkit_dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'ok',
        isError: false,
      });

      const builder = new DispatchBuilder(mockContext, 'chain');
      const result = await builder
        .withTimeout(5000)
        .withMetadata({ chain: true })
        .exec();

      expect(result.content).toBe('ok');
      expect(result.metadata?.chain).toBe(true);
    });
  });
});
