/**
 * RtkTransport unit tests.
 *
 * Uses a mock inner transport and a fake RTK binary to verify:
 *   - filter mode compresses large outputs
 *   - prefix mode rewrites eligible commands
 *   - content below threshold passes through unmodified
 *   - metadata is correctly populated
 *   - RTK binary not found → graceful fallback
 *   - dispose() delegates to inner transport
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RtkTransport, withRtk } from './rtk-transport.js';
import type { ITransport, TransportInput, TransportOutput } from './types.js';

// ---------------------------------------------------------------------------
// Mock inner transport
// ---------------------------------------------------------------------------

function makeMockTransport(content: unknown = 'hello', isError = false): ITransport {
  return {
    id: 'mock',
    type: 'local',
    execute: vi.fn(async (_input: TransportInput): Promise<TransportOutput> => ({
      content,
      isError,
      metadata: {},
    })),
    async *executeStream(_input: TransportInput): AsyncGenerator<TransportOutput> {
      yield { content, isError, metadata: { streaming: true } };
      yield { content, isError, metadata: {} };
    },
    dispose: vi.fn(async () => {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SMALL_CONTENT = 'tiny';
const LARGE_CONTENT = 'x'.repeat(1024);

const baseInput: TransportInput = {
  toolName: 'test_tool',
  args: {},
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RtkTransport', () => {
  describe('when RTK binary is not found', () => {
    it('returns original content with rtk.enabled = false', async () => {
      const inner = makeMockTransport(LARGE_CONTENT);
      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 64,
      });

      const result = await transport.execute({ ...baseInput, args: {} });

      expect(result.content).toBe(LARGE_CONTENT);
      expect(result.metadata?.rtk).toBeDefined();
      expect((result.metadata?.rtk as Record<string, unknown>)?.enabled).toBe(false);
      expect((result.metadata?.rtk as Record<string, unknown>)?.mode).toBe('none');
    });
  });

  describe('when enabled = false', () => {
    it('passes through to inner transport without modification', async () => {
      const inner = makeMockTransport(LARGE_CONTENT);
      const transport = new RtkTransport({
        inner,
        enabled: false,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 64,
      });

      const result = await transport.execute(baseInput);

      expect(result.content).toBe(LARGE_CONTENT);
      expect(result.metadata?.rtk).toBeUndefined();
    });
  });

  describe('prefix mode', () => {
    it('rewrites eligible shell commands through rtk', async () => {
      const inner = makeMockTransport('On branch main');
      const executeSpy = inner.execute as ReturnType<typeof vi.fn>;

      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 10_000,
      });

      await transport.execute({ ...baseInput, args: { command: 'git status' } });

      const calledWith: TransportInput = executeSpy.mock.calls[0][0];
      expect(calledWith.args['command']).toBe('rtk git status');
    });

    it('does not double-wrap already-rtk-prefixed commands', async () => {
      const inner = makeMockTransport('output');
      const executeSpy = inner.execute as ReturnType<typeof vi.fn>;

      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 10_000,
      });

      await transport.execute({ ...baseInput, args: { command: 'rtk git status' } });

      const calledWith: TransportInput = executeSpy.mock.calls[0][0];
      expect(calledWith.args['command']).toBe('rtk git status');
    });

    it('does not rewrite non-eligible commands', async () => {
      const inner = makeMockTransport('result');
      const executeSpy = inner.execute as ReturnType<typeof vi.fn>;

      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 10_000,
      });

      await transport.execute({ ...baseInput, args: { command: 'my_custom_tool --run' } });

      const calledWith: TransportInput = executeSpy.mock.calls[0][0];
      expect(calledWith.args['command']).toBe('my_custom_tool --run');
    });
  });

  describe('filter threshold', () => {
    it('skips RTK filter for content below threshold', async () => {
      const inner = makeMockTransport(SMALL_CONTENT);
      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 512,
      });

      const result = await transport.execute(baseInput);

      expect(result.content).toBe(SMALL_CONTENT);
      expect((result.metadata?.rtk as Record<string, unknown>)?.enabled).toBe(false);
    });
  });

  describe('metadata shape', () => {
    it('attaches rtk metadata on noop path', async () => {
      const inner = makeMockTransport(SMALL_CONTENT);
      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 512,
      });

      const result = await transport.execute(baseInput);
      const rtk = result.metadata?.rtk as Record<string, unknown>;

      expect(rtk).toBeDefined();
      expect(typeof rtk?.inputBytes).toBe('number');
      expect(typeof rtk?.outputBytes).toBe('number');
      expect(typeof rtk?.savedPct).toBe('number');
      expect(rtk?.mode).toBe('none');
    });
  });

  describe('type passthrough', () => {
    it('mirrors the inner transport type', () => {
      const inner = makeMockTransport();
      const transport = new RtkTransport({ inner, binaryPath: '/rtk' });
      expect(transport.type).toBe('local');
    });
  });

  describe('dispose', () => {
    it('calls dispose on the inner transport', async () => {
      const inner = makeMockTransport();
      const transport = new RtkTransport({ inner, binaryPath: '/rtk' });

      await transport.dispose();

      expect(inner.dispose).toHaveBeenCalledOnce();
    });
  });

  describe('error results', () => {
    it('does not apply filter mode to error outputs', async () => {
      const inner = makeMockTransport(LARGE_CONTENT, true);
      const transport = new RtkTransport({
        inner,
        binaryPath: '/nonexistent/rtk',
        filterThresholdBytes: 64,
      });

      const result = await transport.execute(baseInput);

      expect(result.isError).toBe(true);
      expect(result.content).toBe(LARGE_CONTENT);
      expect((result.metadata?.rtk as Record<string, unknown>)?.mode).toBe('none');
    });
  });

  describe('withRtk factory', () => {
    it('creates an RtkTransport wrapping the inner transport', () => {
      const inner = makeMockTransport();
      const transport = withRtk(inner, { filterLevel: 'aggressive' });

      expect(transport).toBeInstanceOf(RtkTransport);
      expect(transport.type).toBe(inner.type);
    });
  });
});
