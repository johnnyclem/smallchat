import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MCPTransport, registerLocalHandler, unregisterLocalHandler, clearTransports } from './transport.js';

describe('MCPTransport', () => {
  afterEach(() => {
    clearTransports();
  });

  describe('local transport', () => {
    it('executes a registered local handler', async () => {
      registerLocalHandler('echo', async (args) => ({
        content: { echoed: args },
        isError: false,
      }));

      const transport = new MCPTransport({ transportType: 'local' });
      const result = await transport.execute('echo', { message: 'hello' });

      expect(result.isError).toBe(false);
      expect(result.content).toEqual({ echoed: { message: 'hello' } });

      unregisterLocalHandler('echo');
    });

    it('returns error for unregistered local handler', async () => {
      const transport = new MCPTransport({ transportType: 'local' });
      const result = await transport.execute('unknown_tool', {});

      expect(result.isError).toBe(true);
      expect(result.metadata?.error).toContain('No local handler registered');
    });

    it('handles local handler errors gracefully', async () => {
      registerLocalHandler('failing', async () => {
        throw new Error('Handler failed');
      });

      const transport = new MCPTransport({ transportType: 'local' });
      const result = await transport.execute('failing', {});

      expect(result.isError).toBe(true);
      expect(result.metadata?.error).toContain('Handler failed');

      unregisterLocalHandler('failing');
    });
  });

  describe('MCP transport without endpoint', () => {
    it('returns error when no endpoint is configured', async () => {
      const transport = new MCPTransport({ transportType: 'mcp' });
      const result = await transport.execute('some_tool', {});

      expect(result.isError).toBe(true);
      expect(result.metadata?.error).toContain('No MCP endpoint configured');
    });
  });

  describe('REST transport without endpoint', () => {
    it('returns error when no endpoint is configured', async () => {
      const transport = new MCPTransport({ transportType: 'rest' });
      const result = await transport.execute('some_tool', {});

      expect(result.isError).toBe(true);
      expect(result.metadata?.error).toContain('No REST endpoint configured');
    });
  });

  describe('gRPC transport', () => {
    it('returns not-yet-implemented error', async () => {
      const transport = new MCPTransport({ transportType: 'grpc' });
      const result = await transport.execute('some_tool', {});

      expect(result.isError).toBe(true);
      expect(result.metadata?.error).toContain('gRPC transport not yet implemented');
    });
  });

  describe('streaming', () => {
    it('falls back to single-shot for local transport', async () => {
      registerLocalHandler('echo', async (args) => ({
        content: args,
        isError: false,
      }));

      const transport = new MCPTransport({ transportType: 'local' });
      const chunks: unknown[] = [];

      for await (const chunk of transport.executeStream('echo', { data: 'test' })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual({ content: { data: 'test' }, isError: false });

      unregisterLocalHandler('echo');
    });

    it('yields error for stream without endpoint', async () => {
      const transport = new MCPTransport({ transportType: 'mcp' });
      const chunks: unknown[] = [];

      for await (const chunk of transport.executeStream('tool', {})) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect((chunks[0] as { isError: boolean }).isError).toBe(true);
    });
  });
});
