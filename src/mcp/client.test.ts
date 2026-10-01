/**
 * MCP config introspection (SC-SURF-14): remote entries, pagination,
 * ${VAR} expansion, and one bad entry never aborting the scan.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { introspectMcpConfigFile, introspectMcpServer } from './client.js';
import { createFixtureServer } from './__fixtures__/upstream-server.mjs';

const QUIRKY = fileURLToPath(new URL('./__fixtures__/quirky-server.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./__fixtures__/upstream-server.mjs', import.meta.url));

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanup.length > 0) await cleanup.pop()!();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sc6-introspect-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeConfig(mcpServers: Record<string, unknown>): string {
  const path = join(tmp(), '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers }));
  return path;
}

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The upstream fixture over Streamable HTTP (official SDK). */
async function streamableServer(): Promise<string> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const base = await listen(createServer(async (req, res) => {
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => { transports.set(id, transport!); },
      });
      await createFixtureServer('remote').connect(transport);
    }
    await transport.handleRequest(req, res);
  }));
  return `${base}/mcp`;
}

/** The upstream fixture over the legacy HTTP+SSE transport only. */
async function legacySseServer(): Promise<string> {
  const sessions = new Map<string, SSEServerTransport>();
  const base = await listen(createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      sessions.set(transport.sessionId, transport);
      await createFixtureServer('legacy').connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const transport = sessions.get(url.searchParams.get('sessionId') ?? '');
      if (transport) return transport.handlePostMessage(req, res);
    }
    res.writeHead(404).end();
  }));
  return `${base}/sse`;
}

const quiet = { log: (l: string) => { if (process.env.SC6_DEBUG) console.log(l); } };

describe('introspectMcpConfigFile', () => {
  it('introspects remote (type http) entries next to stdio ones and records their URL', async () => {
    const url = await streamableServer();
    const config = writeConfig({
      remote: { type: 'http', url },
      local: { command: process.execPath, args: [QUIRKY] },
    });
    const manifests = await introspectMcpConfigFile(config, quiet);
    const byId = Object.fromEntries(manifests.map(m => [m.id, m]));
    expect(Object.keys(byId).sort()).toEqual(['local', 'remote']);
    expect(byId.remote.launch).toEqual({ transport: 'streamable-http', url });
    expect(byId.remote.tools.map(t => t.name)).toContain('echo');
    expect(byId.local.tools.map(t => t.name)).toContain('t1');
  }, 30_000);

  it('falls back to legacy SSE for a bare url and records the transport that worked', async () => {
    const url = await legacySseServer();
    const manifests = await introspectMcpConfigFile(writeConfig({ legacy: { url } }), quiet);
    expect(manifests).toHaveLength(1);
    expect(manifests[0].launch).toEqual({ transport: 'sse', url });
    expect(manifests[0].tools.map(t => t.name)).toContain('echo');
  }, 30_000);

  it('skips bad entries with a message instead of failing the whole scan', async () => {
    const lines: string[] = [];
    const config = writeConfig({
      unreachable: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
      shapeless: { foo: 'bar' },
      websocket: { type: 'ws', url: 'ws://127.0.0.1:9' },
      missingVar: { command: process.execPath, args: ['${SC6_DEFINITELY_UNSET_VAR}'] },
      good: { command: process.execPath, args: [QUIRKY] },
    });
    const manifests = await introspectMcpConfigFile(config, { log: line => lines.push(line), timeoutMs: 5_000 });
    expect(manifests.map(m => m.id)).toEqual(['good']);
    const output = lines.join('\n');
    expect(output).toMatch(/unreachable/);
    expect(output).toMatch(/shapeless.*(command|url)/);
    expect(output).toMatch(/websocket.*ws/);
    expect(output).toMatch(/missingVar.*SC6_DEFINITELY_UNSET_VAR/);
  }, 30_000);

  it('reads every page of tools/list', async () => {
    const config = writeConfig({
      paged: { command: process.execPath, args: [QUIRKY], env: { FIXTURE_PAGE_SIZE: '2', FIXTURE_TOOL_COUNT: '5' } },
    });
    const [manifest] = await introspectMcpConfigFile(config, quiet);
    expect(manifest.tools.map(t => t.name)).toEqual(['t1', 't2', 't3', 't4', 't5', 'sleep']);
  }, 30_000);

  it('expands ${VAR} and ${VAR:-default} like Claude Code, but records only the templates', async () => {
    const config = writeConfig({
      templated: {
        command: '${SC6_NODE}',
        args: ['${SC6_FIXTURE_DIR}/quirky-server.mjs'],
        env: { FIXTURE_TOOL_COUNT: '${SC6_COUNT:-2}' },
      },
    });
    const env = { SC6_NODE: process.execPath, SC6_FIXTURE_DIR: join(QUIRKY, '..') };
    const [manifest] = await introspectMcpConfigFile(config, { ...quiet, env });
    expect(manifest.tools.map(t => t.name)).toEqual(['t1', 't2', 'sleep']);
    expect(manifest.launch).toEqual({
      transport: 'stdio',
      command: '${SC6_NODE}',
      args: ['${SC6_FIXTURE_DIR}/quirky-server.mjs'],
      env: ['FIXTURE_TOOL_COUNT'],
    });
  }, 30_000);
});

describe('introspectMcpServer', () => {
  it('reports a spawn failure as an error result, never a throw', async () => {
    const result = await introspectMcpServer('missing', { command: '/definitely/not/a/binary' }, { timeoutMs: 5_000 });
    expect(result.tools).toEqual([]);
    expect(result.error).toMatch(/ENOENT|not\/a\/binary/);
  });

  it('includes the server stderr tail when the server exits early', async () => {
    const result = await introspectMcpServer('noisy-exit', {
      command: process.execPath,
      args: ['-e', 'process.stderr.write("boom: missing API key\\n"); process.exit(3)'],
    }, { timeoutMs: 5_000 });
    expect(result.error).toMatch(/boom: missing API key/);
  });

  it('introspects the plain fixture over stdio', async () => {
    const result = await introspectMcpServer('fixture', { command: process.execPath, args: [FIXTURE] }, { timeoutMs: 10_000 });
    expect(result.error).toBeUndefined();
    expect(result.tools.map(t => t.name)).toContain('echo');
  });
});
