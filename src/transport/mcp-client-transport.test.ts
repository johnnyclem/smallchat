/**
 * Outbound MCP client transports against real SDK servers (SC-SURF-13, SC-SURF-15).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpStdioTransport, McpSseTransport, McpHttpTransport } from './mcp-client-transport.js';
import { BearerTokenAuth } from './auth.js';
import type { ITransport } from './types.js';
import { createFixtureServer, fixtureEvents } from '../mcp/__fixtures__/upstream-server.mjs';

const QUIRKY = fileURLToPath(new URL('../mcp/__fixtures__/quirky-server.mjs', import.meta.url));

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!();
});

function track<T extends ITransport>(transport: T): T {
  cleanup.push(() => transport.dispose?.());
  return transport;
}

/** The fixture tools over Streamable HTTP, served by the official SDK. */
async function sdkHttpServer(): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const server: HttpServer = createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { transports.set(id, transport!); },
      });
      await createFixtureServer('http-fixture').connect(transport);
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

function textOf(content: unknown): string {
  return (content as Array<{ type: string; text?: string }>).map(c => c.text ?? '').join('');
}

describe('McpSseTransport speaks MCP to a spec server (SC-SURF-13)', () => {
  it('initializes, sends the required Accept header and calls the tool', async () => {
    const url = await sdkHttpServer();
    const transport = track(new McpSseTransport({ url }));
    const result = await transport.execute({ toolName: 'echo', args: { text: 'hello' } });
    expect(result.metadata?.error).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(textOf(result.content)).toBe('hello');
  });

  it('honours timeoutMs and cancels the upstream request', async () => {
    const url = await sdkHttpServer();
    const transport = track(new McpSseTransport({ url }));
    const before = fixtureEvents.length;
    const started = Date.now();
    const result = await transport.execute({ toolName: 'sleep', args: { ms: 10_000 }, timeoutMs: 300 });
    expect(result.isError).toBe(true);
    expect(String(result.metadata?.error)).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect.poll(() => fixtureEvents.slice(before)).toContain('sleep:cancelled');
  });
});

describe('McpStdioTransport (SC-SURF-15)', () => {
  it('does not deadlock on a server that writes megabytes to stderr', async () => {
    const transport = track(new McpStdioTransport({
      command: process.execPath,
      args: [QUIRKY],
      env: { FIXTURE_STDERR_BYTES: String(2_400_000) },
      initTimeoutMs: 8_000,
    }));
    const result = await transport.execute({ toolName: 't1', args: {} });
    expect(result.metadata?.error).toBeUndefined();
    expect(textOf(result.content)).toBe('ran t1');
  }, 20_000);

  it('does not cache a failed start: the next call starts the server again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc6-stdio-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const transport = track(new McpStdioTransport({
      command: process.execPath,
      args: [QUIRKY],
      env: { FIXTURE_FAIL_ONCE_FILE: join(dir, 'marker') },
      initTimeoutMs: 5_000,
      restartBackoffMs: 0,
    }));

    const first = await transport.execute({ toolName: 't1', args: {} });
    expect(first.isError).toBe(true);
    expect(String(first.metadata?.error)).toMatch(/failing the first start on purpose|exited|closed/i);

    const second = await transport.execute({ toolName: 't1', args: {} });
    expect(second.metadata?.error).toBeUndefined();
    expect(textOf(second.content)).toBe('ran t1');
  }, 20_000);

  it('sends notifications/cancelled when a call times out', async () => {
    const transport = track(new McpStdioTransport({ command: process.execPath, args: [QUIRKY] }));
    const result = await transport.execute({ toolName: 'sleep', args: { ms: 10_000 }, timeoutMs: 300 });
    expect(result.isError).toBe(true);
    expect(String(result.metadata?.error)).toMatch(/timed out/i);
    await expect.poll(() => transport.stderrTail(), { timeout: 5_000 }).toContain('sleep:cancelled');
    // The transport is still usable after the timeout.
    const next = await transport.execute({ toolName: 't2', args: {} });
    expect(textOf(next.content)).toBe('ran t2');
  }, 20_000);

  it('lists every page of tools/list', async () => {
    const transport = track(new McpStdioTransport({
      command: process.execPath,
      args: [QUIRKY],
      env: { FIXTURE_PAGE_SIZE: '2', FIXTURE_TOOL_COUNT: '5' },
    }));
    const { tools } = await transport.listTools();
    expect(tools.map(t => t.name)).toEqual(['t1', 't2', 't3', 't4', 't5', 'sleep']);
  }, 20_000);

  it('stops the server process on dispose', async () => {
    const transport = new McpStdioTransport({ command: process.execPath, args: [QUIRKY] });
    await transport.execute({ toolName: 't1', args: {} });
    const pid = transport.pid;
    expect(pid).toBeGreaterThan(0);
    await transport.dispose();
    expect(() => process.kill(pid!, 0)).toThrow();
  }, 20_000);
});

describe('McpHttpTransport', () => {
  it('applies its auth strategy to every request', async () => {
    const inner = await sdkHttpServer();
    // A proxy in front of the SDK server that requires the bearer token.
    const guarded = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer s3cret-token') {
        res.writeHead(401).end();
        return;
      }
      const upstream = new URL(inner);
      const proxied = httpRequest({ host: upstream.hostname, port: upstream.port, path: upstream.pathname, method: req.method, headers: req.headers }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      req.pipe(proxied);
    });
    await new Promise<void>(r => guarded.listen(0, '127.0.0.1', r));
    cleanup.push(async () => {
      guarded.closeAllConnections();
      await new Promise<void>(r => guarded.close(() => r()));
    });
    const url = `http://127.0.0.1:${(guarded.address() as AddressInfo).port}/mcp`;

    const denied = track(new McpHttpTransport({ url, transport: 'streamable-http', restartBackoffMs: 0 }));
    expect((await denied.execute({ toolName: 'echo', args: { text: 'x' } })).isError).toBe(true);

    const transport = track(new McpHttpTransport({ url, auth: new BearerTokenAuth({ token: 's3cret-token' }) }));
    const result = await transport.execute({ toolName: 'echo', args: { text: 'authorized' } });
    expect(result.metadata?.error).toBeUndefined();
    expect(textOf(result.content)).toBe('authorized');
    expect(transport.type).toBe('mcp-http');
  });
});
