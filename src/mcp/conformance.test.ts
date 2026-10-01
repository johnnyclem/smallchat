/**
 * Feature: the conformance checks behind `doctor --mcp` fail servers that
 * are not conformant (SC-SURF-22: the old check passed in both branches).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runConformance } from './conformance.js';
import { runMcpDoctor } from '../cli/commands/doctor.js';

const servers: HttpServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** An SDK server with no guards whose tools/call "succeeds" for any name. */
function permissiveServer(): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  return listen(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { transports.set(id, transport!); },
      });
      const server = new Server({ name: 'permissive', version: '0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'anything', inputSchema: { type: 'object' } }] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'ok!' }] }));
      await server.connect(transport);
    }
    await transport.handleRequest(req, res);
  });
}

describe('runConformance', () => {
  it('fails a server that reports success for an unknown tool and accepts foreign Origins', async () => {
    const url = await permissiveServer();
    const checks = await runConformance({ kind: 'http', url }, { timeoutMs: 3000 });
    const failed = checks.filter(c => !c.pass).map(c => c.name);
    expect(checks.find(c => c.name === 'initialize')?.pass).toBe(true);
    expect(failed).toContain('unknown tool is refused');
    expect(failed).toContain('foreign Origin is refused');
    expect(failed).toContain('foreign Host is refused');
  });

  it('fails a server that never answers, within the step timeout', async () => {
    const url = await listen(() => { /* never responds */ });
    const started = Date.now();
    const checks = await runConformance({ kind: 'http', url }, { timeoutMs: 300 });
    expect(checks.find(c => c.name === 'initialize')).toMatchObject({ pass: false });
    expect(checks.every(c => c.name === 'missing bearer token is refused' || !c.pass)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('is what doctor --mcp prints and exits on', async () => {
    const url = await permissiveServer();
    const lines: string[] = [];
    const ok = await runMcpDoctor({ kind: 'http', url }, { timeoutMs: 3000 }, line => lines.push(line));
    expect(ok).toBe(false);
    expect(lines.join('\n')).toMatch(/unknown tool is refused\s+FAIL/);
    expect(lines.at(-1)).toMatch(/MCP conformance: \d+\/\d+ checks passed/);
  });
});
