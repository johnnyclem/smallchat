import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { MCPTransport, registerLocalHandler, unregisterLocalHandler, clearTransports } from './transport.js';
import { createFixtureServer, fixtureEvents } from './__fixtures__/upstream-server.mjs';

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

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP against an SDK server (SC-SURF-13)
// ---------------------------------------------------------------------------

describe('MCPTransport against an SDK Streamable HTTP server (SC-SURF-13)', () => {
  const servers: HttpServer[] = [];
  const transports: MCPTransport[] = [];
  afterEach(async () => {
    for (const t of transports.splice(0)) await t.close();
    for (const s of servers.splice(0)) {
      s.closeAllConnections();
      await new Promise<void>(r => s.close(() => r()));
    }
  });

  async function sdkServer(): Promise<string> {
    const sessions = new Map<string, StreamableHTTPServerTransport>();
    const server = createServer(async (req, res) => {
      const sid = req.headers['mcp-session-id'] as string | undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => { sessions.set(id, transport!); },
        });
        await createFixtureServer('mcp-transport-fixture').connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    servers.push(server);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  it('initializes a session and runs the tool', async () => {
    const transport = new MCPTransport({ transportType: 'mcp', endpoint: await sdkServer() });
    transports.push(transport);
    const result = await transport.execute('echo', { text: 'over http' });
    expect(result.metadata?.error).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'over http' }]);
    // A second call reuses the session.
    const sum = await transport.execute('add', { a: 2, b: 3 });
    expect(sum.isError).toBe(false);
  });

  it('times out a hung call and cancels it upstream', async () => {
    const transport = new MCPTransport({ transportType: 'mcp', endpoint: await sdkServer(), timeoutMs: 300 });
    transports.push(transport);
    const before = fixtureEvents.length;
    const started = Date.now();
    const result = await transport.execute('sleep', { ms: 10_000 });
    expect(result.isError).toBe(true);
    expect(String(result.metadata?.error)).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect.poll(() => fixtureEvents.slice(before)).toContain('sleep:cancelled');
  });
});
